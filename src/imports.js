// What each name a main file imports refers to: a file or folder of the project.

const PY_FROM = /^\s*from\s+(\.*[\w.]*)\s+import\s+(?:\(([^)]*)\)|([^\n]*))/gm
const PY_IMPORT = /^\s*import\s+([\w.]+)\s+as\s+(\w+)/gm
const JS_IMPORT = /^\s*import\s+(?:(\w+)|\{([^}]*)\}|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]/gm

// `here` is the folder the main file sits in. `find` takes candidate project
// paths and returns the first node found, or undefined; with `suffix` a
// candidate may also match the end of a path.
export function readImports(source, here, find) {
  const named = new Map()
  const bind = (name, node) => node && named.set(name, node.path)

  for (const [, module, wrapped, line] of source.matchAll(PY_FROM)) {
    const target = pythonModule(module, here, find)
    // A comment after a name is not part of it.
    for (const [name, local] of aliases((wrapped ?? line).replace(/#.*$/gm, ''))) {
      bind(local, (target?.children && find([`${target.path}${name}.py`, `${target.path}${name}/`])) || target)
    }
  }
  for (const [, module, local] of source.matchAll(PY_IMPORT)) {
    bind(local, pythonModule(module, here, find))
  }
  for (const [, single, list, everything, from] of source.matchAll(JS_IMPORT)) {
    const target = scriptModule(from, here, find)
    const locals = single || everything ? [single || everything] : aliases(list).map(([, local]) => local)
    for (const local of locals) bind(local, target)
  }
  return named
}

function pythonModule(module, here, find) {
  const dots = module.match(/^\.*/)[0].length
  const rest = module.slice(dots).split('.').filter(Boolean).join('/')
  if (!dots) return find([`${rest}.py`, `${rest}/`], { suffix: true })
  const base = here.split('/').filter(Boolean).slice(0, 1 - dots || undefined).join('/')
  const path = [base, rest].filter(Boolean).join('/')
  return find([`${path}.py`, `${path}/`])
}

function scriptModule(from, here, find) {
  if (!from.startsWith('.')) return undefined
  const parts = []
  for (const part of `${here}${from}`.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  const path = parts.join('/')
  return find([path, `${path}.js`, `${path}.ts`, `${path}/`])
}

function aliases(list) {
  return list
    .split(',')
    .map((item) => item.trim().split(/\s+as\s+/))
    .filter(([name]) => /^\w+$/.test(name))
    .map(([name, local = name]) => [name, local])
}
