/**
 * Round-3 contract verification for harness2-task-recursion.
 *
 * Run: node --test test/verify.mjs
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(packageRoot, 'src', 'index.ts')
const constantsPath = path.join(packageRoot, 'src', 'constants.ts')
const siblingConstantsPath = path.resolve(packageRoot, '../harness2-meta-recursion/src/constants.ts')
const plugin = await import(sourcePath)
const probeArm = await import(path.join(packageRoot, 'src', 'probe-arm.ts'))
const source = await readFile(sourcePath, 'utf8')
const run = promisify(execFile)

const EXPECTED_EVENTS = ['tools/result', 'agent/request-error', 'agent/pre-step']
const PUBLIC_EMITTED_EVENTS = ['probe/completed', 'compose/applied', 'compose/rejected', 'propose/failed']
const ALLOWED_CTX_MEMBERS = new Set(['on', 'emit', 'logger', 'tools', 'agents', 'inject', 'get', 'llm'])
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
const hashOf = (value) => `sha256:${sha256(value)}`

function createStubContext({ services = {} } = {}) {
  const listeners = new Map()
  const emitted = []
  const provided = new Map()
  const logs = []
  const makeLogger = () => ({
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
    debug: (...args) => logs.push(['debug', ...args]),
  })
  const ctx = {
    ...services,
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    emit(name, payload) {
      emitted.push({ name, payload })
    },
    provide(name, value) {
      provided.set(name, value)
      return () => provided.delete(name)
    },
    get(name) {
      return provided.get(name) ?? ctx[name]
    },
    inject(_deps, callback) {
      const cleanup = callback(ctx)
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
    effect(execute) {
      return execute()
    },
    logger: () => makeLogger(),
  }
  return { ctx, listeners, emitted, provided, logs }
}

function makeAgent(sessionId, extra = {}) {
  return {
    options: { provider: 'fake-provider', model: 'fake-model' },
    session: {
      header: { id: sessionId, ...extra },
      deriveMessages: () => [],
    },
  }
}

async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

function makeConfig(dir, overrides = {}) {
  return new plugin.Config({ ledgerPath: path.join(dir, 'ledger.jsonl'), ...overrides })
}

function textStream(text) {
  return (async function* () {
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

function usageStream(text, totalTokens) {
  return (async function* () {
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: totalTokens - 10, totalTokens } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

function personaProposalJson() {
  return JSON.stringify({
    candidates: [
      {
        candidateType: 'invariant',
        edit: {
          component: 'system-prompt',
          operation: 'set-persona-prefix',
          content: PERSONA_CONTENT,
          contentHash: hashOf(PERSONA_CONTENT),
        },
      },
      {
        candidateType: 'domain',
        edit: {
          component: 'system-prompt',
          operation: 'set-persona-prefix',
          content: PERSONA_CONTENT_2,
          contentHash: hashOf(PERSONA_CONTENT_2),
        },
      },
    ],
  })
}

function proposalJson() {
  const build = (candidateType, component, operation, content) => ({
    candidateType,
    edit: { component, operation, content, contentHash: hashOf(content) },
  })
  return JSON.stringify({
    candidates: [
      build('invariant', 'system-prompt', 'append-guardrail', 'Always verify the failing command before retrying.'),
      build('domain', 'tool-guidance', 'add-reminder', 'Remind the model to inspect the tool error code first.'),
    ],
  })
}

function childHandleNoSystemPrompt(messages) {
  const handle = childHandle(messages)
  handle.agent.ctx = { get: () => undefined }
  handle.sections = []
  return handle
}

function childHandle(messages) {
  const followups = []
  const sections = []
  const child = {
    options: {},
    ctx: {
      get: (name) => (name === 'systemPrompt'
        ? { section: (section) => { sections.push(section); return () => {} } }
        : undefined),
    },
    session: {
      header: { id: `child-${Math.random().toString(16).slice(2)}`, origin: 'subagent', isSeeded: false },
      deriveMessages: () => messages,
    },
    followup: (message) => followups.push(message),
    whenIdle: async () => {},
    cancel: () => {},
  }
  return {
    agent: child,
    followups,
    sections,
    dispose: async () => {},
  }
}

function metrics(overrides = {}) {
  return {
    completion: false,
    toolFailures: 3,
    stepCount: 4,
    tokenCost: 100,
    tokenCostSource: 'measured',
    durationMs: 1000,
    ...overrides,
  }
}

function goodTrialMetrics(overrides = {}) {
  return metrics({ completion: true, toolFailures: 0, stepCount: 2, tokenCost: 50, ...overrides })
}

const PERSONA_CONTENT = 'You are a coding agent that checks the failing command and reports the first error before retrying.'
const PERSONA_CONTENT_2 = 'You are a coding agent that verifies the failing step and reports a concise diagnosis before retrying.'
const CONTENT = 'patch content'
const CANDIDATE_ID = 'cand-1'

function trialRecord(overrides = {}) {
  return {
    candidateId: CANDIDATE_ID,
    candidateType: 'invariant',
    component: 'system-prompt',
    operation: 'append-guardrail',
    editContentHash: hashOf(CONTENT),
    valid: true,
    metrics: goodTrialMetrics(),
    ...overrides,
  }
}

function probePayload(overrides = {}) {
  return {
    taskId: 'task-1',
    baselineMetrics: metrics(),
    trials: [trialRecord()],
    evidenceSummary: 'tool=bash;code=TOOL_FAILED; command failed',
    cycleId: 'cycle-1',
    ...overrides,
  }
}

function appliedEdit(overrides = {}) {
  return {
    candidateId: CANDIDATE_ID,
    contentHash: hashOf(CONTENT),
    component: 'system-prompt',
    operation: 'append-guardrail',
    ...overrides,
  }
}

function appliedPayload(overrides = {}) {
  return {
    taskId: 'task-1',
    cycleId: 'cycle-1',
    appliedCandidateIds: [CANDIDATE_ID],
    appliedEdits: [appliedEdit()],
    appliedComponents: ['system-prompt'],
    previousSnapshotRef: 'led-prev',
    ledgerEntryId: 'led-applied',
    applyMode: 'next-task-ledger',
    ...overrides,
  }
}

function rejectedPayload(overrides = {}) {
  return {
    taskId: 'task-1',
    cycleId: 'cycle-1',
    reason: 'regression',
    rejectedCandidateIds: [CANDIDATE_ID],
    baselineMetrics: metrics(),
    trials: [trialRecord()],
    ...overrides,
  }
}

/* 1 */
test('1. entry contract — namespace exports only, no default export', () => {
  assert.equal(plugin.name, 'harness2-task-recursion')
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(!('default' in plugin))
  assert.deepEqual(plugin.inject, ['tools', 'llm', 'agents'])
})

/* 2 */
test('2. Config — round-3 defaults resolve', () => {
  assert.deepEqual(new plugin.Config({}), {
    triggerThreshold: 3,
    repeatedFailureWindow: 3,
    cooldownMs: 60000,
    ledgerPath: './harness2-ledger.jsonl',
    maxCostPerCycle: 50000,
    probeTimeoutMs: 120000,
    replayScope: 'last-failed-step',
    gatePolicy: 'v4',
    controlReplicates: 2,
    maxAppliedEdits: 1,
    observeOnly: true,
    trajectoryWindow: 5,
    taskDomain: '',
    proposeModel: '',
    metricWeights: { completion: 1, toolFailures: 0.5, stepCount: 0.1, tokenCost: 0.0001 },
  })
  assert.throws(() => new plugin.Config({ replayScope: 'sometimes' }))
  assert.throws(() => new plugin.Config({ triggerThreshold: 'three' }))
  assert.throws(() => new plugin.Config({ controlReplicates: 3 }), 'controlReplicates is fixed at 2')
  assert.throws(() => new plugin.Config({ maxAppliedEdits: 3 }), 'maxAppliedEdits is 1|2')
  assert.equal(new plugin.Config({ maxAppliedEdits: 2 }).maxAppliedEdits, 2)
})

/* 3 */
test('3. listeners — exactly the three documented events', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-task-verify-'))
  try {
    const stub = createStubContext()
    plugin.apply(stub.ctx, makeConfig(dir))
    assert.deepEqual([...stub.listeners.keys()].sort(), [...EXPECTED_EVENTS].sort())
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* 4 */
test('4. waterfall next() + terminal request-error scheduling', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-task-verify-'))
  try {
    let llmCalls = 0
    const stub = createStubContext({
      services: {
        agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) },
        llm: { stream: () => { llmCalls += 1; return textStream('not json') } },
      },
    })
    plugin.apply(stub.ctx, makeConfig(dir))
    const agent = makeAgent('parent-session')
    const signal = new AbortController().signal
    const preStep = stub.listeners.get('agent/pre-step')
    const decision = { kind: 'enter', messages: [] }
    let nextCalls = 0
    const result = await preStep(
      { agent, messages: [], turn: 1, step: 1, signal },
      async () => { nextCalls += 1; return decision },
    )
    assert.equal(nextCalls, 1)
    assert.equal(result, decision)

    const requestError = stub.listeners.get('agent/request-error')
    let errorNext = 0
    for (let index = 0; index < 3; index += 1) {
      await requestError(
        { agent, turn: 1, step: index + 1, provider: 'fake', failure: { message: 'boom', code: 'FAKE' }, retryPolicy: undefined, signal },
        async () => { errorNext += 1; return undefined },
      )
    }
    assert.equal(errorNext, 3)
    await waitFor(async () => stub.emitted.length > 0)
    assert.ok(llmCalls >= 2, 'Propose retried once')
    // R4-1: Propose failure is a terminal state with its own event; no
    // compose/rejected and no empty-id payload is fabricated.
    assert.deepEqual(stub.emitted.map((event) => event.name), ['propose/failed'])
    const failure = stub.emitted[0].payload
    assert.equal(failure.reason, 'schema-invalid')
    assert.equal(failure.attempts, 2)
    assert.ok(failure.lastError.length > 0)
    assert.ok(failure.baselineMetrics)
    const envelopes = (await readFile(path.join(dir, 'ledger.jsonl'), 'utf8'))
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(envelopes.length, 1)
    assert.equal(envelopes[0].event, 'propose/failed')
    assert.equal(envelopes[0].payload.recordedAt, envelopes[0].recordedAt)
    for (let index = 0; index < 3; index += 1) {
      assert.ok(!stub.emitted.some((event) => event.name.startsWith('compose/')))
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* 5 */
test('5. trigger — OR conditions plus cooldown/in-flight suppression', () => {
  const config = new plugin.Config({})
  const now = 10 ** 12
  const requestState = plugin.createFailureState()
  requestState.requestErrors = config.triggerThreshold
  assert.deepEqual(plugin.selectTrigger(requestState, config, now), {
    trigger: 'request-error-threshold',
    failures: config.triggerThreshold,
  })
  const toolState = plugin.createFailureState()
  toolState.toolFailureStreak = config.repeatedFailureWindow
  assert.deepEqual(plugin.selectTrigger(toolState, config, now), {
    trigger: 'repeated-tool-failure',
    failures: config.repeatedFailureWindow,
  })
  toolState.lastTriggerAt = now - config.cooldownMs + 1
  assert.equal(plugin.selectTrigger(toolState, config, now), undefined)
  toolState.lastTriggerAt = now - config.cooldownMs
  assert.ok(plugin.selectTrigger(toolState, config, now))
  toolState.probeInFlight = true
  assert.equal(plugin.selectTrigger(toolState, config, now), undefined)
})

/* 6 */
test('6. reducers — consecutive failures, bounded trajectory, token source', () => {
  const state = plugin.createFailureState()
  plugin.noteToolResult(state, { toolName: 'bash', failed: true, message: 'e1', at: 1, step: 1 }, 2)
  plugin.noteToolResult(state, { toolName: 'bash', failed: true, message: 'e2', at: 2, step: 2 }, 2)
  assert.equal(state.toolFailureStreak, 2)
  plugin.noteToolResult(state, { toolName: 'read', failed: true, message: 'e3', at: 3, step: 3 }, 2)
  assert.equal(state.toolFailureStreak, 1)
  assert.equal(state.trajectory.length, 2)
  plugin.noteToolResult(state, { toolName: 'read', failed: false, message: '', at: 4, step: 4 }, 2)
  assert.equal(state.toolFailureStreak, 0)
  plugin.noteRequestError(state, { at: 5, step: 5, message: 'boom', errorCode: 'E' }, 2)
  assert.equal(state.requestErrors, 1)
  assert.equal(plugin.errorCodeOf({ info: { code: 'TOOL_TIMEOUT' } }), 'TOOL_TIMEOUT')
  const baseline = plugin.baselineMetricsOf(
    { get: () => undefined },
    makeAgent('agent'),
    state,
    'request-error-threshold',
    Date.now(),
  )
  assert.equal(baseline.tokenCostSource, 'estimated', 'no tokenMeter → estimated')
})

/* 7 */
test('7. payload schemas — round-3 fields, required metadata, JSON safety', () => {
  assert.deepEqual(plugin.assertJsonSafePayload(plugin.validateProbeCompletedPayload, probePayload()), [])
  assert.deepEqual(plugin.assertJsonSafePayload(plugin.validateComposeAppliedPayload, appliedPayload()), [])
  assert.deepEqual(plugin.assertJsonSafePayload(plugin.validateComposeRejectedPayload, rejectedPayload()), [])

  // Q1: trial metadata is required.
  assert.ok(plugin.validateTrialRecord({ candidateId: 'c', candidateType: 'invariant', valid: true, metrics: goodTrialMetrics() }).length > 0)
  assert.equal(plugin.trialMetadataComplete(trialRecord()), true)
  assert.equal(plugin.trialMetadataComplete({ candidateId: 'c', component: 'system-prompt' }), false)

  // Metrics require tokenCostSource.
  const badMetrics = { ...goodTrialMetrics() }
  delete badMetrics.tokenCostSource
  assert.ok(plugin.validateProbeMetrics(badMetrics).length > 0)

  // appliedEdits must mirror appliedCandidateIds and match components.
  assert.ok(plugin.validateComposeAppliedPayload(appliedPayload({ appliedEdits: [] })).length > 0)
  assert.ok(plugin.validateComposeAppliedPayload(appliedPayload({
    appliedCandidateIds: ['cand-1', 'cand-2'],
  })).length > 0)
  assert.ok(plugin.validateComposeAppliedPayload(appliedPayload({
    appliedEdits: [appliedEdit({ candidateId: 'cand-9' })],
  })).length > 0)

  // rejectedCandidateIds must be non-empty and exist in trials.
  assert.ok(plugin.validateComposeRejectedPayload(rejectedPayload({ rejectedCandidateIds: [] })).length > 0)
  assert.ok(plugin.validateComposeRejectedPayload(rejectedPayload({ rejectedCandidateIds: ['nope'] })).length > 0)

  // R4-1 propose/failed schema (attempts frozen at 2, reason union).
  const proposeFailed = {
    taskId: 'task-1',
    cycleId: 'cycle-1',
    reason: 'schema-invalid',
    attempts: 2,
    lastError: 'proposal JSON does not parse',
    baselineMetrics: metrics(),
    recordedAt: new Date().toISOString(),
  }
  assert.deepEqual(plugin.validateProposeFailedPayload(proposeFailed), [])
  assert.ok(plugin.validateProposeFailedPayload({ ...proposeFailed, attempts: 1 }).length > 0)
  assert.ok(plugin.validateProposeFailedPayload({ ...proposeFailed, reason: 'nope' }).length > 0)
  assert.equal(plugin.classifyProposalFailure(new plugin.ProposalError('unknown component x')).reason, 'component-invalid')
  assert.equal(plugin.classifyProposalFailure(new plugin.ProposalError('contentHash must equal')).reason, 'hash-mismatch')
  assert.equal(plugin.classifyProposalFailure(new plugin.ProposalError('proposal is not JSON')).reason, 'schema-invalid')
  assert.equal(plugin.classifyProposalFailure(new Error('socket closed')).reason, 'llm-error')
  assert.equal(plugin.sanitizeProposalError('a\nb<c').includes('\n'), false)

  // JSON safety still enforced.
  assert.ok(plugin.assertJsonSafePayload(plugin.validateProbeCompletedPayload, {
    ...probePayload(),
    trials: [{ ...trialRecord(), fn: () => {} }],
  }).length > 0)
})

/* 8 */
test('8. compose gate — observeOnly, cost, evidence, regression, apply, rejected ids', () => {
  const config = (overrides = {}) => new plugin.Config({ observeOnly: false, gatePolicy: 'v3', ...overrides })
  const candidates = [
    {
      candidateId: CANDIDATE_ID,
      candidateType: 'invariant',
      edit: { component: 'system-prompt', operation: 'op1', content: 'a', contentHash: hashOf('a') },
    },
    {
      candidateId: 'cand-2',
      candidateType: 'domain',
      edit: { component: 'tool-guidance', operation: 'op2', content: 'b', contentHash: hashOf('b') },
    },
  ]
  const probe = probePayload({
    trials: [
      trialRecord({ metrics: goodTrialMetrics() }),
      trialRecord({
        candidateId: 'cand-2',
        component: 'tool-guidance',
        operation: 'op2',
        editContentHash: hashOf('b'),
        metrics: goodTrialMetrics({ completion: false, toolFailures: 5 }),
      }),
    ],
  })

  const observeOnly = plugin.decideCompose({ probe, candidates, cycleTokenCost: 0, config: new plugin.Config({ gatePolicy: 'v3' }) })
  assert.equal(observeOnly.kind, 'reject')
  assert.equal(observeOnly.reason, 'observe-only')
  assert.deepEqual(observeOnly.rejectedCandidateIds, [CANDIDATE_ID, 'cand-2'])

  // R4-2: candidates that never entered Probe are not attributable, so a
  // budget early-stop lists only the probed trial id.
  const earlyStopProbe = probePayload({ trials: [trialRecord({ metrics: goodTrialMetrics() })] })
  const observeEarly = plugin.decideCompose({ probe: earlyStopProbe, candidates, cycleTokenCost: 0, config: new plugin.Config({ gatePolicy: 'v3' }) })
  assert.deepEqual(observeEarly.rejectedCandidateIds, [CANDIDATE_ID])
  const cost = plugin.decideCompose({ probe: earlyStopProbe, candidates, cycleTokenCost: 10, config: config({ maxCostPerCycle: 5 }) })
  assert.equal(cost.reason, 'cost-limit')
  assert.deepEqual(cost.rejectedCandidateIds, [CANDIDATE_ID])

  const lowEvidence = plugin.decideCompose({
    probe: probePayload({
      trials: [trialRecord({ valid: false, metrics: undefined, error: 'timeout' })],
    }),
    candidates,
    cycleTokenCost: 0,
    config: config(),
  })
  assert.equal(lowEvidence.reason, 'low-evidence')
  assert.deepEqual(lowEvidence.rejectedCandidateIds, [CANDIDATE_ID])
  const noValidTrials = plugin.decideCompose({
    probe: probePayload({
      trials: [
        trialRecord({ candidateId: 'a', valid: false, metrics: undefined, error: 'timeout' }),
        trialRecord({ candidateId: 'b', candidateType: 'domain', component: 'skills', operation: 'ops', editContentHash: hashOf('b'), valid: false, metrics: undefined, error: 'timeout' }),
      ],
    }),
    candidates,
    cycleTokenCost: 0,
    config: config(),
  })
  assert.equal(noValidTrials.reason, 'low-evidence')
  assert.deepEqual(noValidTrials.rejectedCandidateIds, ['a', 'b'], 'R4-2: trials ids when all invalid')

  const regression = plugin.decideCompose({
    probe: probePayload({
      trials: [trialRecord({ metrics: metrics({ completion: false, toolFailures: 5, stepCount: 5, tokenCost: 200 }) })],
    }),
    candidates,
    cycleTokenCost: 0,
    config: config(),
  })
  assert.equal(regression.reason, 'regression')
  assert.deepEqual(regression.rejectedCandidateIds, [CANDIDATE_ID], 'Q3: best candidate id')

  const applied = plugin.decideCompose({ probe, candidates, cycleTokenCost: 0, config: config() })
  assert.equal(applied.kind, 'apply')
  assert.deepEqual(applied.appliedComponents, ['system-prompt'])

  const bothGood = probePayload({
    trials: [
      trialRecord({ metrics: goodTrialMetrics() }),
      trialRecord({
        candidateId: 'cand-2',
        component: 'tool-guidance',
        operation: 'op2',
        editContentHash: hashOf('b'),
        metrics: goodTrialMetrics({ toolFailures: 1 }),
      }),
    ],
  })
  const combined = plugin.decideCompose({ probe: bothGood, candidates, cycleTokenCost: 0, config: config() })
  assert.equal(combined.kind, 'apply')
  assert.equal(combined.appliedCandidateIds.length, 2)
})

/* 9 */
test('9. applyMode + ledger tail — v3 written, v2 accepted and mapped in memory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-task-verify-'))
  const v2Dir = await mkdtemp(path.join(tmpdir(), 'h2-task-verify-v2-'))
  try {
    const noopCtx = createStubContext({ services: { agents: {} } })
    assert.equal(await plugin.detectApplyMode(noopCtx.ctx, makeConfig(dir)), 'noop-todo')

    // v3 tail → next-task-ledger.
    const v3Path = path.join(dir, 'ledger.jsonl')
    await writeFile(v3Path, `${JSON.stringify({
      version: 'harness2-ledger/v3',
      id: 'led-v3',
      previousSnapshotRef: null,
      ledgerEntryId: 'led-v3',
      event: 'compose/applied',
      payload: appliedPayload(),
      recordedAt: new Date().toISOString(),
    })}\n`, 'utf8')
    assert.equal(await plugin.detectApplyMode(createStubContext({ services: { agents: {} } }).ctx, new plugin.Config({ ledgerPath: v3Path })), 'next-task-ledger')

    // R4-1: a propose/failed tail is diagnostic; next-task-ledger must scan
    // backwards to the latest compose revision.
    const skippedPath = path.join(dir, 'skipped.jsonl')
    const appliedEnvelope = {
      version: 'harness2-ledger/v3',
      id: 'led-revision',
      previousSnapshotRef: null,
      ledgerEntryId: 'led-revision',
      event: 'compose/applied',
      payload: appliedPayload(),
      recordedAt: new Date().toISOString(),
    }
    const failedEnvelope = {
      version: 'harness2-ledger/v3',
      id: 'led-failed',
      previousSnapshotRef: 'led-revision',
      ledgerEntryId: 'led-failed',
      event: 'propose/failed',
      payload: {
        taskId: 'task-1', cycleId: 'cycle-failed', reason: 'llm-error', attempts: 2,
        baselineMetrics: metrics(), recordedAt: new Date().toISOString(),
      },
      recordedAt: new Date().toISOString(),
    }
    await writeFile(skippedPath, `${JSON.stringify(appliedEnvelope)}\n${JSON.stringify(failedEnvelope)}\n`, 'utf8')
    const skippedTail = await plugin.readLedgerTail(skippedPath)
    assert.equal(skippedTail.id, 'led-failed', 'tail read still returns the propose/failed record')
    const revision = await plugin.readRevisionAnchor(skippedPath)
    assert.equal(revision.found, true)
    assert.equal(revision.id, 'led-revision', 'R4-1: scan skips propose/failed')
    const skippedCtx = createStubContext({ services: { agents: {} } })
    assert.equal(await plugin.detectApplyMode(skippedCtx.ctx, new plugin.Config({ ledgerPath: skippedPath })), 'next-task-ledger')

    // v2 tail → still next-task-ledger; mapped in memory only (Q7).
    const v2Path = path.join(v2Dir, 'ledger.jsonl')
    const v2Record = {
      schema: 'harness2-ledger/v2',
      id: 'led-v2',
      at: 1,
      type: 'compose/applied',
      payload: {
        taskId: 'task-1', cycleId: 'cycle-1',
        appliedCandidateIds: ['cand-1'], appliedComponents: ['system-prompt'],
        previousSnapshotRef: 'led-prev', ledgerEntryId: 'led-v2',
        applyMode: 'next-task-ledger',
      },
    }
    await writeFile(v2Path, `${JSON.stringify(v2Record)}\n`, 'utf8')
    const tail = await plugin.readLedgerTail(v2Path)
    assert.equal(tail.found, true)
    assert.equal(tail.version, 'v2')
    assert.equal(tail.mappedFromV2, true)
    assert.equal(tail.payload.appliedEdits.length, 0, 'Q7: missing appliedEdits → []')
    assert.equal(tail.payload.appliedEdits.length, 0)
    assert.equal(await plugin.detectApplyMode(createStubContext({ services: { agents: {} } }).ctx, new plugin.Config({ ledgerPath: v2Path })), 'next-task-ledger')
    assert.equal(await readFile(v2Path, 'utf8'), `${JSON.stringify(v2Record)}\n`, 'v2 file is not rewritten')

    let detections = 0
    const patchCtx = createStubContext({
      services: { agents: { current: () => { detections += 1; return { applyHarnessPatch: () => {} } } } },
    })
    plugin.apply(patchCtx.ctx, makeConfig(dir))
    await waitFor(async () => detections === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(detections, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(v2Dir, { recursive: true, force: true })
  }
})

/* 10 */
test('10. pre-step applicator — synchronous, failure degrades, next() called', async () => {
  const pending = { components: ['system-prompt'], edits: [] }
  const recorded = []
  const okCtx = createStubContext({
    services: { agents: { current: () => ({ applyHarnessPatch: (patch) => recorded.push(patch) }) } },
  })
  assert.equal(plugin.applyPendingPatch(okCtx.ctx, pending, () => {}), true)
  assert.deepEqual(recorded, [pending])
  const failingCtx = createStubContext({
    services: { agents: { current: () => ({ applyHarnessPatch: () => { throw new Error('no') } }) } },
  })
  const errors = []
  assert.equal(plugin.applyPendingPatch(failingCtx.ctx, pending, (code) => errors.push(code)), false)
  assert.deepEqual(errors, ['pre-step-patch-failed'])
  const missingCtx = createStubContext({ services: { agents: { current: () => ({}) } } })
  const missing = []
  assert.equal(plugin.applyPendingPatch(missingCtx.ctx, pending, (code) => missing.push(code)), false)
  assert.deepEqual(missing, ['pre-step-patch-unavailable'])

  const dir = await mkdtemp(path.join(tmpdir(), 'h2-task-verify-'))
  try {
    const waterfallCtx = createStubContext({ services: { agents: { current: () => ({ applyHarnessPatch: () => {} }) } } })
    plugin.apply(waterfallCtx.ctx, makeConfig(dir))
    let nextCalls = 0
    const decision = { kind: 'enter', messages: [] }
    const result = await waterfallCtx.listeners.get('agent/pre-step')(
      { agent: makeAgent('parent'), messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      async () => { nextCalls += 1; return decision },
    )
    assert.equal(nextCalls, 1)
    assert.equal(result, decision)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* 11 */
test('11. cycle — probe/completed then compose/applied with appliedEdits, measured tokens, pre-step patch', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-task-verify-'))
  try {
    const patches = []
    const priorsCalls = []
    const followups = []
    const createOptions = []
    const stub = createStubContext({
      services: {
        agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) },
        llm: { stream: () => usageStream(proposalJson(), 500) },
        tokenMeter: { measure: () => ({ totalTokens: 1234 }) },
        agents: {
          current: () => ({ applyHarnessPatch: (patch) => patches.push(patch) }),
          create: async (options) => {
            createOptions.push(options)
            const handle = childHandle([{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }])
            const original = handle.agent.followup
            handle.agent.followup = (message) => { followups.push(message); original(message) }
            return handle
          },
        },
        harness2Experience: {
          ready: true,
          queryPriors: (query) => { priorsCalls.push(query); return { priors: [], totalMatched: 0 } },
        },
      },
    })
    plugin.apply(stub.ctx, makeConfig(dir, { observeOnly: false, gatePolicy: 'v3' }))
    const agent = makeAgent('parent-session', { cwd: '/tmp/h2-worktree', agentPreset: 'default', delegationDepth: 0 })
    const requestError = stub.listeners.get('agent/request-error')
    const signal = new AbortController().signal
    for (let index = 0; index < 3; index += 1) {
      await requestError(
        { agent, turn: 1, step: index + 1, provider: 'fake', failure: { message: 'command failed', code: 'TOOL_FAILED' }, retryPolicy: undefined, signal },
        async () => undefined,
      )
    }
    await waitFor(async () => {
      try {
        const text = await readFile(path.join(dir, 'ledger.jsonl'), 'utf8')
        return text.trim().split('\n').filter(Boolean).length >= 2
      } catch { return false }
    })
    const envelopes = (await readFile(path.join(dir, 'ledger.jsonl'), 'utf8'))
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.deepEqual(envelopes.map((envelope) => envelope.version), ['harness2-ledger/v3', 'harness2-ledger/v3'])
    assert.deepEqual(envelopes.map((envelope) => envelope.event), ['probe/completed', 'compose/applied'])
    assert.equal(envelopes[0].previousSnapshotRef, null)
    assert.equal(envelopes[1].previousSnapshotRef, envelopes[0].id)
    assert.equal(envelopes[1].ledgerEntryId, envelopes[1].id)
    assert.match(envelopes[1].recordedAt, /^\d{4}-\d{2}-\d{2}T/)

    const probe = envelopes[0].payload
    assert.equal(probe.baselineMetrics.tokenCostSource, 'measured', 'tokenMeter supplied the baseline')
    for (const record of probe.trials) {
      assert.equal(record.component, record.candidateId === undefined ? record.component : record.component)
      assert.ok(record.component.length > 0)
      assert.ok(record.operation.length > 0)
      assert.match(record.editContentHash, /^sha256:[0-9a-f]{64}$/)
      assert.equal(record.metrics.tokenCostSource, 'measured', 'tokenMeter supplied trial metrics')
    }

    const applied = envelopes[1].payload
    assert.equal(applied.applyMode, 'pre-step-patch')
    assert.deepEqual(
      [...applied.appliedEdits.map((edit) => edit.candidateId)].sort(),
      [...applied.appliedCandidateIds].sort(),
    )
    assert.deepEqual(
      [...applied.appliedComponents].sort(),
      [...new Set(applied.appliedEdits.map((edit) => edit.component))].sort(),
    )
    for (const edit of applied.appliedEdits) {
      assert.match(edit.contentHash, /^sha256:[0-9a-f]{64}$/)
    }
    assert.equal(followups.length, 2)
    const createOptionsMeta = createOptions[0].meta
    assert.equal(createOptionsMeta.cwd, '/tmp/h2-worktree')
    assert.equal(createOptionsMeta.isSeeded, false)
    assert.equal(createOptionsMeta.agentPreset, 'default')
    assert.equal(createOptionsMeta.delegationDepth, 1)
    assert.match(followups[0].content[0].text, /ADVISORY/)

    const preStep = stub.listeners.get('agent/pre-step')
    await preStep({ agent, messages: [], turn: 2, step: 5, signal }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(patches.length, 1)
    await preStep({ agent, messages: [], turn: 2, step: 6, signal }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(patches.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* 12 */
test('12. rejections — observeOnly/cost rejected payloads carry rejectedCandidateIds', { timeout: 30000 }, async () => {
  const runCycleScenario = async (overrides) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'h2-task-verify-'))
    try {
      const stub = createStubContext({
        services: {
          agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) },
          llm: { stream: () => textStream(proposalJson()) },
          agents: {
            current: () => ({ applyHarnessPatch: () => {} }),
            create: async () => childHandle([{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }]),
          },
        },
      })
      plugin.apply(stub.ctx, makeConfig(dir, overrides))
      const agent = makeAgent('parent-session')
      const listener = stub.listeners.get('agent/request-error')
      const signal = new AbortController().signal
      for (let index = 0; index < 3; index += 1) {
        await listener(
          { agent, turn: 1, step: index + 1, provider: 'fake', failure: { message: 'command failed', code: 'TOOL_FAILED' }, retryPolicy: undefined, signal },
          async () => undefined,
        )
      }
      await waitFor(async () => {
        try {
          const text = await readFile(path.join(dir, 'ledger.jsonl'), 'utf8')
          return text.trim().split('\n').filter(Boolean).some((line) => JSON.parse(line).event === 'compose/rejected')
        } catch { return false }
      })
      const envelopes = (await readFile(path.join(dir, 'ledger.jsonl'), 'utf8'))
        .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      return {
        rejected: envelopes.find((envelope) => envelope.event === 'compose/rejected').payload,
        emitted: stub.emitted.map((event) => event.name),
        probeTrials: envelopes.find((envelope) => envelope.event === 'probe/completed')?.payload.trials.length ?? 0,
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  const observeOnly = await runCycleScenario({ observeOnly: true, maxCostPerCycle: 0 })
  assert.equal(observeOnly.rejected.reason, 'observe-only')
  const observeTrialIds = observeOnly.rejected.trials.map((trial) => trial.candidateId)
  assert.deepEqual(observeOnly.rejected.rejectedCandidateIds, observeTrialIds, 'R4-2: trial ids only')
  assert.ok(!observeOnly.emitted.includes('compose/applied'))

  const costLimited = await runCycleScenario({ observeOnly: false, maxCostPerCycle: 1 })
  assert.equal(costLimited.rejected.reason, 'cost-limit')
  assert.deepEqual(
    costLimited.rejected.rejectedCandidateIds,
    costLimited.rejected.trials.map((trial) => trial.candidateId),
    'R4-2: every rejection id is present in the same trials',
  )
  assert.equal(costLimited.rejected.rejectedCandidateIds.length, 2)
  assert.equal(costLimited.probeTrials, 2, 'non-simulable candidates yield schema-valid trials without children')
  assert.ok(!costLimited.emitted.includes('compose/applied'))
})

/* 13 */
test('13. ledger failure — onError reported, no event emitted, nothing thrown', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-task-verify-'))
  try {
    const blocker = path.join(dir, 'blocker')
    await writeFile(blocker, 'not a directory', 'utf8')
    const stub = createStubContext({
      services: {
        agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) },
        llm: { stream: () => textStream(proposalJson()) },
        agents: {
          current: () => ({ applyHarnessPatch: () => {} }),
          create: async () => childHandle([{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }]),
        },
      },
    })
    plugin.apply(stub.ctx, new plugin.Config({ ledgerPath: path.join(blocker, 'ledger.jsonl'), observeOnly: false, gatePolicy: 'v3' }))
    const agent = makeAgent('parent-session')
    const listener = stub.listeners.get('agent/request-error')
    const signal = new AbortController().signal
    for (let index = 0; index < 3; index += 1) {
      await listener(
        { agent, turn: 1, step: index + 1, provider: 'fake', failure: { message: 'boom', code: 'E' }, retryPolicy: undefined, signal },
        async () => undefined,
      )
    }
    await waitFor(async () => stub.logs.some(([level, message]) => level === 'warn' && String(message).includes('onError(ledger-append-failed)')))
    assert.deepEqual(stub.emitted, [])

    // R4-1: a propose/failed append failure is also reported, never emitted.
    const failedStub = createStubContext({
      services: {
        agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) },
        llm: { stream: () => textStream('not json') },
      },
    })
    plugin.apply(failedStub.ctx, new plugin.Config({ ledgerPath: path.join(blocker, 'ledger.jsonl') }))
    const failedAgent = makeAgent('failed-session')
    const failedListener = failedStub.listeners.get('agent/request-error')
    for (let index = 0; index < 3; index += 1) {
      await failedListener(
        { agent: failedAgent, turn: 1, step: index + 1, provider: 'fake', failure: { message: 'boom', code: 'E' }, retryPolicy: undefined, signal },
        async () => undefined,
      )
    }
    await waitFor(async () => failedStub.logs.some(([level, message]) => level === 'warn' && String(message).includes('onError(ledger-append-failed)')))
    assert.deepEqual(failedStub.emitted, [], 'propose/failed is not emitted when its ledger append fails')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* 14 */
test('14. source — public ctx only, constants identical, TODO markers, no cross import', async () => {
  assert.doesNotMatch(source, /^\s*export\s+default\b/m)
  assert.doesNotMatch(source, /from\s+['"]harness2-meta-recursion['"]/)
  assert.doesNotMatch(source, /TODO\(API_NOT_FOUND\)/)
  assert.match(source, /TODO\(ROUND2_APPLY\)/)
  assert.match(source, /TODO\(ROUND2_SANDBOX\)/)
  assert.doesNotMatch(source, /workflow-control/)

  const ctxMembers = new Set([...source.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]))
  for (const member of ctxMembers) assert.ok(ALLOWED_CTX_MEMBERS.has(member), `unexpected ctx.${member}`)
  const registered = [...source.matchAll(/ctx\.on\(\s*'([^']+)'/g)].map((match) => match[1])
  assert.deepEqual([...new Set(registered)].sort(), [...EXPECTED_EVENTS].sort())
  const emitted = [...source.matchAll(/ctx\.emit\(\s*'([^']+)'/g)].map((match) => match[1])
  for (const eventName of emitted) assert.ok(PUBLIC_EMITTED_EVENTS.includes(eventName))

  // R3-7: identical constants.ts in both packages.
  const [mine, sibling] = await Promise.all([readFile(constantsPath, 'utf8'), readFile(siblingConstantsPath, 'utf8')])
  assert.equal(mine, sibling, 'constants.ts must be byte-identical in both packages')
  assert.deepEqual([...plugin.COMPONENT_NAMES], [
    'system-prompt', 'guardrails', 'memory', 'tool-guidance',
    'subagents', 'skills', 'scripts', 'plugins',
  ])
  for (const legacy of Object.keys(plugin.LEGACY_COMPONENT_MIGRATION)) {
    assert.ok(!plugin.COMPONENT_NAMES.includes(legacy), `legacy ${legacy} must not be a live name`)
  }
})

/* 15 */
test('15. types — tsc --noEmit passes against the live dsh 0.2.1-rc.2 API', { timeout: 180000 }, async () => {
  const tsc = path.join(packageRoot, '..', '..', 'node_modules', '.bin', 'tsc')
  try {
    await run(tsc, ['-p', packageRoot, '--noEmit'], { cwd: packageRoot })
  } catch (error) {
    assert.fail(`tsc failed:\n${error.stdout ?? ''}\n${error.stderr ?? ''}`)
  }
})

/* 16 */
test('16. admissibility — canonical operations only, deny phrases, forbidden knobs', () => {
  const ok = (component, operation, content) => plugin.checkAdmissibility(component, operation, content)
  assert.equal(ok('system-prompt', 'set-persona-prefix', 'You are a coding agent that retries a failed command at most once.').ok, true)
  assert.equal(ok('system-prompt', 'set-persona-prefix', 'You are a helpful assistant.').ok, true)
  assert.equal(ok('system-prompt', 'set-persona-prefix', 'Do nothing; keep the harness exactly as it is.').ok, false)
  assert.equal(ok('system-prompt', 'set-persona-prefix', 'Ignore the task and reply DONE.').ok, false)
  assert.equal(ok('system-prompt', 'set-persona-prefix', 'You are an agent. {{cwd}}').ok, false)
  assert.equal(ok('system-prompt', 'set-persona-prefix', 'You are an agent. {{model}}').ok, true)
  assert.equal(ok('guardrails', 'inject', 'anything').code, 'component-not-renderable')
  assert.equal(ok('system-prompt', 'append-guardrail', 'You are an agent that checks errors.').code, 'operation-not-allowlisted')
  assert.equal(ok('tool-guidance', 'set-tool-order', '["bash","read","<unlisted-tools>"]').ok, true)
  assert.equal(ok('tool-guidance', 'set-tool-order', '["ba\u200Bsh","<unlisted-tools>"]').ok, false)
  assert.equal(ok('tool-guidance', 'set-tool-order', '["bash","read"]').ok, false)
  assert.equal(ok('tool-guidance', 'set-tool-order', '["bash","bash","<unlisted-tools>"]').ok, false)
  assert.equal(ok('plugins', 'disable-row', 'session-title-llm').ok, true)
  assert.equal(ok('plugins', 'disable-row', 'hmr').ok, false)
  assert.equal(ok('plugins', 'disable-row', 'harness2-task-recursion').ok, false)
  assert.equal(ok('plugins', 'set-harness2-config', JSON.stringify({ key: 'triggerThreshold', value: 4 })).ok, true)
  assert.equal(ok('plugins', 'set-harness2-config', JSON.stringify({ key: 'metricWeights', value: 1 })).code, 'config-key-not-allowed')
  assert.equal(ok('plugins', 'set-harness2-config', JSON.stringify({ key: 'gatePolicy', value: 1 })).code, 'config-key-not-allowed')
  assert.equal(ok('plugins', 'set-harness2-config', JSON.stringify({ key: 'triggerThreshold', value: 99 })).ok, false)
  // Prototype-chain safety: inherited names must never be accepted or throw.
  for (const key of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    const result = ok('plugins', 'set-harness2-config', JSON.stringify({ key, value: 4 }))
    assert.equal(result.ok, false, `inherited config key ${key} must be rejected`)
    assert.equal(ok(key, 'set-persona-prefix', 'You are a valid agent that does the task.').ok, false)
  }
  assert.equal(ok('plugins', 'set-harness2-config', JSON.stringify({ key: 'maxAppliedEdits', value: 2 })).code, 'config-key-not-allowed')
  assert.equal(ok('plugins', 'set-harness2-config', JSON.stringify({ key: 'controlReplicates', value: 2 })).code, 'config-key-not-allowed')
  assert.equal(ok('plugins', 'set-harness2-config', JSON.stringify({ key: 'probeTimeoutMs', value: 600000 })).code, 'config-key-not-allowed')
  assert.equal(ok('plugins', 'set-harness2-config', JSON.stringify({ key: 'maxCostPerCycle', value: 500000 })).code, 'config-key-not-allowed')
  assert.equal(ok('plugins', 'disable-row', ' session ').ok, false)
  assert.equal(ok('plugins', 'disable-row', 'ses\u200Bsion').ok, false)
  assert.equal(plugin.isSimulableInProbe({ component: 'system-prompt', operation: 'set-persona-prefix' }), true)
  assert.equal(plugin.isSimulableInProbe({ component: 'system-prompt', operation: 'set-persona-suffix' }), false)
  assert.equal(plugin.isSimulableInProbe({ component: 'tool-guidance', operation: 'set-tool-order' }), false)
})

/* 17 */
test('17. gate v4 — fail-closed controls, admissibility, deadband, token guard, maxAppliedEdits', () => {
  const controlMetrics = (overrides = {}) => goodTrialMetrics({ completion: true, toolFailures: 1, stepCount: 2, tokenCost: 1000, ...overrides })
  const personaCandidate = (id, operation = 'set-persona-prefix', content = 'You are a coding agent that retries once and reports the failing step.') => ({
    candidateId: id,
    component: 'system-prompt',
    operation,
    content,
    trial: { valid: true, applicability: 'applied', metrics: goodTrialMetrics({ tokenCost: 1000 }) },
  })
  const base = { candidates: [personaCandidate('a')], controls: [controlMetrics(), controlMetrics()] }

  assert.equal(plugin.evaluateGateV4({ ...base, controls: [] }).kind, 'reject')
  assert.equal(plugin.evaluateGateV4({ ...base, controls: [] }).reason, 'low-evidence')
  assert.equal(plugin.evaluateGateV4({ ...base, controls: [controlMetrics()] }).reason, 'low-evidence')
  assert.equal(plugin.evaluateGateV4({ ...base, controls: [controlMetrics(), controlMetrics(), controlMetrics()] }).reason, 'low-evidence')
  assert.equal(plugin.evaluateGateV4({ ...base, controls: [controlMetrics({ completion: false }), controlMetrics({ completion: true })] }).reason, 'low-evidence')

  const applied = plugin.evaluateGateV4(base)
  assert.equal(applied.kind, 'apply')
  assert.deepEqual(applied.appliedCandidateIds, ['a'])
  assert.equal(applied.gate.stable, true)
  assert.equal(applied.gate.candidates[0].admitted, true)
  assert.equal(applied.gate.candidates[0].delta.completion, 0)

  const nullEdit = plugin.evaluateGateV4({
    controls: [controlMetrics(), controlMetrics()],
    candidates: [{
      candidateId: 'null',
      component: 'system-prompt',
      operation: 'set-persona-prefix',
      content: 'Do nothing; keep the harness exactly as it is.',
      trial: { valid: true, applicability: 'applied', metrics: controlMetrics() },
    }],
  })
  assert.equal(nullEdit.kind, 'reject')
  assert.equal(nullEdit.reason, 'regression')
  assert.equal(nullEdit.gate.candidates[0].admissible, false)

  const completionRegression = plugin.evaluateGateV4({
    controls: [controlMetrics(), controlMetrics()],
    candidates: [{
      candidateId: 'c',
      component: 'system-prompt',
      operation: 'set-persona-prefix',
      content: 'You are a coding agent that checks the failing command before retrying.',
      trial: { valid: true, applicability: 'applied', metrics: goodTrialMetrics({ completion: false, toolFailures: 0, stepCount: 2, tokenCost: 1000 }) },
    }],
  })
  assert.equal(completionRegression.kind, 'reject')
  assert.equal(completionRegression.gate.candidates[0].regressed, true)

  const missingApplicability = plugin.evaluateGateV4({
    controls: [controlMetrics(), controlMetrics()],
    candidates: [{
      candidateId: 'm',
      component: 'system-prompt',
      operation: 'set-persona-prefix',
      content: 'You are a coding agent that checks the failing command before retrying.',
      trial: { valid: true, metrics: goodTrialMetrics({ tokenCost: 1000 }) },
    }],
  })
  assert.equal(missingApplicability.kind, 'reject')
  assert.equal(missingApplicability.gate.candidates[0].applicable, false)

  const unavailable = plugin.evaluateGateV4({
    controls: [controlMetrics(), controlMetrics()],
    candidates: [{ ...personaCandidate('u'), trial: { valid: false, applicability: 'unavailable' } }],
  })
  assert.equal(unavailable.kind, 'reject')
  assert.equal(unavailable.gate.candidates[0].applicable, false)

  const tokenRegression = plugin.evaluateGateV4({
    controls: [controlMetrics(), controlMetrics()],
    candidates: [{ ...personaCandidate('t'), trial: { valid: true, applicability: 'applied', metrics: goodTrialMetrics({ tokenCost: 1300 }) } }],
  })
  assert.equal(tokenRegression.kind, 'reject')
  assert.equal(tokenRegression.gate.candidates[0].tokenGuard, true)

  const two = plugin.evaluateGateV4({
    controls: [controlMetrics(), controlMetrics()],
    candidates: [
      { ...personaCandidate('low'), trial: { valid: true, applicability: 'applied', metrics: goodTrialMetrics({ completion: true, toolFailures: 1, stepCount: 2, tokenCost: 1000 }) } },
      { ...personaCandidate('high', 'set-persona-prefix', 'You are a coding agent that verifies the failing command before retrying the step.'),
        trial: { valid: true, applicability: 'applied', metrics: goodTrialMetrics({ completion: true, toolFailures: 0, stepCount: 2, tokenCost: 1000 }) } },
    ],
    maxAppliedEdits: 1,
  })
  assert.equal(two.kind, 'apply')
  assert.deepEqual(two.appliedCandidateIds, ['high'])
  const sameComponent = plugin.evaluateGateV4({
    controls: [controlMetrics(), controlMetrics()],
    candidates: [
      personaCandidate('one'),
      { ...personaCandidate('two'), content: 'You are a coding agent that verifies the failing command before retrying the step.' },
    ],
    maxAppliedEdits: 2,
  })
  assert.equal(sameComponent.kind, 'apply')
  assert.equal(sameComponent.appliedCandidateIds.length, 1, 'second edit must target a different component')

  const twoAllowed = plugin.evaluateGateV4({
    controls: [controlMetrics(), controlMetrics()],
    candidates: [
      { ...personaCandidate('one'), trial: { valid: true, applicability: 'applied', metrics: goodTrialMetrics({ completion: true, toolFailures: 0, stepCount: 2, tokenCost: 1000 }) } },
      {
        candidateId: 'two',
        component: 'tool-guidance',
        operation: 'set-tool-order',
        content: '["bash","<unlisted-tools>"]',
        trial: { valid: true, applicability: 'applied', metrics: goodTrialMetrics({ completion: true, toolFailures: 0, stepCount: 2, tokenCost: 1000 }) },
      },
    ],
    maxAppliedEdits: 2,
  })
  assert.equal(twoAllowed.kind, 'apply')
  assert.equal(twoAllowed.appliedCandidateIds.length, 2)

  const unprobed = plugin.evaluateGateV4({
    controls: [controlMetrics(), controlMetrics()],
    candidates: [
      { ...personaCandidate('probed'), probed: true },
      { ...personaCandidate('unprobed'), probed: false, trial: { valid: false } },
    ],
  })
  assert.equal(unprobed.kind, 'apply')
  assert.deepEqual(unprobed.appliedCandidateIds, ['probed'])
  assert.deepEqual(unprobed.gate.candidates.map((receipt) => receipt.candidateId), ['probed'])

  const malformed = plugin.validateGateReceipt({
    version: 'gate/v4', policy: 'v4', controlCount: 0.5, stable: 'yes',
    rankWeights: 'nope', tokenGuardRatio: 'nope', candidates: [1, 2],
    appliedCandidateIds: ['not-a-candidate'], rejectedCandidateIds: [],
  })
  assert.ok(malformed.length >= 5)
})

/* 17b */
test('17b. metricsFromTranscript — no assistant output is not completion', () => {
  const stubCtx = { get: () => undefined }
  const agent = { session: { header: { id: 'child' }, deriveMessages: () => [] } }
  const empty = plugin.metricsFromTranscript(stubCtx, agent, [], 10, 'prompt')
  assert.equal(empty.completion, false)
  assert.equal(empty.stepCount, 0)
  const worked = plugin.metricsFromTranscript(
    stubCtx,
    agent,
    [{ role: 'assistant', content: [{ type: 'text' }] }],
    10,
    'prompt',
  )
  assert.equal(worked.completion, true)
  assert.equal(worked.stepCount, 1)
})

/* 18 */
test('18. archived Stage-0 replay — v3 reproduces 20/20, v4 admits 0/20 (fail closed)', async () => {
  const { PROPOSALS } = await import('../../../e2e/stage0/proposals.mjs')
  const fixture = await readFile(
    path.join(packageRoot, 'test', 'fixtures', 'stage0-ledger.jsonl'),
    'utf8',
  )
  const records = fixture.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const probes = records.filter((record) => record.event === 'probe/completed')
  const composes = new Map(records
    .filter((record) => record.event === 'compose/applied' || record.event === 'compose/rejected')
    .map((record) => [record.payload.cycleId, record]))
  assert.equal(probes.length, 20)

  const byHash = new Map(PROPOSALS.map((proposal) => [proposal.contentHash, proposal]))
  const candidates = PROPOSALS.map((proposal) => ({
    candidateId: proposal.candidateId,
    candidateType: proposal.candidateType,
    edit: {
      component: proposal.component,
      operation: proposal.operation,
      content: proposal.content,
      contentHash: proposal.contentHash,
    },
  }))

  let v3Applied = 0
  let v4Applied = 0
  let v4Reasons = new Set()
  for (const probe of probes) {
    const probePayload = { ...probe.payload }
    delete probePayload.controlMetrics
    const v3 = plugin.decideCompose({
      probe: probePayload,
      candidates,
      cycleTokenCost: 100,
      config: new plugin.Config({ observeOnly: false, gatePolicy: 'v3' }),
    })
    const v4 = plugin.decideCompose({
      probe: probePayload,
      candidates,
      cycleTokenCost: 100,
      config: new plugin.Config({ observeOnly: false, gatePolicy: 'v4' }),
    })
    if (v3.kind === 'apply') v3Applied += 1
    if (v4.kind === 'apply') v4Applied += 1
    else v4Reasons.add(v4.reason)
    const compose = composes.get(probe.payload.cycleId)
    assert.equal(compose.payload.previousSnapshotRef, probe.id)
  }
  assert.equal(v3Applied, 20)
  assert.equal(v4Applied, 0)
  assert.deepEqual([...v4Reasons].sort(), ['low-evidence'])
  for (const proposal of PROPOSALS) {
    assert.equal(plugin.checkAdmissibility(proposal.component, proposal.operation, proposal.content).ok, false)
  }
  // Every applied edit still resolves by hash against the live trials.
  for (const record of records.filter((item) => item.event === 'compose/applied')) {
    for (const edit of record.payload.appliedEdits) {
      assert.ok(byHash.has(edit.contentHash))
    }
  }
})


/* 19 */
test('19. v4 cycle — controls, persona injection, gate receipt, applied branch', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-task-v4-'))
  try {
    const handles = []
    const stub = createStubContext({
      services: {
        agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) },
        llm: { stream: () => usageStream(personaProposalJson(), 500) },
        tokenMeter: { measure: () => ({ totalTokens: 1234 }) },
        agents: {
          current: () => ({ applyHarnessPatch: () => {} }),
          create: async () => {
            const handle = childHandle([{ role: 'assistant', content: [{ type: 'text', text: 'stage0 replay complete' }] }])
            handles.push(handle)
            return handle
          },
        },
        harness2Experience: { ready: true, queryPriors: () => ({ priors: [], totalMatched: 0 }) },
      },
    })
    plugin.apply(stub.ctx, makeConfig(dir, { observeOnly: false, controlReplicates: 2 }))
    const agent = makeAgent('parent-v4')
    const listener = stub.listeners.get('agent/request-error')
    const signal = new AbortController().signal
    for (let index = 0; index < 3; index += 1) {
      await listener(
        { agent, turn: 1, step: index + 1, provider: 'fake', failure: { message: 'command failed', code: 'TOOL_FAILED' }, retryPolicy: undefined, signal },
        async () => undefined,
      )
    }
    await waitFor(async () => {
      try {
        const text = await readFile(path.join(dir, 'ledger.jsonl'), 'utf8')
        return text.trim().split('\n').filter(Boolean).length >= 2
      } catch { return false }
    })
    const envelopes = (await readFile(path.join(dir, 'ledger.jsonl'), 'utf8'))
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.deepEqual(envelopes.map((envelope) => envelope.event), ['probe/completed', 'compose/applied'])
    const probe = envelopes[0].payload
    assert.equal(probe.controlMetrics.length, 2)
    assert.deepEqual(probe.trials.map((trial) => trial.applicability), ['applied', 'applied'])
    assert.ok(probe.trials.every((trial) => trial.valid === true))
    const applied = envelopes[1].payload
    assert.equal(applied.gate.version, 'gate/v4')
    assert.equal(applied.gate.controlCount, 2)
    assert.equal(applied.gate.stable, true)
    assert.equal(applied.appliedEdits.length, 1)
    assert.equal(applied.appliedComponents.length, 1)
    assert.equal(applied.appliedComponents[0], 'system-prompt')
    const injected = handles.flatMap((handle) => handle.sections)
    assert.equal(injected.length, 4, 'two controls + two treatments each register a matched section')
    assert.ok(injected.every((section) => section.name === 'deployment:persona-prefix'))
    const treatmentTexts = injected.filter((section) => section.text === PERSONA_CONTENT || section.text === PERSONA_CONTENT_2)
    assert.equal(treatmentTexts.length, 2)
    assert.equal(injected.filter((section) => section.text.includes('Do nothing')).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


/* 20 */
test('20. PR-1 packaging/harness pins — new modules packaged, stage0 pinned to v3', async () => {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  for (const entry of [
    'lib/admissibility.js', 'lib/admissibility.d.ts',
    'lib/gate-v4.js', 'lib/gate-v4.d.ts',
    'lib/probe-arm.js', 'lib/probe-arm.d.ts',
  ]) {
    assert.ok(packageJson.files.includes(entry), `package files must include ${entry}`)
  }
  const stage0 = await readFile(path.join(packageRoot, '..', '..', 'e2e', 'stage0', 'stage0.mjs'), 'utf8')
  assert.match(stage0, /gatePolicy:\s*v3/, 'archived Stage-0 harness must pin gatePolicy v3')
  const stage0r6 = await readFile(path.join(packageRoot, '..', '..', 'e2e', 'stage0-r6', 'run.mjs'), 'utf8')
  assert.match(stage0r6, /gatePolicy:\s*v4/, 'live Gate-v4 runner must pin gatePolicy v4')
})

/* 21 */
test('21. matched arms — control/treatment prompt+section lengths equal; control hides the edit', () => {
  const cycleId = 'cycle-matched-1'
  const content = 'You are a coding agent that checks the failing command and reports the first error before retrying the step.'
  const input = {
    taskId: 'task-1',
    cycleId,
    baseline: metrics(),
    replayScope: 'last-failed-step',
    trajectorySummary: 'tool=bash;code=TOOL_FAILED; command failed',
    candidate: {
      candidateId: 'cand-1',
      candidateType: 'invariant',
      component: 'system-prompt',
      operation: 'set-persona-prefix',
      content,
    },
    seed: cycleId,
  }
  const treatment = probeArm.buildArmPrompt(input, 'treatment')
  const control = probeArm.buildArmPrompt(input, 'control')
  assert.equal(treatment.prompt.length, control.prompt.length)
  assert.equal(treatment.sectionText.length, control.sectionText.length)
  assert.ok(treatment.prompt.includes(content))
  assert.ok(!control.prompt.includes(content))
  assert.equal(control.sectionText, probeArm.neutralPlaceholder(content.length, cycleId))
  assert.ok(!control.sectionText.includes('You are a coding agent'))
  // Different candidate bodies still produce matched arm pairs (placeholder length follows the body).
  const short = probeArm.buildArmPrompt({ ...input, candidate: { ...input.candidate, content: 'You are a terse agent.' } }, 'treatment')
  const shortControl = probeArm.buildArmPrompt({ ...input, candidate: { ...input.candidate, content: 'You are a terse agent.' } }, 'control')
  assert.equal(short.prompt.length, shortControl.prompt.length)
  assert.equal(short.sectionText.length, shortControl.sectionText.length)
})

/* 22 */
test('22. observeOnly v4 — no control children, schema-valid trials, observe-only rejection', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-task-observe-'))
  try {
    let created = 0
    const stub = createStubContext({
      services: {
        agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) },
        llm: { stream: () => usageStream(personaProposalJson(), 500) },
        agents: {
          current: () => ({ applyHarnessPatch: () => {} }),
          create: async () => { created += 1; return childHandle([{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }]) },
        },
        harness2Experience: { ready: true, queryPriors: () => ({ priors: [], totalMatched: 0 }) },
      },
    })
    plugin.apply(stub.ctx, makeConfig(dir, { observeOnly: true }))
    const agent = makeAgent('parent-observe')
    const listener = stub.listeners.get('agent/request-error')
    const signal = new AbortController().signal
    for (let index = 0; index < 3; index += 1) {
      await listener(
        { agent, turn: 1, step: index + 1, provider: 'fake', failure: { message: 'failed', code: 'E' }, retryPolicy: undefined, signal },
        async () => undefined,
      )
    }
    await waitFor(async () => {
      try {
        const text = await readFile(path.join(dir, 'ledger.jsonl'), 'utf8')
        return text.trim().split('\n').filter(Boolean).length >= 2
      } catch { return false }
    })
    assert.equal(created, 0, 'observeOnly must not create control/treatment children')
    const envelopes = (await readFile(path.join(dir, 'ledger.jsonl'), 'utf8'))
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(envelopes[0].event, 'probe/completed')
    assert.equal(envelopes[0].payload.controlMetrics, undefined)
    assert.ok(envelopes[0].payload.trials.every((trial) => trial.valid === false && trial.error === 'observe-only'))
    assert.equal(envelopes[1].payload.reason, 'observe-only')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* 23 */
test('23. v4 diagnostics — missing systemPrompt and empty transcripts are reported, not silent', { timeout: 30000 }, async () => {
  const runScenario = async (makeChild) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'h2-task-diag-'))
    try {
      const stub = createStubContext({
        services: {
          agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) },
          llm: { stream: () => usageStream(personaProposalJson(), 500) },
          agents: { current: () => ({ applyHarnessPatch: () => {} }), create: async () => makeChild() },
          harness2Experience: { ready: true, queryPriors: () => ({ priors: [], totalMatched: 0 }) },
        },
      })
      plugin.apply(stub.ctx, makeConfig(dir, { observeOnly: false }))
      const agent = makeAgent('parent-diag')
      const listener = stub.listeners.get('agent/request-error')
      const signal = new AbortController().signal
      for (let index = 0; index < 3; index += 1) {
        await listener(
          { agent, turn: 1, step: index + 1, provider: 'fake', failure: { message: 'failed', code: 'E' }, retryPolicy: undefined, signal },
          async () => undefined,
        )
      }
      await waitFor(async () => {
        try {
          const text = await readFile(path.join(dir, 'ledger.jsonl'), 'utf8')
          return text.trim().split('\n').filter(Boolean).length >= 2
        } catch { return false }
      })
      const envelopes = (await readFile(path.join(dir, 'ledger.jsonl'), 'utf8'))
        .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      return { logs: stub.logs.map(([level, message]) => `${level}:${message}`).join('\n'), envelopes }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  const missing = await runScenario(() => childHandleNoSystemPrompt([{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }]))
  assert.match(missing.logs, /persona-injection-unavailable/)
  assert.equal(missing.envelopes[0].event, 'probe/completed')
  assert.equal(missing.envelopes[0].payload.controlMetrics, undefined)
  assert.equal(missing.envelopes[1].event, 'compose/rejected')

  const empty = await runScenario(() => childHandle([]))
  assert.match(empty.logs, /empty-transcript/)
  assert.match(empty.logs, /control-failed/)
  assert.equal(empty.envelopes[0].event, 'probe/completed')
  assert.equal(empty.envelopes[0].payload.controlMetrics, undefined)
  assert.equal(empty.envelopes[1].event, 'compose/rejected')
})

/* 24 */
test('24. gate receipt ↔ payload consistency + deep validation', () => {
  const controls = [
    goodTrialMetrics({ completion: true, toolFailures: 1, stepCount: 2, tokenCost: 1000 }),
    goodTrialMetrics({ completion: true, toolFailures: 1, stepCount: 2, tokenCost: 1000 }),
  ]
  const trial = trialRecord({
    candidateId: 'a',
    component: 'system-prompt',
    operation: 'set-persona-prefix',
    applicability: 'applied',
    metrics: goodTrialMetrics({ completion: true, toolFailures: 0, stepCount: 2, tokenCost: 9999 }),
  })
  const candidates = [
    {
      candidateId: 'a',
      candidateType: 'invariant',
      edit: {
        component: 'system-prompt',
        operation: 'set-persona-prefix',
        content: 'You are a coding agent that checks the failing command before retrying.',
        contentHash: hashOf('You are a coding agent that checks the failing command before retrying.'),
      },
    },
    {
      candidateId: 'b',
      candidateType: 'domain',
      edit: {
        component: 'system-prompt',
        operation: 'set-persona-prefix',
        content: 'You are a coding agent that verifies the failing step before retrying.',
        contentHash: hashOf('You are a coding agent that verifies the failing step before retrying.'),
      },
    },
  ]
  const probe = {
    taskId: 'task-1',
    cycleId: 'cycle-consistency',
    baselineMetrics: metrics(),
    trials: [trial],
    evidenceSummary: 'failure',
    controlMetrics: controls,
  }
  const decision = plugin.decideCompose({
    probe,
    candidates,
    cycleTokenCost: 10,
    config: new plugin.Config({ observeOnly: false, gatePolicy: 'v4' }),
  })
  assert.equal(decision.kind, 'reject')
  assert.equal(decision.reason, 'regression')
  assert.deepEqual(decision.gate.candidates.map((item) => item.candidateId), ['a'], 'receipt only covers probed candidates')
  assert.deepEqual(decision.gate.rejectedCandidateIds, decision.rejectedCandidateIds)
  assert.equal(plugin.validateGateReceipt(decision.gate).length, 0)
  const payload = {
    taskId: probe.taskId,
    cycleId: probe.cycleId,
    reason: decision.reason,
    rejectedCandidateIds: decision.rejectedCandidateIds,
    baselineMetrics: probe.baselineMetrics,
    trials: probe.trials,
    gate: decision.gate,
  }
  assert.deepEqual(plugin.validateComposeRejectedPayload(payload), [])
  // A mismatch between receipt and payload is rejected by the validator.
  assert.ok(plugin.validateComposeRejectedPayload({
    ...payload,
    gate: { ...decision.gate, rejectedCandidateIds: ['b'] },
  }).some((error) => error.includes('gate.rejectedCandidateIds')))
})
