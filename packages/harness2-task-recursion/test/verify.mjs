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

function childHandle(messages) {
  const followups = []
  const child = {
    options: {},
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
    observeOnly: true,
    trajectoryWindow: 5,
    taskDomain: '',
    proposeModel: '',
    metricWeights: { completion: 1, toolFailures: 0.5, stepCount: 0.1, tokenCost: 0.0001 },
  })
  assert.throws(() => new plugin.Config({ replayScope: 'sometimes' }))
  assert.throws(() => new plugin.Config({ triggerThreshold: 'three' }))
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
  const config = (overrides = {}) => new plugin.Config({ observeOnly: false, ...overrides })
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

  const observeOnly = plugin.decideCompose({ probe, candidates, cycleTokenCost: 0, config: new plugin.Config({}) })
  assert.equal(observeOnly.kind, 'reject')
  assert.equal(observeOnly.reason, 'observe-only')
  assert.deepEqual(observeOnly.rejectedCandidateIds, [CANDIDATE_ID, 'cand-2'])

  // R4-2: candidates that never entered Probe are not attributable, so a
  // budget early-stop lists only the probed trial id.
  const earlyStopProbe = probePayload({ trials: [trialRecord({ metrics: goodTrialMetrics() })] })
  const observeEarly = plugin.decideCompose({ probe: earlyStopProbe, candidates, cycleTokenCost: 0, config: new plugin.Config({}) })
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
    plugin.apply(stub.ctx, makeConfig(dir, { observeOnly: false }))
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
    'R4-2: budget early-stop omits unprobed candidates',
  )
  assert.equal(costLimited.rejected.rejectedCandidateIds.length, 1)
  assert.equal(costLimited.probeTrials, 1)
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
    plugin.apply(stub.ctx, new plugin.Config({ ledgerPath: path.join(blocker, 'ledger.jsonl'), observeOnly: false }))
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
