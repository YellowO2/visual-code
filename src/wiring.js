// A main file connects parts with lines of the form
//
//     outputs = part(inputs)
//
// A name passed to one part after another returned it is a wire between them.
// A function's parameters enter through input ports, and what it returns
// leaves through output ports. Any other assignment passes its inputs through.

const INPUT = 'in:'
const OUTPUT = 'out:'
const USED = 'use:'
const SCOPE = /^\s*(?:async\s+)?(?:def|function|func|fn)\s+(\w+)\s*\((.*)\)/s
const RETURN = /^\s*return\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*$/
const LOOP = /^\s*(?:async\s+)?for\s+(.+?)\s+in\s+(.+):\s*$/s
const ASSIGNMENT = /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*=(?!=)\s*(.+)$/s
const CALL = /((?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*)\s*\(/g
const NAME = /[A-Za-z_]\w*/g
const QUOTED = /(['"])(?:\\.|(?!\1).)*\1/g
// A name a line reads: not text in quotes, and not a field after a dot.
const READ = /(?<![.\w])[A-Za-z_]\w*/g
const valueNames = (text) => text.replace(QUOTED, '""').match(READ) ?? []
const KEYWORD = /\b([A-Za-z_]\w*)\s*=(?!=)\s*([A-Za-z_]\w*)\s*(?=[,)])/g
const NOISE = /("""|''')[\s\S]*?\1|#.*|\/\/.*/g
const BRACKETED = /[[({][^[\](){}]*[\])}]/g
const START = /^if\s+__name__\s*==/
const RECEIVERS = new Set(['self', 'this'])
// Calls that only hold the wiring together.
const GLUE = new Set(['len', 'range', 'enumerate', 'zip', 'list', 'dict', 'tuple', 'set', 'sorted',
  'reversed', 'items', 'keys', 'values', 'append', 'extend', 'isinstance', 'super'])

export const isPort = (end) => end.startsWith(INPUT) || end.startsWith(OUTPUT)
// A part handed in through an input and run there: drawn inside the machine.
export const isUsed = (end) => end.startsWith(USED)

// `parts` maps each name the file imports from one of its parts to that part.
// Returns the wires, the parts called, the lines that do work instead of
// wiring, and each function with how many inputs it takes and values it returns.
export function readWires(source, parts) {
  const wires = new Map()
  const instances = new Map()
  const work = []
  const functions = []
  const calls = new Set()
  let writers = new Map()
  let inFunction = false
  const writersOf = (name) => writers.get(name) ?? []

  for (const { text: statement, line } of statements(source)) {
    // What runs the file on its own starts the program; it is not wiring.
    if (START.test(statement)) break
    const [, name, parameterList] = statement.match(SCOPE) ?? []
    if (parameterList !== undefined) {
      const inputs = parameters(parameterList)
      writers = new Map(inputs.map((input) => [input, [INPUT + input]]))
      // A parameter declared as a part is that part, handed in; any other
      // parameter that gets called is a part handed in from outside.
      instances.clear()
      for (const input of inputs) instances.set(input, USED + input)
      for (const [input, type] of typed(parameterList)) {
        if (parts.has(type)) instances.set(input, parts.get(type))
      }
      functions.push({ name, line, inputs: inputs.length, outputs: 0, ports: [...inputs],
        types: Object.fromEntries(typed(parameterList)) })
      inFunction = true
      continue
    }
    if (/^\S/.test(statement)) inFunction = false
    if (inFunction && doesWork(statement, parts, instances)) work.push({ line, text: statement.trim() })
    const [, returned] = statement.match(RETURN) ?? []
    if (returned && functions.length) {
      functions.at(-1).outputs = Math.max(functions.at(-1).outputs, names(returned).length)
      functions.at(-1).ports.push(...names(returned))
    }
    for (const name of names(returned)) {
      for (const from of writersOf(name)) connect(wires, from, OUTPUT + name, name)
    }
    // A loop takes its names from what it runs over.
    const [, targets, value = statement] = statement.match(LOOP) ?? statement.match(ASSIGNMENT) ?? []
    const call = partCall(value, parts, instances)
    if (call && inFunction) calls.add(call.part)
    const inputs = new Set(valueNames(value.replace(call?.text, '')))
    // A value passed by keyword (`build=scene_builder`) takes the keyword's name.
    const keywords = new Map([...value.matchAll(KEYWORD)].map(([, keyword, name]) => [name, keyword]))
    for (const name of call ? inputs : []) {
      const label = keywords.get(name) ?? name
      for (const from of writersOf(name)) connect(wires, from, call.part, label)
      // A part handed to another part is used by it: a different kind of wire.
      if (parts.has(name)) connect(wires, parts.get(name), call.part, label, 'uses').handed[label] = name
    }

    if (!targets) {
      // Putting a part's result into something makes the part its source.
      const [, receiver] = statement.match(/^\s*([A-Za-z_]\w*)\.\w+\(/) ?? []
      if (call && receiver && !call.text.startsWith(receiver)) {
        writers.set(receiver, unique([...writersOf(receiver), call.part]))
      }
      continue
    }
    const through = unique([...inputs].flatMap(writersOf))
    for (const name of names(targets)) {
      const rebuilt = inputs.has(name)
      if (!call) {
        // A name rebuilt from itself keeps its origin.
        writers.set(name, rebuilt ? writersOf(name) : through)
      } else {
        // A part that takes a name and returns it replaces the origin;
        // otherwise it is one more place the name can come from.
        writers.set(name, rebuilt ? [call.part] : unique([...writersOf(name), call.part]))
      }
    }
    // A part built by its class name is that part from then on.
    if (call?.builds && names(targets).length === 1) instances.set(targets.trim(), call.part)
  }
  return { wires: [...wires.values()], calls: [...calls], work, functions }
}

// A main file only calls its parts. Calling anything else is doing work.
function doesWork(statement, parts, instances) {
  if (/^\s*(?:del|print)\b/.test(statement)) return true
  if (LOOP.test(statement) || RETURN.test(statement)) return false
  return [...statement.matchAll(CALL)].some(([, text]) => {
    const segments = text.split('.')
    return !parts.has(segments[0]) && !instances.has(segments[0]) && !GLUE.has(segments.at(-1))
  })
}

function* statements(source) {
  const lines = source.replace(NOISE, (noise) => noise.replace(/[^\n]/g, '')).split('\n')
  let statement = ''
  let start = 1
  let depth = 0
  for (const [index, line] of lines.entries()) {
    if (!statement) start = index + 1
    statement += line
    depth += count(line, /[([{]/g) - count(line, /[)\]}]/g)
    if (depth > 0) continue
    yield { text: statement, line: start }
    statement = ''
    depth = 0
  }
}

// [name, type] for each parameter written `name: Type`.
function typed(list) {
  for (let before; before !== list; ) [before, list] = [list, list.replace(BRACKETED, '')]
  return list.split(',').flatMap((parameter) => {
    const [, name, type] = parameter.match(/^\s*\**(\w+)\s*:\s*([A-Za-z_]\w*)/) ?? []
    return name ? [[name, type]] : []
  })
}

function parameters(list) {
  for (let before; before !== list; ) [before, list] = [list, list.replace(BRACKETED, '')]
  return list
    .split(',')
    .map((parameter) => parameter.match(NAME)?.[0])
    .filter((name) => name && !RECEIVERS.has(name))
}

function partCall(value, parts, instances) {
  for (const [, text] of value.matchAll(CALL)) {
    const [first, ...rest] = text.split('.')
    // An input is run only when called itself; a method on it is using a value.
    const instance = instances.get(first)
    const part = parts.get(first) ?? (instance && !(isUsed(instance) && rest.length) ? instance : undefined)
    if (part) return { text, part, builds: parts.has(first) && /^[A-Z]/.test(rest.at(-1) ?? first) }
  }
}

// A wire joins parts, carrying values, or, of kind 'uses', handing one part to
// another. One straight from an input port to an output port has no part on
// it: that is loose logic, and is not drawn.
// Returns the wire; one that hands parts over also records, under each name it
// hands a part by, the name the part goes by where it comes from.
function connect(wires, from, to, name, kind) {
  if (from === to || (from.startsWith(INPUT) && to.startsWith(OUTPUT))) return { handed: {} }
  const key = `${from}\n${to}\n${kind}`
  if (!wires.has(key)) wires.set(key, { from, to, names: [], ...(kind && { kind, handed: {} }) })
  const wire = wires.get(key)
  if (!wire.names.includes(name)) wire.names.push(name)
  return wire
}

const names = (list) => list?.replace(/[()]/g, '').split(',').map((name) => name.trim()) ?? []
const count = (text, pattern) => text.match(pattern)?.length ?? 0
const unique = (items) => [...new Set(items)]

// Where a file runs a part it was handed: a call to one of its own functions'
// inputs that has no default. A main file does this to wire; a part must not.
export function handedRuns(source) {
  const runs = []
  const scopes = []
  for (const { text: statement, line } of statements(source)) {
    if (!statement.trim()) continue
    const indent = statement.match(/^\s*/)[0].length
    while (scopes.length && indent <= scopes.at(-1).indent) scopes.pop()
    const [, , parameterList] = statement.match(SCOPE) ?? []
    if (parameterList !== undefined) {
      scopes.push({ indent, handed: new Set(required(parameterList)) })
      continue
    }
    for (const [, text] of statement.matchAll(CALL)) {
      if (!text.includes('.') && scopes.some(({ handed }) => handed.has(text))) runs.push({ name: text, line })
    }
  }
  return runs
}

// The inputs a caller must give: no default, and not the receiver.
function required(list) {
  for (let before; before !== list; ) [before, list] = [list, list.replace(BRACKETED, '')]
  return list.split(',').map((parameter) => parameter.trim())
    .filter((parameter) => parameter && !parameter.includes('=') && !parameter.startsWith('*'))
    .map((parameter) => parameter.match(NAME)?.[0])
    .filter((name) => name && !RECEIVERS.has(name) && name !== 'cls')
}
