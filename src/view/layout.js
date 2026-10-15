// Where every box and wire goes. ELK lays out one machine at a time, flat,
// from the innermost out, so each machine knows the size of the machines
// inside it. A machine's line of steps longer than the screen allows snakes:
// it is cut into rows, every other row runs back the other way, and the wires
// between rows turn at the ends, like the lines of a page read as a U.
import ELK from 'elkjs/lib/elk.bundled.js'

const elk = new ELK()
const CHARACTER = 7.2
const LINE = 16
const PAD = 16
const ABOUT_WIDTH = 260
const ROW_GAP = 56
const TURN = 28
const MIN_COLUMNS = 3
const CLEARLY = 1.5
const FLAT = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': '40',
  'elk.spacing.nodeNode': '24',
  'elk.spacing.edgeEdge': '10',
  'elk.spacing.edgeNode': '14',
  'elk.spacing.portPort': '8',
  'elk.edgeLabels.inline': 'true',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
}

// The project's outermost machines, laid out to flow `direction` (RIGHT or
// DOWN) and to suit a screen of the given shape. Returns each machine as a box
// holding its boxes, shelves and wires, in page coordinates.
export async function layout(machines, { opened, tree, direction, aspect }) {
  const ctx = { opened, tree, down: direction === 'DOWN', aspect }
  const laid = []
  let y = 0
  for (const machine of machines) {
    const box = await layMachine(machine, ctx, true)
    laid.push({ ...box, x: 0, y })
    y += box.height + ROW_GAP
  }
  return laid
}

// One machine: its content laid flat along the flow (x, for now), snaked to the
// screen's shape, then turned to the page's direction and framed.
async function layMachine(machine, ctx, outermost = false) {
  const drawn = drawnBy(machine)
  const shelves = []
  const inner = new Map()
  const children = []
  const fill = async (folder, shelf) => {
    for (const child of folder.children) {
      if (child.children && !child.main) {
        if (!child.children.flatMap(onShelf).some((part) => drawn.has(part.path))) continue
        const members = []
        shelves.push({ id: child.path, label: child.name, members })
        await fill(child, members)
        shelf?.push(...members)
        continue
      }
      if (!drawn.has(child.path)) continue
      shelf?.push(child.path)
      if (child.wires && ctx.opened.has(child.path)) {
        const box = await layMachine(child, ctx)
        inner.set(child.path, box)
        const { width, height } = flowSize(box, ctx)
        children.push({ id: child.path, width, height, layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
          ports: box.walls.map((wall) => ({ id: wall.id, width: 2, height: 2, ...flowPoint(wall, ctx) })) })
      } else {
        const label = child.wires ? `${child.name} ▸` : child.name
        children.push({ id: child.path, kind: child.wires ? 'machine' : 'part', label, ...flowSize(size(label), ctx) })
      }
    }
  }
  await fill(machine)
  // Where values enter and leave: the first and last steps of the line.
  const walls = [...drawn].filter((end) => end.startsWith(`${machine.path}#`))
  for (const end of walls) {
    const label = end.split(':').pop()
    children.push({ id: end, kind: 'port', label, ...flowSize(size(label, 10), ctx),
      layoutOptions: { 'elk.layered.layering.layerConstraint': end.includes('#in:') ? 'FIRST' : 'LAST' } })
  }
  const edges = machine.wires.map(({ from, to, names }) => {
    const source = portOf(from, 'out', names, ctx)
    const target = portOf(to, 'in', names, ctx)
    // A port already names what passes through it.
    const label = source.includes('#') || target.includes('#') ? '' : names.join(', ')
    return { id: `${source}>${target}`, sources: [source], targets: [target],
      labels: label ? [{ text: label, ...flowSize(size(label, 10), ctx) }] : [] }
  })
  const result = await elk.layout({ id: machine.path, layoutOptions: FLAT, children, edges })
  const flat = {
    nodes: result.children.map(({ id, x, y, width, height, kind, label }) => ({ id, x, y, width, height, kind, label })),
    edges: result.edges.map((edge) => ({
      id: edge.id, source: edge.sources[0], target: edge.targets[0],
      points: (edge.sections ?? []).flatMap(({ startPoint, bendPoints = [], endPoint }) => [startPoint, ...bendPoints, endPoint]),
      label: edge.labels?.[0] && { ...edge.labels[0] },
    })),
  }
  const snaked = snake(flat, outermost || ctx.aspect ? ctx.aspect : 0, ctx)
  // Each open machine inside a row that runs back is turned to run back too.
  for (const node of snaked.nodes) {
    const box = inner.get(node.id)
    if (box) Object.assign(node, { kind: 'frame', box: node.reversed ? mirrored(box, ctx) : box })
  }
  return framed(machine, snaked, shelves, walls, ctx)
}

// Cuts a flat line into rows that best match the screen's shape; every other
// row runs back. Wires within a row move with it; wires between rows are
// routed round the ends of the rows.
function snake({ nodes, edges }, aspect, ctx) {
  const columns = layers(nodes)
  const width = Math.max(...nodes.map((n) => n.x + n.width), 0)
  const height = Math.max(...nodes.map((n) => n.y + n.height), 0)
  // The page's shape, seen along the flow.
  const target = ctx.down ? 1 / aspect : aspect
  // Each row is as tall as its own boxes.
  const plan = (rows) => {
    const cut = cuts(columns, rows, width)
    const rowOf = (x) => cut.findIndex(([a, b]) => x >= a - 1 && x <= b + 1)
    const spans = cut.map((_, row) => {
      const members = nodes.filter((n) => rowOf(n.x + n.width / 2) === row)
      return [Math.min(...members.map((n) => n.y)), Math.max(...members.map((n) => n.y + n.height))]
    })
    const tops = spans.reduce((all, [a, b], row) => [...all, row ? all.at(-1) + (spans[row - 1][1] - spans[row - 1][0]) + ROW_GAP : 0], [])
    const w = Math.max(...cut.map(([a, b]) => b - a))
    const h = tops.at(-1) + spans.at(-1)[1] - spans.at(-1)[0]
    return { rows, cut, rowOf, spans, tops, w, h }
  }
  let best = { rows: 1, misfit: Infinity }
  // A line folds only when it is clearly too long: each row keeps a few steps,
  // and the fold must bring the shape well closer to the screen's.
  for (let rows = 1; rows * MIN_COLUMNS <= columns.length || rows === 1; rows++) {
    const candidate = plan(rows)
    const misfit = Math.abs(Math.log((candidate.w + (rows > 1 ? 2 * TURN : 0)) / candidate.h / target))
    if (rows === 1 || misfit < best.misfit - Math.log(CLEARLY)) best = { ...candidate, misfit }
  }
  if (best.rows === 1) return { nodes, edges, width, height }
  const { cut, rowOf, spans, tops, w, h } = best
  const top = (row) => tops[row]
  const move = (row) => ({ x, y }) => {
    const local = x - cut[row][0]
    return { x: TURN + (row % 2 ? w - local : local), y: tops[row] + y - spans[row][0] }
  }
  const placed = nodes.map((node) => {
    const row = rowOf(node.x + node.width / 2)
    const corner = move(row)({ x: node.x, y: node.y })
    return { ...node, row, reversed: row % 2 === 1, x: row % 2 ? corner.x - node.width : corner.x, y: corner.y }
  })
  const rowById = new Map(placed.map((node) => [node.id, node.row]))
  const owner = (end) => rowById.get(end) ?? rowById.get(end.split('#')[0]) ?? rowById.get(ownerOf(end, placed))
  const routed = edges.map((edge) => {
    const [from, to] = [owner(edge.source), owner(edge.target)]
    const start = move(from)(edge.points[0])
    const end = move(to)(edge.points.at(-1))
    if (from === to) {
      const label = edge.label && { ...edge.label, ...centred(move(from), edge.label) }
      return { ...edge, points: edge.points.map(move(from)), label }
    }
    // A row running forward ends on the right; one running back, on the left.
    const side = (row) => (row % 2 ? 0 : 2 * TURN + w)
    const gap = top(to) - ROW_GAP / 2
    const points = [start, { x: side(from), y: start.y }, { x: side(from), y: gap }, { x: side(to), y: gap },
      { x: side(to), y: end.y }, end]
    // The name goes where the wire leaves its row, inside the box.
    const label = edge.label && { ...edge.label, x: from % 2 ? start.x - edge.label.width - 4 : start.x + 4, y: start.y - edge.label.height - 2 }
    return { ...edge, points, label }
  })
  return { nodes: placed, edges: routed, width: w + 2 * TURN, height: h }
}

// The columns of a line: boxes side by side along the flow.
function layers(nodes) {
  const spans = nodes.map((n) => [n.x, n.x + n.width]).sort((a, b) => a[0] - b[0])
  const merged = []
  for (const [a, b] of spans) {
    if (merged.length && a <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], b)
    else merged.push([a, b])
  }
  return merged
}

// Splits the columns into `rows` runs of about equal length.
function cuts(columns, rows, width) {
  const runs = []
  let start = 0
  for (let row = 0; row < rows && start < columns.length; row++) {
    const goal = (width * (row + 1)) / rows
    let end = start
    while (end + 1 < columns.length && (row === rows - 1 || columns[end + 1][1] <= goal)) end++
    runs.push([columns[start][0], columns[end][1]])
    start = end + 1
  }
  return runs
}

function centred(move, { x, y, width, height }) {
  const centre = move({ x: x + width / 2, y })
  return { x: centre.x - width / 2, y: centre.y }
}

// The flow's box, turned to the page and framed: the heading on top, the parts
// below, each shelf's frame round its parts, and the ports where values cross
// the walls.
function framed(machine, { nodes, edges, width, height }, shelves, walls, ctx) {
  const turn = ctx.down ? swap : (v) => v
  // A shelf's name sits above its parts, so it needs a line more.
  const headingHeight = headingLines(machine) * LINE + PAD + (shelves.length ? LINE : 0)
  const at = (p) => {
    const t = turn(p)
    return { x: t.x + PAD, y: t.y + headingHeight }
  }
  const boxes = nodes.map((node) => {
    const corner = at({ x: node.x, y: node.y })
    const { width: w, height: h } = turn({ width: node.width, height: node.height })
    return { ...node, ...corner, width: w, height: h }
  })
  const lines = edges.map((edge) => ({
    ...edge,
    points: edge.points.map(at),
    label: edge.label && { ...edge.label, ...at({ x: edge.label.x, y: edge.label.y }), ...turn({ width: edge.label.width, height: edge.label.height }) },
  }))
  const size = turn({ width, height })
  const box = {
    id: machine.path, label: machine.name, about: machine.about,
    width: size.width + 2 * PAD, height: size.height + headingHeight + PAD,
    nodes: boxes, edges: lines,
  }
  // A shelf whose parts fall in different rows gets a frame in each, named once.
  box.shelves = shelves.flatMap(({ id, label, members }) => {
    const byRow = Map.groupBy(boxes.filter((b) => members.includes(b.id)), (b) => b.row ?? 0)
    return [...byRow.values()].map((group, i) => frameAround(i ? `${id}#${i}` : id, i ? '' : label, group))
  })
  // Each port sits on the wall nearest its box.
  box.walls = walls.map((id) => {
    const { x, y, width: w, height: h } = boxes.find((b) => b.id === id)
    const centre = { x: x + w / 2, y: y + h / 2 }
    if (ctx.down) return { id, x: centre.x, y: centre.y < box.height / 2 ? 0 : box.height }
    return { id, x: centre.x < box.width / 2 ? 0 : box.width, y: centre.y }
  })
  return box
}

function frameAround(id, label, members) {
  const left = Math.min(...members.map((m) => m.x)) - PAD / 2
  const top = Math.min(...members.map((m) => m.y)) - LINE - PAD / 2
  const right = Math.max(...members.map((m) => m.x + m.width)) + PAD / 2
  const bottom = Math.max(...members.map((m) => m.y + m.height)) + PAD / 2
  return { id, label, x: left, y: top, width: right - left, height: bottom - top }
}

// A machine run backwards along the flow: every position mirrored, all the way down.
function mirrored(box, ctx) {
  const flip = ctx.down ? ({ x, y }) => ({ x, y: box.height - y }) : ({ x, y }) => ({ x: box.width - x, y })
  const flipBox = (b) => {
    const { x, y } = flip(ctx.down ? { x: b.x, y: b.y + b.height } : { x: b.x + b.width, y: b.y })
    return { ...b, x, y }
  }
  return {
    ...box,
    nodes: box.nodes.map((node) => ({ ...flipBox(node), box: node.box && mirrored(node.box, ctx) })),
    shelves: box.shelves.map(flipBox),
    edges: box.edges.map((edge) => ({ ...edge, points: edge.points.map(flip), label: edge.label && flipBox(edge.label) })),
    walls: box.walls.map((wall) => ({ ...wall, ...flip(wall) })),
  }
}

// Sizes and points in flow space, where the flow always runs along x.
function flowSize(sized, ctx) {
  return ctx.down ? { ...sized, width: sized.height, height: sized.width } : sized
}

function flowPoint(point, ctx) {
  return ctx.down ? { x: point.y, y: point.x } : { x: point.x, y: point.y }
}

function swap(v) {
  const out = { ...v }
  if ('x' in v) Object.assign(out, { x: v.y, y: v.x })
  if ('width' in v) Object.assign(out, { width: v.height, height: v.width })
  return out
}

function ownerOf(end, nodes) {
  return nodes.find((node) => end.startsWith(node.id))?.id
}

// A wire that reaches an open machine goes on to the port of the same name on its wall.
function portOf(end, kind, names, { opened, tree }) {
  const port = `${end}#${kind}:${names[0]}`
  return opened.has(end) && drawnBy(find(tree, end)).has(port) ? port : end
}

// What a machine draws: every end of its wires, and every part it calls.
export function drawnBy(machine) {
  return new Set([...machine.wires.flatMap(({ from, to }) => [from, to]), ...machine.calls])
}

export function onShelf(node) {
  return node.children && !node.main ? node.children.flatMap(onShelf) : [node]
}

export function find(node, path) {
  if (node.path === path) return node
  for (const child of node.children ?? []) {
    const found = find(child, path)
    if (found) return found
  }
}

function size(text, fontSize = 12) {
  return { width: text.length * CHARACTER * (fontSize / 12) + 2 * PAD, height: LINE + (fontSize === 12 ? 16 : 6) }
}

// A machine's heading says what it does, so the box leaves room above its parts.
function headingLines(folder) {
  return 1 + Math.ceil(((folder.about ?? '').length * CHARACTER * (11 / 12)) / ABOUT_WIDTH)
}
