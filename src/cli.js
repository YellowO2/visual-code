#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { serve } from './server.js'
import { readTree } from './tree.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', short: 'p', default: '4400' },
    // The Python that can import the project's models, for the model view.
    python: { type: 'string', default: process.env.VISUAL_CODE_PYTHON ?? 'python3' },
  },
})

// The rules a project is drawn and checked by, for a person or an agent to read.
if (positionals[0] === 'rules') {
  process.stdout.write(readFileSync(new URL('../RULES.md', import.meta.url), 'utf8'))
  process.exit(0)
}

const checking = positionals[0] === 'check'
const root = resolve(positionals[checking ? 1 : 0] ?? '.')

if (checking) {
  const { warnings } = readTree(root)
  for (const { path, line, message } of warnings) console.log(`${path}${line ? `:${line}` : ''}  ${message}`)
  console.log(warnings.length ? `\n${warnings.length} warnings` : 'no warnings')
  process.exit(warnings.length ? 1 : 0)
}

const server = serve(root, Number(values.port), values.python)

server.on('listening', () => {
  console.log(`${root}\nhttp://localhost:${server.address().port}`)
})

server.on('error', (error) => {
  if (error.code !== 'EADDRINUSE') throw error
  console.error(`Port ${values.port} is taken, probably by a visual-code that is already running.
Open http://localhost:${values.port}, or pick another port with --port.`)
  process.exit(1)
})
