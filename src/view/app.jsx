import ELK from 'elkjs/lib/elk.bundled.js'
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BaseEdge, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

const elk = new ELK()
const Toggle = createContext()
const Users = createContext(new Set())
// Which walls values enter and leave by, for each way the diagram can flow.
const SIDES = { DOWN: { in: 'NORTH', out: 'SOUTH' }, RIGHT: { in: 'WEST', out: 'EAST' } }
const SETTLE_MS = 200
const CHARACTER = 7.2
const LINE = 16
const PAD = 16
const ABOUT_WIDTH = 260
const MOVE_MS = 300
const PORT_LAYER = 1000
const TOAST_MS = 1500
const LAYOUT = {
  'elk.algorithm': 'layered',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.json.edgeCoords': 'ROOT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '40',
  'elk.spacing.nodeNode': '24',
  'elk.spacing.edgeEdge': '10',
  'elk.spacing.edgeNode': '14',
  'elk.spacing.portPort': '8',
  'elk.edgeLabels.inline': 'true',
}

// The project as the server reads it: folders, files and how main files wire them.
function App() {
  const [tree, setTree] = useState()
  const [opened, setOpened] = useState()
  const [folded, setFolded] = useState(new Set())
  const [focus, setFocus] = useState()
  useEffect(() => {
    const source = new EventSource('/events')
    source.addEventListener('reload', () => location.reload())
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
    const lay = (direction) => elk.layout({ id: 'root', layoutOptions: { ...LAYOUT, 'elk.direction': direction },
      ...(() => {
        // Wires from a job to the very part it was handed cross machines, so they sit at the top.
        const handed = handedParts(tree)
        const ctx = { opened, tree, direction, handed }
        return { children: outermost(tree).map((machine) => elkMachine(machine, ctx)), edges: handedWires(tree, handed, opened) }
      })() })
    const fit = ({ width, height }) => Math.min(screen.width / width, screen.height / height)
    const choosing = !flow.current || flow.current.screen !== screen
    const directions = choosing ? Object.keys(SIDES) : [flow.current.direction]
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
  const edges = laid.edges.map((edge) => ({ ...edge,
    className: [edge.className, (touches(edge.source) || touches(edge.target)) && 'active'].filter(Boolean).join(' ') }))
  // The boxes stay the same objects while the pointer moves: React Flow hides a
  // box it thinks is new until it has measured it, so remaking them flashes.
  // Each box reads who uses what is hovered for itself.
  return (
    <Toggle.Provider value={toggle}>
    <Users.Provider value={users}>
    <div ref={box} className="flow">
    <ReactFlow nodes={laid.nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} minZoom={0.1} maxZoom={2}
      nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => node.type === 'machine' ? toggle(node.id) : ['part', 'port'].includes(node.type) && copy(node.id.split('#')[0])}
      onNodeMouseEnter={(_, node) => hover(node.id)}
      onNodeMouseLeave={() => hover()} />
    </div>
    </Users.Provider>
    </Toggle.Provider>
  )
}

// A machine as ELK sees it: its parts, inside the shelves they sit on, its open
// machines laid out inside it, its ports on its walls, and one edge per wire,
// kept in the innermost box holding both its ends. A part handed to another is
// drawn from the one that uses it to the one it uses.
function elkMachine(machine, ctx) {
  const { opened, tree, direction, handed } = ctx
  const drawn = drawnBy(machine)
  const boxes = new Map()
  const fill = (folder, into) => {
    boxes.set(folder.path, into)
    into.children = folder.children.flatMap((child) => {
      if (child.children && !child.main) {
        if (!child.children.flatMap(onShelf).some((part) => drawn.has(part.path))) return []
        const shelf = { id: child.path, kind: 'shelf', label: child.name, layoutOptions: { 'elk.padding': padding(1) }, edges: [] }
        fill(child, shelf)
        return [shelf]
      }
      if (!drawn.has(child.path)) return []
      if (child.wires && opened.has(child.path)) return [elkMachine(child, ctx)]
      const label = child.wires ? `${child.name} ▸` : child.name
      return [{ id: child.path, kind: child.wires ? 'machine' : 'part', label, ...size(label) }]
    })
  }
  // At least as wide as its description, which the room above its parts was sized for.
  const box = { id: machine.path, kind: 'frame', edges: [], layoutOptions: { 'elk.padding': padding(headingLines(machine)),
    'elk.nodeSize.constraints': 'MINIMUM_SIZE', 'elk.nodeSize.minimum': `(${ABOUT_WIDTH + 2 * PAD}, 0)` } }
  fill(machine, box)
  const own = [...drawn].filter((end) => end.startsWith(`${machine.path}#`))
  const walls = own.filter((end) => !end.includes('#use:'))
  const name = (end) => end.split(':').pop()
  // A part handed in and run here is the very part it is, when that is on the
  // page; otherwise a dashed box of its own.
  const real = (end) => handed.get(end)
  for (const end of own.filter((end) => end.includes('#use:') && !real(end))) {
    box.children.push({ id: end, kind: 'used', label: `${name(end)} (handed in)`, ...size(`${name(end)} (handed in)`) })
  }
  box.ports = walls.map((end) => ({ id: end, label: name(end), ...size(name(end), 10),
    layoutOptions: { 'elk.port.side': SIDES[direction][end.includes('#in:') ? 'in' : 'out'] } }))
  box.layoutOptions['elk.portConstraints'] = 'FIXED_SIDE'
  const holder = (ends) => {
    const owners = ends.map((end) => end.split('#')[0])
    return [...boxes.keys()].sort((a, b) => b.length - a.length).find((path) => owners.every((owner) =>
      owner === machine.path ? path === machine.path : path === '.' || (owner.startsWith(path) && owner !== path)))
  }
  const edge = (source, target, label, uses) => boxes.get(holder([source, target])).edges.push({
    id: `${source}>${target}`, sources: [source], targets: [target], uses, labels: label ? [{ text: label, ...size(label, 10) }] : [] })
  // An end that is a part handed in becomes that part, at the port of the value's name.
  const resolve = (end, kind, names) => (real(end) ? portOf(real(end), kind, names, opened, tree) : portOf(end, kind, names, opened, tree))
  for (const { from, to, names, kind } of machine.wires) {
    if (kind !== 'uses') {
      const source = resolve(from, 'out', names)
      const target = resolve(to, 'in', names)
      // Wires to a part handed in run to that part itself: see handedWires.
      if (real(from) || real(to)) continue
      // A port already names what passes through it.
      const wall = (end) => /#(in|out):/.test(end)
      edge(source, target, wall(source) || wall(target) ? '' : names.join(', '))
      continue
    }
    // A part handed in is used by the one it is handed to: the line runs from
    // the user to the part, named by what the user calls it.
    edge(to, from, `uses: ${names.join(', ')}`, true)
  }
  return box
}

// ELK's result as React Flow nodes, each placed in its parent, and edges along
// ELK's routes.
function flatten(root, tree) {
  const nodes = []
  const edges = []
  const visit = (node, parentId) => {
    if (node !== root) {
      const folder = node.kind === 'frame' && find(tree, node.id)
      nodes.push({
        id: node.id, parentId, type: node.kind, position: { x: node.x, y: node.y }, ...sized(node),
        data: folder ? { id: node.id, label: `${folder.name} ▾`, about: folder.about, machine: true }
          : { label: node.label, about: find(tree, node.id)?.about },
      })
    }
    for (const port of node.ports ?? []) {
      // A port's name sits over the wires that start or end at it.
      nodes.push({ id: port.id, parentId: node.id, type: 'port', position: { x: port.x, y: port.y }, ...sized(port),
        zIndex: PORT_LAYER, data: { label: port.label } })
    }
    for (const child of node.children ?? []) visit(child, node === root ? undefined : node.id)
    for (const edge of node.edges ?? []) {
      const points = (edge.sections ?? []).flatMap(({ startPoint, bendPoints = [], endPoint }) => [startPoint, ...bendPoints, endPoint])
      edges.push({ id: edge.id, source: edge.sources[0], target: edge.targets[0], type: 'routed',
        className: edge.uses ? 'uses' : undefined,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 }, data: { points, label: edge.labels?.[0] } })
    }
  }
  visit(root)
  return { nodes, edges }
}

// A box's size, given up front: React Flow hides a box until it knows how big
// it is, so a box it had to measure would blink whenever the layout changes.
function sized({ width, height }) {
  return { width, height, measured: { width, height }, style: { width, height } }
}

function Part({ id, data }) {
  const users = useContext(Users)
  return (
    <div className={`box nopan${touchesDisk(data.label) ? ' disk' : ''}${users.has(id) ? ' user' : ''}`}>
      <Ends />
      {data.label}
      {data.about && <span className="about">{data.about}</span>}
    </div>
  )
}

function Used({ data }) {
  return (
    <div className="box used nopan">
      <Ends />
      {data.label}
    </div>
  )
}

function Machine({ id, data }) {
  const users = useContext(Users)
  return (
    <div className={`box machine nopan${users.has(id) ? ' user' : ''}`}>
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

const NODE_TYPES = { part: Part, machine: Machine, frame: Frame, shelf: Shelf, port: Port, used: Used }
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

// Which part each handed-in part really is, followed up through the main
// files: a job is handed to a switch, the switch is given the part by a
// name, and that name came in through its machine's wall from further up.
function handedParts(tree) {
  const machines = []
  const collect = (node) => { if (node.wires) machines.push(node); node.children?.forEach(collect) }
  collect(tree)
  const parentOf = (path) => machines.filter((m) => path !== m.path && (m.path === '.' || path.startsWith(m.path)))
    .sort((a, b) => b.path.length - a.path.length)[0]
  const arrivedAt = (machine, name) => {
    const parent = parentOf(machine.path)
    if (!parent) return undefined
    const wire = parent.wires.find((w) => w.to === machine.path && w.names.includes(name))
    if (!wire) return undefined
    if (wire.kind === 'uses') return wire.from
    return wire.from === `${parent.path}#in:${name}` ? arrivedAt(parent, name) : undefined
  }
  const found = new Map()
  for (const job of machines) {
    for (const end of drawnBy(job)) {
      if (!end.startsWith(`${job.path}#use:`)) continue
      const name = end.split(':').pop()
      const parent = parentOf(job.path)
      const switchWire = parent?.wires.find((w) => w.kind === 'uses' && w.from === job.path)
      const given = switchWire && parent.wires.find((w) => w.to === switchWire.to && w.names.includes(name))
      const part = !given ? undefined : given.kind === 'uses' ? given.from
        : given.from === `${parent.path}#in:${name}` ? arrivedAt(parent, name) : undefined
      if (part) found.set(end, part)
    }
  }
  return found
}

// The wires between a job and the very part it was handed, drawn whether or
// not the job is open: an end inside a closed machine shows on that machine's
// box, as any wire does. They cross machines, so they sit at the top.
function handedWires(tree, handed, opened) {
  const machines = []
  const collect = (node) => { if (node.wires) machines.push(node); node.children?.forEach(collect) }
  collect(tree)
  const top = new Set(outermost(tree).map((machine) => machine.path))
  // The box an end shows on: the outermost closed machine holding it, or the end itself.
  const shown = (end) => {
    const owner = end.split('#')[0]
    const closed = machines.filter((m) => !top.has(m.path) && !opened.has(m.path) && owner.startsWith(m.path)
      && (owner !== m.path || end.includes('#')))
      .sort((a, b) => a.path.length - b.path.length)[0]
    return closed ? closed.path : end
  }
  const wires = new Map()
  for (const job of machines) {
    for (const { from, to, names, kind } of job.wires) {
      if (kind === 'uses') continue
      const into = handed.get(to)
      const outOf = handed.get(from)
      if (!into && !outOf) continue
      const source = outOf ? portOf(outOf, 'out', names, opened, tree) : shown(from)
      const target = into ? portOf(into, 'in', names, opened, tree) : shown(to)
      if (source === target) continue
      const id = `${source}>${target}`
      const wire = wires.get(id) ?? { id, sources: [source], targets: [target], names: [] }
      wire.names.push(...names.filter((name) => !wire.names.includes(name)))
      wires.set(id, wire)
    }
  }
  return [...wires.values()].map(({ names, ...wire }) => ({ ...wire, labels: [{ text: names.join(', '), ...size(names.join(', '), 10) }] }))
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

// What a machine draws: every end of its wires, and every part it calls.
function drawnBy(machine) {
  return new Set([...machine.wires.flatMap(({ from, to }) => [from, to]), ...machine.calls])
}

// A wire that reaches an open machine goes on to the port of the same name on its wall.
function portOf(end, kind, names, opened, tree) {
  const port = `${end}#${kind}:${names[0]}`
  return opened.has(end) && drawnBy(find(tree, end)).has(port) ? port : end
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

// A folder without a main file is a shelf: what is on it belongs to the machine around it.
function onShelf(node) {
  return node.children && !node.main ? node.children.flatMap(onShelf) : [node]
}

// Loaders and savers, where the system meets the disk, by their names.
function touchesDisk(name) {
  return /^(load|save)|(Loader|Saver)$/i.test(name.replace(/\.[^.]+$/, ''))
}

function size(text, fontSize = 12) {
  return { width: text.length * CHARACTER * (fontSize / 12) + 2 * PAD, height: LINE + (fontSize === 12 ? 16 : 6) }
}

// A machine's heading says what it does, so the box leaves room above its parts.
function headingLines(folder) {
  return 1 + Math.ceil(((folder.about ?? '').length * CHARACTER * (11 / 12)) / ABOUT_WIDTH)
}

function padding(lines) {
  return `[top=${lines * LINE + PAD},left=${PAD},bottom=${PAD},right=${PAD}]`
}

function find(node, path) {
  if (node.path === path) return node
  for (const child of node.children ?? []) {
    const found = find(child, path)
    if (found) return found
  }
}

function files(node) {
  return node.children ? node.children.flatMap(files) : [node]
}

createRoot(document.querySelector('#app')).render(<App />)
