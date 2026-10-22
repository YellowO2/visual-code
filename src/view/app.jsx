import ELK from 'elkjs/lib/elk.bundled.js'
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BaseEdge, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { handedParts } from '../handed.js'
import { ModelPanel } from './model.jsx'

const elk = new ELK()
const Toggle = createContext()
const Users = createContext(new Set())
const OpenModel = createContext(() => {})
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
  }
  const fold = (key) => setFolded((now) => new Set(now.has(key) ? [...now].filter((k) => k !== key) : [...now, key]))
  return (
    <Page tree={tree} opened={opened} folded={folded} fold={fold} toggle={toggle} />
  )
}

function Page({ tree, opened, folded, fold, toggle }) {
  const [hovered, setHovered] = useState()
  const [model, setModel] = useState()
  const users = useMemo(() => new Set(hovered ? files(tree).filter((node) => node.uses?.includes(hovered)).map((node) => node.path) : []),
    [tree, hovered])
  const offered = useMemo(() => new Set(files(tree).filter((file) => file.path.split('/').length === 2 && file.name === '__init__.py')
    .flatMap((file) => file.uses ?? [])), [tree])
  return (
    <>
      <Warnings list={tree.warnings} folded={folded} fold={fold} />
      <main>
        <OpenModel.Provider value={setModel}>
        <ReactFlowProvider>
          <Diagram tree={tree} opened={opened} toggle={toggle} hovered={hovered} hover={setHovered} users={users} />
        </ReactFlowProvider>
        </OpenModel.Provider>
        {model && <ModelPanel path={model} close={() => setModel()} />}
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
function Diagram({ tree, opened, toggle, hovered, hover, users }) {
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
        // Calls cross machines, from a caller to an endpoint, so they sit at the top.
        const called = calls(tree, opened)
        const ctx = { opened, tree, direction, endpoints: endpointsOf(called) }
        return { children: outermost(tree).map((machine) => elkMachine(machine, ctx)), edges: called }
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
  // The view stays where it is as machines open and close; only a new
  // direction (a new page or window size) shows the whole diagram.
  useEffect(() => {
    if (!laid.nodes.length || !laid.refit) return
    const timer = setTimeout(() => fitView({ duration: MOVE_MS, padding: 0.1 }), MOVE_MS)
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
  const { opened, tree } = ctx
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
      // A part with a model has a button beside its name, so its box is that much wider.
      if (!child.wires) return [{ id: child.path, kind: 'part', label: child.name, ...size(child.model ? `${child.name} model ` : child.name) }]
      // A closed machine keeps its ports, so wires to it land where they will when it opens.
      const label = `${child.name} ▸`
      return [{ id: child.path, kind: 'machine', label, ...size(label), ports: portsOf(child, ctx),
        layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE', 'elk.nodeSize.constraints': 'PORTS MINIMUM_SIZE',
          'elk.nodeSize.minimum': `(${size(label).width}, ${size(label).height})` } }]
    })
  }
  // At least as wide as its description, which the room above its parts was sized for.
  const box = { id: machine.path, kind: 'frame', edges: [], ports: portsOf(machine, ctx),
    layoutOptions: { 'elk.padding': padding(headingLines(machine)), 'elk.portConstraints': 'FIXED_SIDE',
      'elk.nodeSize.constraints': 'MINIMUM_SIZE', 'elk.nodeSize.minimum': `(${ABOUT_WIDTH + 2 * PAD}, 0)` } }
  fill(machine, box)
  // A part handed in and run here is a box of its own, dashed; its call goes out to the part.
  for (const end of drawn) {
    if (!end.startsWith(`${machine.path}#use:`)) continue
    const label = `${end.split(':').pop()} (handed in)`
    box.children.push({ id: end, kind: 'used', label, ...size(label) })
  }
  const holder = (ends) => {
    const owners = ends.map((end) => end.split('#')[0])
    return [...boxes.keys()].sort((a, b) => b.length - a.length).find((path) => owners.every((owner) =>
      owner === machine.path ? path === machine.path : path === '.' || (owner.startsWith(path) && owner !== path)))
  }
  const edge = (source, target, label, uses) => boxes.get(holder([source, target])).edges.push({
    id: `${source}>${target}`, sources: [source], targets: [target], uses, labels: label ? [{ text: label, ...size(label, 10) }] : [] })
  for (const { from, to, names, kind } of machine.wires) {
    // Handing a part over is how the caller gets hold of it; what shows is the call (see calls).
    if (kind === 'uses') continue
    // Each value goes to its own port, where the ends have one; values sharing
    // both ends share one line.
    const lines = new Map()
    for (const name of names) {
      const ends = [entry(portOf(from, 'out', [name], tree), ctx), entry(portOf(to, 'in', [name], tree), ctx)]
      lines.set(ends.join('>'), [...(lines.get(ends.join('>')) ?? []), name])
    }
    // A port already names what passes through it; an endpoint does not.
    const wall = (end) => /#(in|out):/.test(end)
    for (const [ends, carried] of lines) {
      const [source, target] = ends.split('>')
      edge(source, target, wall(source) || wall(target) ? '' : carried.join(', '))
    }
  }
  return box
}

// A machine's ports, open or closed: where values enter and leave, and the
// endpoints others call.
function portsOf(machine, { direction, endpoints, tree }) {
  const sides = SIDES[direction]
  const port = (id, label, side) => ({ id, label, ...size(label, 10), layoutOptions: { 'elk.port.side': side } })
  // A machine called at its own function takes its inputs with the call: they
  // enter by that one endpoint, not ports of their own.
  const walls = [...drawnBy(machine)].filter((end) => /#(in|out):/.test(end) && end.startsWith(`${machine.path}#`)
    && !(end.includes('#in:') && entered(machine, endpoints, tree)))
  return [
    ...walls.map((end) => port(end, end.split(':').pop(), sides[end.includes('#in:') ? 'in' : 'out'])),
    ...[...(endpoints.get(machine.path) ?? [])].map((name) => port(`${machine.path}#call:${name}`, signature(machine, name), sides.in)),
  ]
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
          : { label: node.label, about: find(tree, node.id)?.about, model: find(tree, node.id)?.model },
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
        className: edge.call ? 'call' : edge.uses ? 'uses' : undefined,
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
  const openModel = useContext(OpenModel)
  return (
    <div className={`box nopan${touchesDisk(data.label) ? ' disk' : ''}${users.has(id) ? ' user' : ''}`}>
      <Ends />
      {data.label}
      {data.model && (
        <button className="model-open" title="Show the model inside" onClick={(event) => { event.stopPropagation(); openModel(id) }}>
          model
        </button>
      )}
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


// A project's calls: each part handed in and run inside a machine calls the
// endpoint of the part it really is. A call starts at the box it shows on (the
// outermost closed machine holding it) and ends at a fixed point on the
// called machine's wall, so opening and closing never move its end.
function calls(tree, opened) {
  const machines = []
  const collect = (node) => { if (node.wires) machines.push(node); node.children?.forEach(collect) }
  collect(tree)
  const top = new Set(outermost(tree).map((machine) => machine.path))
  const shown = (end) => machines.filter((m) => !top.has(m.path) && !opened.has(m.path) && end.startsWith(m.path) && end !== m.path)
    .sort((a, b) => a.path.length - b.path.length)[0]?.path ?? end
  const found = new Map()
  const call = (from, part, endpoint) => {
    const source = shown(from)
    // A machine is called at an endpoint on its wall; a plain part, at its box;
    // either, inside a closed machine, at that machine's box.
    const target = shown(part) !== part ? shown(part) : find(tree, part)?.wires ? `${part}#call:${endpoint}` : part
    // Both ends inside one closed machine: the call is inside it, out of sight.
    if (source === target.split('#')[0] || source === target) return
    // The endpoint names what the call takes.
    found.set(`${source}>${target}`, { id: `${source}>${target}`, sources: [source], targets: [target], call: true, part,
      endpoint: target === part ? undefined : endpoint, labels: [{ text: 'calls', ...size('calls', 10) }] })
  }
  // A part handed in and run inside a machine calls the part it really is.
  const handed = handedParts(machinesIn(tree))
  for (const [end, { part, endpoint }] of handed) call(end, part, endpoint)
  // Whoever is handed a part calls it, unless what it does with it is shown
  // already by a call from deeper in.
  const reached = new Set([...handed.values()].map(({ part, endpoint }) => `${part}>${endpoint}`))
  for (const machine of machines) {
    for (const wire of machine.wires) {
      if (wire.kind !== 'uses') continue
      for (const name of wire.names) {
        const endpoint = wire.handed?.[name] ?? name
        if (!reached.has(`${wire.from}>${endpoint}`)) call(wire.to, wire.from, endpoint)
      }
    }
  }
  return [...found.values()]
}

// The endpoints each machine is called at.
function endpointsOf(called) {
  const endpoints = new Map()
  for (const { part, endpoint } of called) if (endpoint) endpoints.set(part, new Set([...(endpoints.get(part) ?? []), endpoint]))
  return endpoints
}

function machinesIn(node) {
  return [...(node.wires ? [node] : []), ...(node.children ?? []).flatMap(machinesIn)]
}

// The machines nothing wires: where the diagram starts.
function outermost(node) {
  return node.wires ? [node] : (node.children ?? []).flatMap(outermost)
}

// A machine starts with its own machines open, one level deep.
function ownMachines(machine) {
  return machine.children.flatMap(onShelf).filter((part) => part.wires).map((part) => part.path)
}

// What a machine draws: every end of its wires, and every part it calls.
function drawnBy(machine) {
  return new Set([...machine.wires.flatMap(({ from, to }) => [from, to]), ...machine.calls])
}

// A wire that reaches an open machine goes on to the port of the same name on its wall.
// An endpoint as the function it is: its name and what it takes.
function signature(machine, name) {
  const run = machinesIn(machine).map((m) => m.children.find((child) => child.path === m.main)?.functions?.[0])
    .find((f) => f?.name === name)
  return `${name}(${run ? run.ports.slice(0, run.inputs).join(', ') : ''})`
}

// Whether a machine is called at its own function, its main.py's.
function entered(machine, endpoints, tree) {
  const own = find(tree, machine.main)?.functions?.[0]?.name
  return Boolean(own && endpoints.get(machine.path)?.has(own))
}

// An input of a machine called at its own function is that function's endpoint.
function entry(end, { endpoints, tree }) {
  if (!end.includes('#in:')) return end
  const machine = find(tree, end.split('#')[0])
  return entered(machine, endpoints, tree) ? `${machine.path}#call:${find(tree, machine.main).functions[0].name}` : end
}

// A wire that reaches a machine goes on to the port of the same name on its wall.
function portOf(end, kind, names, tree) {
  const port = `${end}#${kind}:${names[0]}`
  const machine = find(tree, end)
  return machine?.wires && drawnBy(machine).has(port) ? port : end
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
