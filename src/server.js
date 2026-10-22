import { execFile } from 'node:child_process'
import { statSync, watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTree } from './tree.js'

const ASSETS = {
  '/': ['view/index.html', 'text/html'],
  '/view.css': ['view/view.css', 'text/css'],
  '/app.js': ['view/app.js', 'text/javascript'],
  '/app.css': ['view/app.css', 'text/css'],
}
const SETTLE_MS = 100
const MODEL_MS = 120000
const READER = fileURLToPath(new URL('model_view.py', import.meta.url))

// A model file's blocks, read by running it once in Python (model_view.py).
// Kept until the file changes.
function modelReader(root, python) {
  const cache = new Map()
  return (path) => {
    const changed = statSync(join(root, path), { throwIfNoEntry: false })?.mtimeMs
    if (changed === undefined) return Promise.resolve({ error: `no file ${path}` })
    const kept = cache.get(path)
    if (kept?.changed === changed) return kept.result
    const result = new Promise((done) => execFile(python, [READER, root, path], { cwd: root, timeout: MODEL_MS, maxBuffer: 1 << 24 },
      (failure, out, err) => done(failure ? { error: (err || failure.message).trim().split('\n').slice(-6).join('\n') } : JSON.parse(out))))
    cache.set(path, { changed, result })
    return result
  }
}

export function serve(root, port, python = 'python3') {
  const readModel = modelReader(root, python)
  const clients = new Set()
  let snapshot = JSON.stringify(readTree(root))
  let pending

  const refresh = () => {
    const next = JSON.stringify(readTree(root))
    if (next === snapshot) return
    snapshot = next
    for (const client of clients) send(client, snapshot)
  }

  watch(root, { recursive: true }, (_event, file) => {
    if (/^\.git(\/|$)/.test(file ?? '')) return
    clearTimeout(pending)
    pending = setTimeout(refresh, SETTLE_MS)
  })

  // A page drawn by an older build of this tool reloads itself.
  let rebuilt
  watch(new URL('view/', import.meta.url), () => {
    clearTimeout(rebuilt)
    rebuilt = setTimeout(() => { for (const client of clients) client.write('event: reload\ndata: \n\n') }, SETTLE_MS)
  })

  return createServer(async (req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      send(res, snapshot)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    if (req.url.startsWith('/model?')) {
      const path = new URL(req.url, 'http://x').searchParams.get('path')
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(await readModel(path)))
    }
    const asset = ASSETS[req.url]
    if (!asset) return res.writeHead(404).end()
    const [file, type] = asset
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(await readFile(new URL(file, import.meta.url)))
  }).listen(port)
}

function send(client, data) {
  client.write(`data: ${data}\n\n`)
}
