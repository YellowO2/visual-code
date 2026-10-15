// Where a project breaks the rules, as warnings a person or an agent can act on.

const SOURCE = /\.(py|js|ts|jsx|tsx)$/
const VAGUE = new Set(['utils', 'util', 'helpers', 'helper', 'misc', 'common', 'stuff', 'lib'])
const MAX_INPUTS = 5
const MAX_OUTPUTS = 3
// Concerns every part has, which are not data: they are never wires.
const SIDE_CHANNELS = new Set(['log', 'logger', 'verbose', 'debug', 'progress'])
// A file or folder's location, as a wire's name gives it away.
const LOCATION = /(^|_)(path|paths|dir|dirs|directory|folder|folders|file|files|filename)$/
// Names that hide what a value is: say the thing instead.
const ABBREVIATED = new Set(['cfg', 'conf', 'prep', 'res', 'ret', 'tmp', 'temp', 'val', 'vals', 'obj',
  'arr', 'lst', 'dct', 'info', 'data', 'stuff', 'args', 'kwargs', 'params', 'opts', 'ctx', 'buf'])
const MAX_OPENING = 72
const MACHINE = "parts don't run parts; make it a machine, a folder whose main.py runs them"
const GROUP = 'group values that always travel together, drop ones that repeat others, and keep data, settings and verdicts apart'

export function check(nodes) {
  const machines = nodes.filter((node) => node.main)
  const found = nodes.filter((node) => !outside(node)).flatMap((node) => warnings(node, isPart(node, machines)))
  found.push(...placement(nodes))
  found.push(...unplaced(nodes, machines))
  found.push(...hidden(nodes, machines))
  found.push(...unshared(nodes))
  if (!machines.length) {
    found.push({ path: nodes[0].path, message: 'no main.py anywhere: nothing says how the parts connect' })
  }
  return found.sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0))
}

// A file lives in the closest folder holding everything that uses it. Folders
// between are fine if they are shelves, which have no walls, and a machine's
// own types may be used from above it, through its wall. Only users inside the
// file's package count: tests and outside scripts do not move it. A file run
// on its own needs no users.
function placement(nodes) {
  const users = new Map()
  for (const node of nodes) {
    if (outside(node)) continue
    for (const used of node.uses ?? []) users.set(used, [...(users.get(used) ?? []), node.path])
  }
  const machine = new Set(nodes.filter((node) => node.main).map((node) => node.path))
  // A type on a machine's ports belongs to the machine; its callers use it to call it.
  const interfaces = new Set(nodes.flatMap((node) => node.interface ?? []))
  const found = []
  for (const file of nodes) {
    if (!file.uses || !file.name.endsWith('.py') || outside(file) || ENTRY.test(file.name) || interfaces.has(file.path)) continue
    const folder = folderOf(file.path)
    const by = users.get(file.path) ?? []
    if (!by.length) {
      if (!file.runs) found.push({ path: file.path, message: 'nothing in the project uses it: wire it in or delete it' })
      continue
    }
    const inPackage = by.filter((user) => user.split('/')[0] === file.path.split('/')[0] && user.includes('/'))
    if (!inPackage.length) continue
    const fromAbove = inPackage.every((user) => folder.startsWith(folderOf(user)) || user.startsWith(folder))
    const home = commonFolder(inPackage)
    const between = folder.startsWith(home) ? folder.slice(home.length).split('/').filter(Boolean) : null
    const walls = between?.some((_, i) => machine.has(home + between.slice(0, i + 1).join('/') + '/'))
    if (!fromAbove && (!between || walls)) {
      found.push({ path: file.path, message: `used from ${home || 'the top'}: move it there` })
    }
  }
  return found
}

const folderOf = (path) => path.slice(0, path.lastIndexOf('/') + 1)

// Inside a machine, every file is a part (its main calls it), a tool, or a
// type (its one offering is a class). Anything else belongs deeper, next to
// what uses it, or nowhere. What a package's top __init__ offers is its public
// face, for its callers to use.
function unplaced(nodes, machines) {
  const wired = new Set(machines.flatMap((m) => [...m.wires.flatMap(({ from, to }) => [from, to]), ...m.calls]))
  const offered = nodes.filter((node) => node.name === '__init__.py' && node.path.split('/').length === 2)
  const interfaces = new Set([...nodes.flatMap((node) => node.interface ?? []), ...offered.flatMap((node) => node.uses)])
  return nodes
    .filter((file) => file.defines && isPart(file, machines) && !outside(file) && !ENTRY.test(file.name)
      && !isTool(file) && !interfaces.has(file.path) && !wired.has(file.path)
      && !isType(file))
    .map((file) => ({ path: file.path, message: 'no wire reaches it, and it is not a tool or a type: wire it in, make it a tool, or move it next to what uses it' }))
}

// Only a main file runs parts. A part that runs other parts, imported or
// handed to it, is a machine hiding in a file, its pipeline out of sight.
// Another package is a library.
function hidden(nodes, machines) {
  const byPath = new Map(nodes.map((node) => [node.path, node]))
  const isPlainPart = (file) => file && isPart(file, machines) && !outside(file) && !isTool(file) && !isType(file)
  const packageOf = (path) => path.split('/')[0]
  const holders = handedParts(machines)
  return nodes
    .filter((file) => isPlainPart(file) && !ENTRY.test(file.name))
    .flatMap((file) => {
      const used = (file.uses ?? []).filter((path) => {
        const other = byPath.get(path)
        return isPlainPart(other) && (other.name === 'main.py' || !ENTRY.test(other.name))
          && packageOf(path) === packageOf(file.path)
      })
      const names = used.map((path) => path.split('/').at(-1) === 'main.py' ? path.split('/').at(-2) : path.split('/').at(-1))
      const imported = names.length ? [{ path: file.path, message: `uses other parts (${names.join(', ')}): ${MACHINE}` }] : []
      const handed = (holders.has(file.path) ? file.handed ?? [] : []).map(({ name, line }) => ({ path: file.path, line,
        message: `runs ${name}, a part it was handed: ${MACHINE}` }))
      return [...imported, ...handed]
    })
}

// A tool is shared. One with a single user is part of that user's job.
function unshared(nodes) {
  const users = new Map()
  for (const node of nodes) {
    if (outside(node)) continue
    for (const used of node.uses ?? []) users.set(used, new Set([...(users.get(used) ?? []), node.path]))
  }
  return nodes
    .filter((file) => file.defines && isTool(file) && !outside(file) && !ENTRY.test(file.name)
      && (users.get(file.path)?.size ?? 0) === 1)
    .map((file) => ({ path: file.path, message: `only ${[...users.get(file.path)][0]} uses it: a tool is shared; make it part of its user, or a part of its own` }))
}

// The files a part is handed to, following the main files: a 'uses' wire
// hands a part over, and an input it arrived by passes it on to whatever that
// input is wired to. Other functions passed around as values are not parts.
function handedParts(machines) {
  const byPath = new Map(machines.map((machine) => [machine.path, machine]))
  const holders = new Set()
  const arrived = []
  const reach = (target, names) => {
    if (holders.has(target)) return
    holders.add(target)
    if (byPath.has(target)) arrived.push(...names.map((name) => `${target}#in:${name}`))
  }
  for (const machine of machines) {
    for (const { from, to, names, kind } of machine.wires) if (kind === 'uses') reach(to, names)
  }
  while (arrived.length) {
    const port = arrived.pop()
    const machine = byPath.get(port.split('#')[0])
    for (const { from, to, names } of machine.wires) if (from === port) reach(to, names)
  }
  return holders
}

// A type's one offering is a class.
const isType = (file) => file.defines?.length === 1 && file.defines[0].kind === 'class'

const ENTRY = /^(main|__main__|__init__|app|conftest|setup)\.py$/

function commonFolder(paths) {
  const folders = paths.map((path) => folderOf(path).split('/').filter(Boolean))
  const shared = []
  for (let i = 0; folders.every((f) => i < f.length && f[i] === folders[0][i]); i++) shared.push(folders[0][i])
  return shared.length ? `${shared.join('/')}/` : ''
}

// Shared helpers parts use inside themselves, kept in a tools/ folder.
export const isTool = (node) => node.path.split('/').includes('tools')

// Tests, scripts and private folders (_vendor) are outside the rules altogether.
function outside(node) {
  const segments = node.path.split('/').filter(Boolean)
  return segments.some((segment) => segment === 'tests' || segment === 'scripts' || /^_(?!_)/.test(segment))
    || /^test_|_test\./.test(node.name)
}

// A file is held to the rules of parts when it sits in a machine and is
// written in its main file's language.
function isPart(node, machines) {
  const machine = machines
    .filter((m) => m.path === '.' || node.path.startsWith(m.path))
    .sort((a, b) => b.path.length - a.path.length)[0]
  return Boolean(machine) && extension(node.name) === extension(machine.main)
}

const extension = (name) => name.slice(name.lastIndexOf('.'))

function warnings(node, inMachine) {
  const found = []
  const warn = (message, line) => found.push({ path: node.path, line, message })
  const stem = node.name.replace(/\.[^.]+$/, '')

  if (!node.children) {
    // Entry points (app.py, __main__.py) start the program; they are not parts.
    if (!SOURCE.test(node.name) || stem.startsWith('_') || (ENTRY.test(node.name) && stem !== 'main')) return found
    if (VAGUE.has(stem)) warn(`"${node.name}" does not say what it is`)
    for (const { line, text } of node.work ?? []) warn(`does work instead of wiring: ${shorten(text)}`, line)
    for (const { name, line, inputs, outputs, ports } of node.functions ?? []) {
      if (inputs > MAX_INPUTS) warn(`${name} takes ${inputs} inputs: ${GROUP}`, line)
      if (outputs > MAX_OUTPUTS) warn(`${name} returns ${outputs} values: ${GROUP}`, line)
      for (const port of new Set(ports)) {
        if (SIDE_CHANNELS.has(port)) {
          warn(`port "${port}" is not data: use Python's logging inside each part instead`, line)
        } else if (ABBREVIATED.has(port) || port.length < 3) {
          warn(`port "${port}" does not say what the value is: name it in full words`, line)
        }
      }
    }
    if (inMachine) {
      // A tool may offer a family of related functions; it still says what it is.
      if (!isTool(node)) oneJob(node, stem === 'main' ? folderName(node) : stem, warn)
      opening(node.about, stem === 'main' ? folderName(node) : stem, warn)
    }
    return found
  }
  if (node.main) {
    for (const { from, to, names } of node.wires) {
      if (from.includes('#') || to.includes('#')) continue
      for (const name of names.filter((n) => LOCATION.test(n))) {
        warn(`"${name}" is a location passed between parts: pass the data, and let only loaders and savers touch the disk`)
      }
    }
    return found
  }
  const sources = node.children.filter((child) => !child.children && SOURCE.test(child.name))
  const named = sources.find((child) => child.name.replace(/\.[^.]+$/, '') === node.name)
  if (node.children.length === 1 && sources.length === 1 && node.name !== 'tools') {
    warn(`holds only ${sources[0].name}: a part with nothing inside is a file, not a folder`)
  } else if (named) {
    warn(`${named.name} looks like this folder's main: name it main${named.name.slice(named.name.lastIndexOf('.'))}`)
  }
  return found
}

// A part has one job: one public function or class, named after the part.
function oneJob(file, name, warn) {
  const job = name ?? 'one function'
  const offered = file.defines ?? []
  if (offered.length > 1) {
    warn(`offers ${offered.length} things (${offered.map((d) => d.name).join(', ')}): a part has one job, ${job}; make the rest private with _`)
  } else if (!offered.length) {
    warn(`offers nothing: a part's job is a function or class named ${job}`)
  } else if (name && offered[0].name !== name) {
    warn(`offers ${offered[0].name}: name it ${name}, after the part`, offered[0].line)
  }
}

// What a part does, in one short sentence, as its file's first line.
function opening(line, name, warn) {
  if (!line) warn('has no opening line saying what it does')
  else if (line.length > MAX_OPENING || !/[.!?]$/.test(line)) {
    warn(`opening line should be one short sentence: "${shorten(line)}"`)
  } else if (name && line.toLowerCase().startsWith(name.toLowerCase())) {
    warn(`opening line repeats the name: say what ${name} does`)
  }
}

// The project's own main names the product, which its folder may not.
function folderName(file) {
  return file.path.split('/').at(-2) ?? null
}

function shorten(text) {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat
}
