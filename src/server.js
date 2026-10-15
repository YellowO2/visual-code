import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { readTree } from './tree.js'

const ASSETS = {
  '/': ['view/index.html', 'text/html'],
  '/view.css': ['view/view.css', 'text/css'],
  '/app.js': ['view/app.js', 'text/javascript'],
  '/app.css': ['view/app.css', 'text/css'],
}
const SETTLE_MS = 100

export function serve(root, port) {
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

  return createServer(async (req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      send(res, snapshot)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    const asset = ASSETS[req.url]
    if (!asset) return res.writeHead(404).end()
    const [file, type] = asset
    res.writeHead(200, { 'content-type': type })
    res.end(await readFile(new URL(file, import.meta.url)))
  }).listen(port)
}

function send(client, data) {
  client.write(`data: ${data}\n\n`)
}
