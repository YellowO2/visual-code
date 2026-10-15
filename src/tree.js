import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { check } from './checks.js'
import { readImports } from './imports.js'
import { isPort, readWires } from './wiring.js'

const SKIPPED = new Set(['node_modules'])
const SOURCE = /\.(py|js|ts|jsx|tsx)$/
const PUBLIC = /^(?:export\s+)?(?:async\s+)?(def|class|function)\s+([A-Za-z]\w*)/gm
const OPENING_COMMENT = /^\s*(?:"""|'''|\/\*+|#+|\/\/+)\s*(\S.*)/

export function readTree(root) {
  const tree = { name: basename(root), path: '.', children: [] }
  for (const file of listFiles(root)) insert(tree, file.split('/'))
  const nodes = everything(tree)
  const find = finder(nodes)
  for (const folder of nodes) if (folder.children) wire(root, folder, find)
  for (const file of nodes) if (SOURCE.test(file.name)) Object.assign(file, describe(root, file, find))
  tree.warnings = check(nodes)
  return sorted(tree)
}

// Empty files hold nothing to look at, so they are left out.
function listFiles(root) {
  const hasContent = (file) => statSync(join(root, file), { throwIfNoEntry: false })?.size
  try {
    return gitFiles(root).filter(hasContent)
  } catch {
    return walk(root).filter(hasContent)
  }
}

// Tracked and untracked files, minus whatever .gitignore excludes.
function gitFiles(root) {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\0')
    .filter(Boolean)
}

function walk(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && !SKIPPED.has(entry.name))
    .flatMap((entry) =>
      entry.isDirectory() ? walk(root, `${prefix}${entry.name}/`) : `${prefix}${entry.name}`,
    )
}

function insert(folder, [name, ...rest]) {
  if (!rest.length) {
    folder.children.push({ name, path: childPath(folder, name) })
    return
  }
  let child = folder.children.find((c) => c.children && c.name === name)
  if (!child) {
    child = { name, path: `${childPath(folder, name)}/`, children: [] }
    folder.children.push(child)
  }
  insert(child, rest)
}

function childPath(folder, name) {
  return folder.path === '.' ? name : folder.path + name
}

function sorted(node) {
  node.children
    ?.sort((a, b) => !!b.children - !!a.children || a.name.localeCompare(b.name))
    .forEach(sorted)
  return node
}

// A folder with a main file is a machine. Its parts are its children, and the
// contents of any child folder without a main file: a shelf has no walls.
function wire(root, folder, find) {
  const main = folder.children.find((child) => !child.children && stem(child) === 'main')
  if (!main) return
  const read = (file) => readFileSync(join(root, file.path), 'utf8')
  const source = read(main)
  const parts = folder.children.filter((child) => child !== main).flatMap(onShelf)
  const partOf = (path) => parts.find((part) => path === part.path || path.startsWith(part.path))?.path
  const named = new Map()
  for (const [name, path] of readImports(source, folder.path === '.' ? '' : folder.path, find)) {
    if (partOf(path)) named.set(name, partOf(path))
  }
  const end = (id) => (isPort(id) ? `${folder.path}#${id}` : id)
  const { wires, calls, work, functions } = readWires(source, named)
  folder.main = main.path
  folder.about = title(source)
  folder.wires = wires.map((wire) => ({ ...wire, from: end(wire.from), to: end(wire.to) }))
  folder.calls = calls
  // The types its ports are declared with: the machine's interface.
  folder.portTypes = Object.assign({}, ...functions.map((f) => f.types))
  folder.interface = Object.values(folder.portTypes).filter((type) => named.has(type)).map((type) => named.get(type))
  Object.assign(main, { work, functions })
}

// What a file says it does, in its opening line; what it offers the rest of
// the project, its top-level functions and classes whose names do not start
// with an underscore; and which of the project's files it uses.
function describe(root, file, find) {
  const source = readFileSync(join(root, file.path), 'utf8')
  const defines = [...source.matchAll(PUBLIC)].map((match) => ({
    kind: match[1],
    name: match[2],
    line: source.slice(0, match.index).split('\n').length,
  }))
  const here = file.path.slice(0, file.path.length - file.name.length)
  const uses = [...new Set(readImports(source, here, find).values())].filter((path) => path !== file.path)
  const runs = /__name__\s*==\s*['"]__main__['"]/.test(source)
  return { about: title(source), defines, uses, runs }
}

function onShelf(node) {
  const shelf = node.children && !node.children.some((child) => stem(child) === 'main')
  return shelf ? node.children.flatMap(onShelf) : [node]
}

function everything(node) {
  return [node, ...(node.children ?? []).flatMap(everything)]
}

function finder(nodes) {
  const byPath = new Map(nodes.map((node) => [node.path, node]))
  return (candidates, { suffix = false } = {}) => {
    for (const path of candidates) {
      const node = byPath.get(path) ?? (suffix && nodes.find((n) => n.path.endsWith(`/${path}`)))
      if (node) return node
    }
  }
}

function stem(node) {
  return node.children ? node.name : node.name.replace(/\.[^.]+$/, '')
}

function title(source) {
  return source.match(OPENING_COMMENT)?.[1].replace(/("""|'''|\*\/)\s*$/, '').trim()
}
