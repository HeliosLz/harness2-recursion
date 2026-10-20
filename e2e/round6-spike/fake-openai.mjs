/**
 * Minimal OpenAI-completions fake provider for the Round-6 feasibility spike.
 *
 * Logs every request body (JSONL) so the spike can prove what the harness
 * actually sent to the wire after an offline profile-patch change.
 */
import http from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const PORT = Number(process.env.SPIKE_PORT ?? 8899)
const LOG = process.env.SPIKE_LOG
const TEXT = process.env.SPIKE_TEXT ?? 'SPIKE FINAL: one-shot task completed.'
if (LOG) mkdirSync(dirname(LOG), { recursive: true })

const chunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`
const sse = (res, model, text) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  res.write(chunk({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }))
  res.write(chunk({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }))
  res.write(chunk({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
  res.write('data: [DONE]\n\n')
  res.end()
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'spike-model' }] }))
    return
  }
  if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
    res.writeHead(404).end('not found')
    return
  }
  let body = ''
  req.on('data', (part) => { body += part })
  req.on('end', () => {
    let parsed = {}
    try { parsed = JSON.parse(body) } catch { /* keep {} */ }
    if (LOG) appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), body: parsed })}\n`)
    sse(res, parsed.model ?? 'spike-model', TEXT)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`spike fake provider on 127.0.0.1:${PORT}`)
})
