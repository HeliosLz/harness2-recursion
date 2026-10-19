/**
 * Fake OpenAI-compatible model server for the round-5 real-session E2E.
 *
 * Routes:
 *  - GET  /v1/models
 *  - POST /v1/chat/completions
 *      * Propose stage (system prompt)  → two valid candidates JSON
 *      * reflection stage (system prompt) → grounded reflection JSON echoing source edit facts
 *      * Probe children (user prompt says ADVISORY) → instant replay text
 *      * main agent: first MAIN_FAILURES requests → HTTP 500, then a delayed success
 */
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.FAKE_PORT ?? 8767)
const MAIN_FAILURES = Number(process.env.FAKE_FAILURES ?? 3)
const SLOW_SUCCESS_MS = Number(process.env.FAKE_SLOW_MS ?? 6000)
const LOG = process.env.FAKE_LOG ?? fileURLToPath(new URL('./artifacts/fake-requests.jsonl', import.meta.url))
mkdirSync(dirname(LOG), { recursive: true })

const sha256 = (value) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
const PROPOSAL_CONTENTS = [
  'E2E invariant: verify the failure signature before retrying the request.',
  'E2E domain: check provider health and error code before retrying.',
]
let mainRequests = 0

function chunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function base(model) {
  return { id: `chatcmpl-${randomUUID()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
}

function textDeltas(model, text) {
  const out = [chunk({ ...base(model), choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })]
  const size = Math.max(1, Math.ceil(text.length / 4))
  for (let index = 0; index < text.length; index += size) {
    out.push(chunk({ ...base(model), choices: [{ index: 0, delta: { content: text.slice(index, index + size) }, finish_reason: null }] }))
  }
  out.push(chunk({ ...base(model), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
  return out
}

function sse(res, model, text) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  for (const part of textDeltas(model, text)) res.write(part)
  res.write('data: [DONE]\n\n')
  res.end()
}

function proposeText() {
  const candidates = PROPOSAL_CONTENTS.map((content, index) => ({
    candidateType: index === 0 ? 'invariant' : 'domain',
    edit: {
      component: index === 0 ? 'system-prompt' : 'tool-guidance',
      operation: index === 0 ? 'append-guardrail' : 'add-reminder',
      content,
      contentHash: sha256(content),
    },
  }))
  return JSON.stringify({ candidates })
}

function reflectionText(facts, evidenceSummary) {
  const source = Array.isArray(facts.appliedEdits) && facts.appliedEdits.length > 0
    ? facts.appliedEdits[0]
    : (Array.isArray(facts.trials) && facts.trials.length > 0 ? facts.trials[0] : undefined)
  const candidateId = source?.candidateId ?? 'unknown'
  const component = source?.component ?? 'system-prompt'
  const operation = source?.operation ?? 'append-guardrail'
  const contentHash = source?.contentHash ?? source?.editContentHash ?? sha256('unknown')
  const pattern = evidenceSummary.includes('fake server failure')
    ? 'fake server failure'
    : evidenceSummary.slice(0, 80)
  return JSON.stringify({
    condition: { failurePattern: pattern, taskDomain: 'e2e' },
    edit: { candidateId, component, operation, contentHash },
    confidenceSeed: 0.5,
  })
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'main-model' }, { id: 'propose-model' }] }))
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
    appendFileSync(LOG, `${JSON.stringify({ url: req.url, body: parsed })}\n`)

    const model = parsed.model ?? 'unknown'
    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    const systemText = messages
      .filter((message) => message.role === 'system')
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .join('\n')
    const userText = messages
      .filter((message) => message.role === 'user')
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .join('\n')
    const facts = (() => {
      try { return JSON.parse(userText) } catch { return {} }
    })()

    if (systemText.includes('You are the Propose stage')) {
      sse(res, model, proposeText())
      return
    }
    if (systemText.includes('engineering experience library')) {
      const evidenceSummary = typeof facts.evidenceSummary === 'string' ? facts.evidenceSummary : ''
      sse(res, model, reflectionText(facts, evidenceSummary))
      return
    }
    if (userText.includes('ADVISORY replay subagent')) {
      sse(res, model, 'E2E replay complete: the candidate edit was considered; transcript recorded.')
      return
    }

    mainRequests += 1
    if (mainRequests <= MAIN_FAILURES) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'fake server failure', type: 'server_error' } }))
      return
    }
    setTimeout(() => {
      sse(res, model, 'E2E FINAL: the task completed after request-error retries; the recursion cycle ran in the background.')
    }, SLOW_SUCCESS_MS)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fake model server on http://127.0.0.1:${PORT}/v1 (failures=${MAIN_FAILURES}, slow=${SLOW_SUCCESS_MS}ms)`)
})
