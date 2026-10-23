import { useState } from 'react'
import { createPortal } from 'react-dom'

// A model part opened in the diagram: its blocks drawn the way papers draw
// networks, with what each block is on hover. The blocks come from the
// server, which runs the file's _example() once in Python (model_view.py).
const W = 104
const H = 74
const GAP = 26
const STEP = 34
const NICK = { Linear: 'FC', Embedding: 'Emb', TransformerBlock: 'Transformer', LayerNorm: 'LN', PointEncoder: 'Conv enc' }

// Where every block and line goes, and how big the drawing is: the diagram
// sizes the part's box from this before laying it out.
// Blocks used before the main one (attention or recurrent) are its inputs:
// grouped by kind and stacked, joining at a ⊕. The rest follow it, a repeated
// pattern of them in a frame marked with its times; a last run of several
// output layers fans out.
export function layoutNetwork(model) {
  const blocks = model.blocks.filter((b) => b.used)
  let main = blocks.findIndex((b) => model.main.includes(b.kind))
  if (main < 0) main = blocks.length
  const before = byKind(blocks.slice(0, main))
  const after = blocks.slice(main)
  const heads = after.length > 1 && after.at(-1).kind === 'Linear' && after.at(-1).count > 1 ? after.pop() : undefined
  const columnHeight = Math.max(before.length, 1) * (H + GAP) - GAP
  const pad = after.some((b) => b.times) ? 36 : 0
  const height = Math.max(columnHeight, heads ? heads.count * (H + 14) : 0, H + pad) + 24
  const middle = (height - 24) / 2 - H / 2
  const placed = []
  const lines = []
  let x = 0
  const top = (height - 24 - columnHeight) / 2
  before.forEach((b, i) => placed.push({ b, x, y: top + i * (H + GAP) }))
  if (before.length) {
    const join = x + W + 52
    for (const { y } of placed) lines.push({ d: `M${x + W - 8} ${y + H / 2} C${join - 20} ${y + H / 2} ${join - 20} ${middle + H / 2} ${join - 11} ${middle + H / 2}` })
    placed.push({ join: true, x: join, y: middle + H / 2 })
    x = join + 30
  }
  for (const [i, b] of after.entries()) {
    if (i) lines.push({ d: `M${x - STEP + 6} ${middle + H / 2} H${x + 8}`, arrow: true })
    else if (before.length) lines.push({ d: `M${x - 19} ${middle + H / 2} H${x + 8}`, arrow: true })
    placed.push({ b, x: x + 10, y: middle })
    if (b.times && after[i - 1]?.cycle !== b.cycle) placed.push({ frame: true, times: b.times, x: x + 2, y: middle - 18, width: 0, height: H + 40 })
    if (b.times) placed.findLast((p) => p.frame).width = x + W + 18 - placed.findLast((p) => p.frame).x
    x += W + STEP
  }
  if (heads) {
    const line = heads.line.split('; ')
    heads.names.forEach((name, k) => {
      const y = middle + (k - (heads.count - 1) / 2) * (H + 14)
      lines.push({ d: `M${x - STEP + 6} ${middle + H / 2} C${x - 4} ${middle + H / 2} ${x - 10} ${y + H / 2} ${x + 8} ${y + H / 2}`, arrow: true })
      placed.push({ b: { ...heads, count: 1, names: [name], line: line[k] ?? heads.line, params: Math.round(heads.params / heads.count) }, x: x + 10, y })
    })
    x += W + STEP
  }
  return { width: Math.max(x - STEP + 10, W), height, placed, lines }
}

// The network inside the part's box.
export function Network({ network, name }) {
  const [tip, setTip] = useState()
  return (
    <>
      <svg className="model-network" viewBox={`0 0 ${network.width} ${network.height}`} width={network.width} height={network.height}
        role="img" aria-label={`${name} as blocks`}>
        <defs>
          <marker id="model-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0 0 L10 5 L0 10 z" className="m-arrow" />
          </marker>
        </defs>
        {network.lines.map(({ d, arrow }) => <path key={d} d={d} className="m-wire" markerEnd={arrow ? 'url(#model-arrow)' : undefined} />)}
        {network.placed.filter((p) => p.frame).map((p) => (
          <g key={`frame${p.x}`}>
            <rect x={p.x} y={p.y} width={p.width} height={p.height} rx="10" className="m-frame" />
            <text x={p.x + p.width - 8} y={p.y + 14} className="m-times">{`${p.times}×`}</text>
          </g>
        ))}
        {network.placed.filter((p) => !p.frame).map((p, i) => p.join ? (
          <g key={`join${i}`}>
            <circle cx={p.x} cy={p.y} r="11" className="m-join" />
            <text x={p.x} y={p.y + 5} className="m-plus">+</text>
          </g>
        ) : (
          <g key={p.b.names.join()} className="m-block" tabIndex="0"
            onPointerMove={(e) => setTip({ block: p.b, x: e.clientX, y: e.clientY })} onPointerLeave={() => setTip()}
            onFocus={(e) => { const r = e.currentTarget.getBoundingClientRect(); setTip({ block: p.b, x: r.right, y: r.top }) }}
            onBlur={() => setTip()}>
            <Icon kind={p.b.kind} x={p.x} y={p.y} />
            <text x={p.x + W / 2} y={p.y + H + 15} className="m-label">{label(p.b)}</text>
            <rect x={p.x} y={p.y} width={W} height={H + 20} className="m-hit" />
          </g>
        ))}
      </svg>
      {/* The diagram is drawn in a moving, scaled layer; the note sits above all of it. */}
      {tip && createPortal(<Tip {...tip} />, document.body)}
    </>
  )
}

// The usual pictures: fully connected as a trapezoid, an embedding as a table,
// a recurrent layer as a box that loops, convolutions as stacked slabs, a
// transformer layer as attention over MLP, layer norm as a thin bar.
function Icon({ kind, x, y }) {
  const cx = x + W / 2
  if (kind === 'Linear') return <path d={`M${x + 14} ${y + 8} L${x + W - 14} ${y + 20} L${x + W - 14} ${y + H - 20} L${x + 14} ${y + H - 8} Z`} className="m-icon m-linear" />
  if (kind === 'Embedding') {
    return (
      <g>
        <rect x={x + 22} y={y + 16} width={W - 44} height={H - 28} rx="2" className="m-icon m-table" />
        {[1, 2, 3, 4].map((k) => <line key={`r${k}`} x1={x + 22} x2={x + W - 22} y1={y + 16 + k * 10} y2={y + 16 + k * 10} className="m-grid" />)}
        {[1, 2].map((k) => <line key={`c${k}`} x1={x + 22 + k * 20} x2={x + 22 + k * 20} y1={y + 16} y2={y + H - 12} className="m-grid" />)}
      </g>
    )
  }
  if (['GRU', 'LSTM', 'RNN'].includes(kind)) {
    return (
      <g>
        <rect x={x + 18} y={y + 18} width={W - 36} height={H - 28} rx="6" className="m-icon m-recurrent" />
        <path d={`M${cx - 12} ${y + 18} C${cx - 12} ${y + 2} ${cx + 12} ${y + 2} ${cx + 12} ${y + 16}`} className="m-loop" markerEnd="url(#model-arrow)" />
      </g>
    )
  }
  if (/Conv|Encoder/.test(kind)) {
    return <g>{[0, 1, 2].map((k) => <path key={k} d={`M${x + 20 + k * 10} ${y + 14 + k * 6} l40 0 l14 10 l0 ${H - 44} l-40 0 l-14 -10 Z`} className="m-icon m-conv" />)}</g>
  }
  if (/Transformer|Block|Attention/.test(kind)) {
    return (
      <g>
        <rect x={x + 12} y={y + 6} width={W - 24} height={H - 12} rx="8" className="m-icon m-transformer" />
        <rect x={x + 22} y={y + 14} width={W - 44} height="18" rx="4" className="m-sub" />
        <text x={cx} y={y + 27} className="m-small">Attn</text>
        <rect x={x + 22} y={y + 40} width={W - 44} height="18" rx="4" className="m-sub" />
        <text x={cx} y={y + 53} className="m-small">MLP</text>
      </g>
    )
  }
  if (kind === 'LayerNorm') return <rect x={cx - 5} y={y + 8} width="10" height={H - 16} rx="3" className="m-norm" />
  return <rect x={x + 14} y={y + 10} width={W - 28} height={H - 20} rx="6" className="m-icon m-other" />
}

function Tip({ block, x, y }) {
  const show = (shapes) => shapes.map((s) => `(${s.join(' × ')})`).join(', ') || '—'
  return (
    <div className="m-tip" style={{ left: Math.min(x + 14, window.innerWidth - 380), top: Math.min(y + 14, window.innerHeight - 180) }}>
      <b>{`${block.count > 1 ? `${block.count} × ` : ''}${block.kind}`}</b>
      <span className="m-names">{block.names.join(', ')}</span>
      <span>{block.note || 'no comment in the code'}</span>
      {block.line && <span className="m-names">{block.line}</span>}
      {block.io && <span className="m-names">in {show(block.io.in)} → out {show(block.io.out)}</span>}
      <span className="m-names">{amount(block.params)} parameters</span>
    </div>
  )
}

// Inputs of one kind become one block, in order of first use.
function byKind(blocks) {
  const groups = new Map()
  for (const b of blocks) {
    const g = groups.get(b.kind) ?? { ...b, count: 0, params: 0, names: [], lines: [], notes: [] }
    g.count += b.count
    g.params += b.params
    g.names.push(...b.names)
    if (b.line) g.lines.push(...b.line.split('; '))
    if (b.note) g.notes.push(b.note)
    g.io = g.count === 1 ? b.io : undefined
    groups.set(b.kind, g)
  }
  return [...groups.values()].map((g) => ({ ...g, line: [...new Set(g.lines)].join('; '), note: [...new Set(g.notes)].join(' / ') }))
}

function label(b) {
  let text = NICK[b.kind] ?? b.kind
  if (b.kind === 'Linear' && b.line && !b.line.includes(';')) text += ` ${b.line}`
  return `${b.count > 1 ? `${b.count}× ` : ''}${text}`
}

export function amount(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n)
}
