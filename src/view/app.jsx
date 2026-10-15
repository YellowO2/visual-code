import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BaseEdge, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { drawnBy, find, layout, onShelf } from './layout.js'

const Toggle = createContext()
const SETTLE_MS = 200
const DIRECTIONS = ['RIGHT', 'DOWN']
const MOVE_MS = 300
const TOAST_MS = 1500

// The project as the server reads it: folders, files and how main files wire them.
function App() {
  const [tree, setTree] = useState()
  const [opened, setOpened] = useState()
  const [folded, setFolded] = useState(new Set())
  const [focus, setFocus] = useState()
  useEffect(() => {
    const source = new EventSource('/events')
    source.onmessage = ({ data }) => {
      const next = JSON.parse(data)
      setTree(next)
      setOpened((now) => now ?? new Set(outermost(next).flatMap(ownMachines)))
    }
    return () => source.close()
  }, [])
  if (!tree || !opened) return null
  const toggle = (path) => {
    const next = new Set(opened)
    next.has(path) ? next.delete(path) : next.add(path)
    setOpened(next)
    setFocus(next.has(path) ? path : parentMachine(tree, path) ?? null)
  }
  const fold = (key) => setFolded((now) => new Set(now.has(key) ? [...now].filter((k) => k !== key) : [...now, key]))
  return (
    <Page tree={tree} opened={opened} folded={folded} fold={fold} toggle={toggle} focus={focus} />
  )
}

function Page({ tree, opened, folded, fold, toggle, focus }) {
  const [hovered, setHovered] = useState()
  const users = useMemo(() => new Set(hovered ? files(tree).filter((node) => node.uses?.includes(hovered)).map((node) => node.path) : []),
    [tree, hovered])
  const offered = useMemo(() => new Set(files(tree).filter((file) => file.path.split('/').length === 2 && file.name === '__init__.py')
    .flatMap((file) => file.uses ?? [])), [tree])
  return (
    <>
      <Warnings list={tree.warnings} folded={folded} fold={fold} />
      <main>
        <ReactFlowProvider>
          <Diagram tree={tree} opened={opened} toggle={toggle} focus={focus} hovered={hovered} hover={setHovered} users={users} />
        </ReactFlowProvider>
      </main>
      <footer>
        {outermost(tree).flatMap((machine) => ['tools', 'types', 'offered', 'unwired'].map((kind) => (
          <Strip key={machine.path + kind} machine={machine} kind={kind} opened={opened} offered={offered}
            folded={folded} fold={fold} hover={setHovered} users={users} />
        )))}
      </footer>
      <Toast />
    </>
  )
}

// The diagram flows the way that shows it biggest on this screen: down, or
// right. It is chosen when the page opens and when the window changes size,
// not when a machine opens, so the diagram never turns under the cursor.
function Diagram({ tree, opened, toggle, focus, hovered, hover, users }) {
  const [laid, setLaid] = useState({ nodes: [], edges: [] })
  const [screen, setScreen] = useState()
  const flow = useRef()
  const box = useRef()
  const { fitView } = useReactFlow()
  // Only the window changing size counts: the strips below the diagram grow as
  // machines open, and that must not turn the diagram.
  useEffect(() => {
    let settling
    const measure = () => {
      const { width, height } = box.current.getBoundingClientRect()
      setScreen({ width, height })
    }
    const resized = () => {
      clearTimeout(settling)
      settling = setTimeout(measure, SETTLE_MS)
    }
    measure()
    window.addEventListener('resize', resized)
    return () => window.removeEventListener('resize', resized)
  }, [])
  useEffect(() => {
    if (!screen) return
    let current = true
    const aspect = screen.width / screen.height
    const lay = (direction) => layout(outermost(tree), { opened, tree, direction, aspect })
    const extent = (boxes) => ({ width: Math.max(...boxes.map((b) => b.x + b.width)), height: Math.max(...boxes.map((b) => b.y + b.height)) })
    const fit = (boxes) => Math.min(screen.width / extent(boxes).width, screen.height / extent(boxes).height)
    const choosing = !flow.current || flow.current.screen !== screen
    const directions = choosing ? DIRECTIONS : [flow.current.direction]
    Promise.all(directions.map(lay)).then((results) => {
      if (!current) return
      const best = results.reduce((a, b) => (fit(b) > fit(a) ? b : a))
      if (choosing) flow.current = { screen, direction: directions[results.indexOf(best)] }
      setLaid({ ...flatten(best, tree), refit: choosing })
    }, (failure) => console.error('layout failed', failure))
    return () => { current = false }
  }, [tree, opened, screen])
  // The view follows what was opened or closed, once its boxes have moved; a
  // new direction shows the whole diagram.
  useEffect(() => {
    if (!laid.nodes.length || (focus === undefined && !laid.refit)) return
    // A machine is shown with the ports on its walls.
    const nodes = !laid.refit && focus ? laid.nodes.filter(({ id }) => id === focus || id.startsWith(`${focus}#`)) : undefined
    const timer = setTimeout(() => fitView({ nodes, duration: MOVE_MS, padding: 0.1 }), MOVE_MS)
    return () => clearTimeout(timer)
  }, [laid])
  const touches = (end) => hovered && (end === hovered || end.startsWith(`${hovered}#`))
  const nodes = laid.nodes.map((node) => ({ ...node, className: users.has(node.id) ? 'user' : '' }))
  const edges = laid.edges.map((edge) => ({ ...edge, className: touches(edge.source) || touches(edge.target) ? 'active' : '' }))
  return (
    <Toggle.Provider value={toggle}>
    <div ref={box} className="flow">
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} minZoom={0.1} maxZoom={2}
      nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => node.type === 'machine' ? toggle(node.id) : ['part', 'port'].includes(node.type) && copy(node.id.split('#')[0])}
      onNodeMouseEnter={(_, node) => hover(node.id)}
      onNodeMouseLeave={() => hover()} />
    </div>
    </Toggle.Provider>
  )
}

// The laid-out machines as React Flow nodes, each placed in its parent, and
// wires along their routes, on the page.
function flatten(boxes, tree) {
  const nodes = []
  const edges = []
  const visit = (box, parentId, origin) => {
    nodes.push({ id: box.id, parentId, type: 'frame', position: { x: box.x, y: box.y }, style: { width: box.width, height: box.height },
      data: { id: box.id, label: `${box.label} ▾`, about: box.about, machine: true } })
    const at = { x: origin.x + box.x, y: origin.y + box.y }
    for (const shelf of box.shelves) {
      nodes.push({ id: shelf.id, parentId: box.id, type: 'shelf', zIndex: -1, position: { x: shelf.x, y: shelf.y },
        style: { width: shelf.width, height: shelf.height }, data: { label: shelf.label } })
    }
    for (const node of box.nodes) {
      if (node.box) visit({ ...node.box, x: node.x, y: node.y }, box.id, at)
      else nodes.push({ id: node.id, parentId: box.id, type: node.kind, position: { x: node.x, y: node.y },
        style: { width: node.width, height: node.height }, data: { label: node.label, about: find(tree, node.id)?.about } })
    }
    const shift = ({ x, y }) => ({ x: x + at.x, y: y + at.y })
    for (const edge of box.edges) {
      edges.push({ id: edge.id, source: edge.source, target: edge.target, type: 'routed',
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        data: { points: edge.points.map(shift), label: edge.label && { ...edge.label, ...shift(edge.label) } } })
    }
  }
  for (const box of boxes) visit(box, undefined, { x: 0, y: 0 })
  return { nodes, edges }
}

function Part({ data }) {
  return (
    <div className={`box nopan${touchesDisk(data.label) ? ' disk' : ''}`}>
      <Ends />
      {data.label}
      {data.about && <span className="about">{data.about}</span>}
    </div>
  )
}

function Machine({ data }) {
  return (
    <div className="box machine nopan">
      <Ends />
      {data.label}
      {data.about && <span className="about">{data.about}</span>}
    </div>
  )
}

// An open machine closes from its heading; the rest of its box pans the view.
function Frame({ data }) {
  const toggle = useContext(Toggle)
  return (
    <div className={`frame${data.machine ? '' : ' shelf'}`}>
      <Ends />
      <div className={data.machine ? 'heading nopan' : 'heading'} onClick={() => data.machine && toggle(data.id)}>
        <b>{data.label}</b>
        {data.about && <small>{data.about}</small>}
      </div>
    </div>
  )
}

function Port({ data }) {
  return (
    <div className="port nopan">
      <Ends />
      {data.label}
    </div>
  )
}

function Shelf({ data }) {
  return <Frame data={data} />
}

// Every box can be an edge's end; the edge itself follows ELK's route.
function Ends() {
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
    </>
  )
}

function Routed({ data, markerEnd }) {
  const path = data.points.map(({ x, y }, i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ')
  const { label } = data
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} />
      {label && (
        <text className="wire-label" x={label.x + label.width / 2} y={label.y + label.height / 2} dominantBaseline="middle"
          textAnchor="middle">{label.text}</text>
      )}
    </>
  )
}

const NODE_TYPES = { part: Part, machine: Machine, frame: Frame, shelf: Shelf, port: Port }
const EDGE_TYPES = { routed: Routed }

function Warnings({ list, folded, fold }) {
  if (!list.length) return null
  const open = folded.has('#warnings')
  return (
    <aside>
      <button className="summary" onClick={() => fold('#warnings')}>
        {`${list.length} warning${list.length === 1 ? '' : 's'} ${open ? '▾' : '▸'}`}
      </button>
      {open && list.map(({ path, line, message }) => {
        const where = line ? `${path}:${line}` : path
        return <button key={where + message} onClick={() => copy(where)}><b>{where}</b> {message}</button>
      })}
    </aside>
  )
}

// What a machine and its open machines do not wire up, of one kind, grouped by
// folder; a tools folder with all inside it. A folder of several files starts
// folded, with a count.
function Strip({ machine, kind, opened, offered, folded, fold, hover, users }) {
  const parts = loose(machine, opened).filter((part) => kindOf(part, offered) === kind)
  if (!parts.length) return null
  const folderOf = (part) => {
    const shelf = shelfOf(part, machine)
    return kind === 'tools' ? shelf.slice(0, shelf.lastIndexOf('tools/') + 'tools/'.length) : shelf
  }
  const chip = (file, shelf) => (
    <button key={file.path} title={file.about ?? ''} className={users.has(file.path) ? 'user' : ''} onClick={() => copy(file.path)}
      onMouseEnter={() => hover(file.path)} onMouseLeave={() => hover()}>
      {shelf && <span className="shelf">{shelf}</span>}{file.name}
    </button>
  )
  return (
    <div className={`strip ${kind}`}>
      {[...Map.groupBy(parts, folderOf)].flatMap(([folder, group]) => {
        if (group.length === 1) return [chip(group[0], shelfOf(group[0], machine))]
        const inside = (file) => chip(file, shelfOf(file, machine).slice(folder.length))
        if (!folder) return group.map(inside)
        const key = `${kind}:${machine.path}${folder}`
        const open = folded.has(key)
        return [
          <button key={key} className="group" onClick={() => fold(key)}>{`${folder} ${open ? '▾' : `${group.length} ▸`}`}</button>,
          ...(open ? group.map(inside) : []),
        ]
      })}
    </div>
  )
}

let showToast
function Toast() {
  const [text, setText] = useState('')
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    let hiding
    showToast = (next) => {
      setText(next)
      setVisible(true)
      clearTimeout(hiding)
      hiding = setTimeout(() => setVisible(false), TOAST_MS)
    }
  }, [])
  return <output className={visible ? 'visible' : ''}>{text}</output>
}

async function copy(path) {
  await navigator.clipboard.writeText(path)
  showToast?.(`Copied ${path}`)
}

// The machines nothing wires: where the diagram starts.
function outermost(node) {
  return node.wires ? [node] : (node.children ?? []).flatMap(outermost)
}

// A machine starts with its own machines open, one level deep.
function ownMachines(machine) {
  return machine.children.flatMap(onShelf).filter((part) => part.wires).map((part) => part.path)
}

function parentMachine(tree, path) {
  const holders = (node) => node.wires && path.startsWith(node.path) && node.path !== path
    ? [node, ...(node.children ?? []).flatMap(holders)] : (node.children ?? []).flatMap(holders)
  return holders(tree).at(-1)?.path
}



// What a machine and the machines open inside it do not wire up. Tests,
// scripts, private folders and files in another language are not parts.
function loose(machine, opened) {
  const drawn = drawnBy(machine)
  const language = machine.main.slice(machine.main.lastIndexOf('.'))
  const part = (node) => !/(^|\/)(tests|scripts|_[^/]*)\/|(^|\/)test_[^/]*$/.test(node.path)
    && (node.children || node.name.endsWith(language)) && node.name !== `__init__${language}`
    && node.path !== machine.main
  return machine.children.flatMap(onShelf).filter(part).flatMap((node) => {
    if (node.wires && drawn.has(node.path)) return opened.has(node.path) ? loose(node, opened) : []
    return drawn.has(node.path) ? [] : [node]
  })
}

// What a file is to its machine when no wire reaches it: a tool, what a package
// offers its callers, a type (its one offering is a class), or none of these.
function kindOf(part, offered) {
  if (part.path.split('/').includes('tools')) return 'tools'
  if (offered.has(part.main ?? part.path)) return 'offered'
  if (part.defines?.length === 1 && part.defines[0].kind === 'class') return 'types'
  return 'unwired'
}

function shelfOf(part, machine) {
  const inside = part.path.slice(machine.path === '.' ? 0 : machine.path.length)
  return inside.slice(0, inside.lastIndexOf(part.name))
}


// Loaders and savers, where the system meets the disk, by their names.
function touchesDisk(name) {
  return /^(load|save)|(Loader|Saver)$/i.test(name.replace(/\.[^.]+$/, ''))
}





function files(node) {
  return node.children ? node.children.flatMap(files) : [node]
}

createRoot(document.querySelector('#app')).render(<App />)
