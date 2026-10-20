/**
 * Stage-0 falsification fake OpenAI-compatible model server.
 *
 * Copied from the repo's e2e/fake-model-server.mjs and changed ONLY where the
 * experiment requires it:
 *   - Propose returns exactly two candidates: the NULL edit and the
 *     ADVERSARIAL edit, with content hashes computed from proposals.mjs.
 *   - The main-model failure budget is per conversation (keyed by the first
 *     user task), so each fresh one-shot headless session gets its own
 *     3-failure budget instead of sharing one global counter.
 *   - After the budget is spent the main model succeeds after a 3-4 s delay,
 *     giving the background recursion cycle time to finish before the CLI exits.
 * Reflection stays grounded in the source payload; probe children answer
 * instantly.
 *
 * Routes (all on 127.0.0.1):
 *   GET  /v1/models
 *   POST /v1/chat/completions
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const proposalsModule = await import(
  process.env.FAKE_PROPOSALS_FILE
    ?? new URL('./proposals.mjs', import.meta.url).href
)
const { PROPOSALS, proposeJson, sha256 } = proposalsModule

const PORT = Number(process.env.FAKE_PORT ?? 8841)
const MAIN_FAILURES = Number(process.env.FAKE_FAILURES ?? 3)
const SLOW_MIN_MS = Number(process.env.FAKE_SLOW_MIN_MS ?? 3000)
const SLOW_MAX_MS = Number(process.env.FAKE_SLOW_MAX_MS ?? 4000)
const LOG = process.env.FAKE_LOG
  ?? fileURLToPath(new URL('./requests.jsonl', import.meta.url))
mkdirSync(dirname(LOG), { recursive: true })

const SUCCESS_TEXT = 'STAGE0 FINAL: task completed after request-error retries; the background recursion cycle ran.'
const PROBE_TEXT = 'STAGE0 ADVISORY replay complete: the candidate edit was considered; transcript recorded.'

function chunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function base(model) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
  }
}

function textDeltas(model, text) {
  const out = [
    chunk({
      ...base(model),
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    }),
  ]
  const size = Math.max(1, Math.ceil(text.length / 4))
  for (let index = 0; index < text.length; index += size) {
    out.push(
      chunk({
        ...base(model),
        choices: [
          { index: 0, delta: { content: text.slice(index, index + size) }, finish_reason: null },
        ],
      }),
    )
  }
  out.push(
    chunk({
      ...base(model),
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }),
  )
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

/**
 * Grounded reflection: echo the source edit facts back to the meta plugin.
 * The meta plugin rejects any edit field that differs from its source payload,
 * so this branch must never invent a candidate.
 */
function reflectionText(facts, evidenceSummary) {
  const appliedEdits = Array.isArray(facts.appliedEdits) ? facts.appliedEdits : []
  const trials = Array.isArray(facts.trials) ? facts.trials : []
  const source = appliedEdits[0] ?? trials[0]
  const candidateId = source?.candidateId ?? 'unknown'
  const component = source?.component ?? 'system-prompt'
  const operation = source?.operation ?? 'no-op'
  const contentHash = source?.contentHash ?? source?.editContentHash ?? `sha256:${sha256('unknown')}`
  const pattern = evidenceSummary.includes('fake server failure')
    ? 'fake server failure'
    : evidenceSummary.slice(0, 80)
  return JSON.stringify({
    condition: { failurePattern: pattern, taskDomain: 'stage0' },
    edit: { candidateId, component, operation, contentHash },
    confidenceSeed: 0.5,
  })
}

function textOf(message) {
  return typeof message.content === 'string' ? message.content : ''
}

function conversationKey(messages) {
  // A dsh main-agent request carries three user messages: the task, the
  // runtime-context snapshot, and the system reminder. The first user message
  // is the unique task string chosen by the runner; retries repeat it byte for
  // byte, while every new session uses a new task string.
  const firstUser = messages.find((message) => message.role === 'user' && textOf(message).length > 0)
  return firstUser === undefined ? 'unknown' : textOf(firstUser)
}

/** Per-conversation main-model failure budget. */
const conversations = new Map()

function budgetFor(key) {
  let state = conversations.get(key)
  if (state === undefined) {
    // Deterministic 3000-4000 ms recovery delay derived from the task key.
    const span = Math.max(0, SLOW_MAX_MS - SLOW_MIN_MS)
    const offset = span === 0 ? 0 : Number.parseInt(sha256(key).slice(0, 8), 16) % (span + 1)
    state = { failures: 0, delayMs: SLOW_MIN_MS + offset, done: false }
    conversations.set(key, state)
  }
  return state
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

    const model = parsed.model ?? 'unknown'
    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    const systemText = messages
      .filter((message) => message.role === 'system')
      .map(textOf)
      .join('\n')
    const userText = messages
      .filter((message) => message.role === 'user')
      .map(textOf)
      .join('\n')
    const facts = (() => {
      try { return JSON.parse(userText) } catch { return {} }
    })()

    let kind = 'main'
    if (systemText.includes('You are the Propose stage')) kind = 'propose'
    else if (systemText.includes('engineering experience library')) kind = 'reflection'
    else if (userText.includes('ADVISORY replay subagent')) kind = 'probe'

    appendFileSync(LOG, `${JSON.stringify({
      at: new Date().toISOString(),
      kind,
      model,
      nMessages: messages.length,
      conversationKey: kind === 'main' ? conversationKey(messages) : undefined,
      ...(kind === 'propose'
        ? {
            proposeResponse: PROPOSALS.map((proposal) => ({
              name: proposal.name,
              candidateId: proposal.candidateId,
              component: proposal.component,
              operation: proposal.operation,
              content: proposal.content,
            })),
          }
        : {}),
      ...(kind === 'probe'
        ? {
            probePromptCoverage: Object.fromEntries(
              PROPOSALS.map((proposal) => [proposal.name, userText.includes(proposal.content)]),
            ),
          }
        : {}),
      body: parsed,
    })}\n`)

    if (kind === 'propose') {
      sse(res, model, proposeJson())
      return
    }
    if (kind === 'reflection') {
      const evidenceSummary = typeof facts.evidenceSummary === 'string' ? facts.evidenceSummary : ''
      sse(res, model, reflectionText(facts, evidenceSummary))
      return
    }
    if (kind === 'probe') {
      sse(res, model, PROBE_TEXT)
      return
    }

    // Main agent: 3 failures per conversation, then a delayed success.
    const key = conversationKey(messages)
    const state = budgetFor(key)
    if (state.failures < MAIN_FAILURES) {
      state.failures += 1
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: { message: 'stage0 fake server failure', type: 'server_error' },
      }))
      return
    }
    if (state.done) {
      // Defensive: a duplicate post-budget request should not trigger a second
      // recovery artefact.
      sse(res, model, SUCCESS_TEXT)
      return
    }
    state.done = true
    setTimeout(() => {
      if (!res.writableEnded) sse(res, model, SUCCESS_TEXT)
    }, state.delayMs)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`stage0 fake model server on http://127.0.0.1:${PORT}/v1 (failures=${MAIN_FAILURES}, slow=${SLOW_MIN_MS}-${SLOW_MAX_MS}ms, log=${LOG})`)
})
