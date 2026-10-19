/**
 * Round-3 contract verification for harness2-meta-recursion.
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
const siblingConstantsPath = path.resolve(packageRoot, '../harness2-task-recursion/src/constants.ts')
const plugin = await import(sourcePath)
const source = await readFile(sourcePath, 'utf8')
const run = promisify(execFile)

const EXPECTED_EVENTS = ['probe/completed', 'compose/applied', 'compose/rejected', 'propose/failed']
const FORBIDDEN_EVENT_PREFIXES = ['agent/', 'tools/', 'llm/', 'session/', 'subagent/']
const ALLOWED_CTX_MEMBERS = new Set(['on', 'emit', 'get', 'provide', 'logger', 'llm', 'agents'])
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
const hashOf = (value) => `sha256:${sha256(value)}`
const CONTENT = 'source patch content'
const CANDIDATE_ID = 'cand-1'

function createStubContext({ services = {} } = {}) {
  const listeners = new Map()
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
    provide(name, value) {
      provided.set(name, value)
      return () => provided.delete(name)
    },
    get(name) {
      return provided.get(name) ?? ctx[name]
    },
    logger: () => makeLogger(),
  }
  return { ctx, listeners, provided, logs }
}

async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
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

function trialRecord(overrides = {}) {
  return {
    candidateId: CANDIDATE_ID,
    candidateType: 'invariant',
    component: 'system-prompt',
    operation: 'append-guardrail',
    editContentHash: hashOf(CONTENT),
    valid: true,
    metrics: metrics({ completion: true, toolFailures: 0, stepCount: 2, tokenCost: 50 }),
    ...overrides,
  }
}

function probePayload(overrides = {}) {
  return {
    taskId: 'task-1',
    baselineMetrics: metrics(),
    trials: [
      trialRecord(),
      trialRecord({
        candidateId: 'cand-2',
        candidateType: 'domain',
        component: 'tool-guidance',
        operation: 'add-reminder',
        editContentHash: hashOf('domain patch'),
        metrics: metrics({ completion: true, toolFailures: 1, stepCount: 3, tokenCost: 60 }),
      }),
    ],
    evidenceSummary: 'tool=bash;code=TOOL_FAILED; command failed in step 2',
    cycleId: 'cycle-1',
    ...overrides,
  }
}

function appliedPayload(overrides = {}) {
  return {
    taskId: 'task-1',
    cycleId: 'cycle-1',
    appliedCandidateIds: [CANDIDATE_ID],
    appliedEdits: [{
      candidateId: CANDIDATE_ID,
      contentHash: hashOf(CONTENT),
      component: 'system-prompt',
      operation: 'append-guardrail',
    }],
    appliedComponents: ['system-prompt'],
    previousSnapshotRef: 'led-prev',
    ledgerEntryId: 'led-applied',
    applyMode: 'next-task-ledger',
    ...overrides,
  }
}

function rejectedPayload(reason = 'regression', overrides = {}) {
  return {
    taskId: 'task-1',
    cycleId: 'cycle-1',
    reason,
    rejectedCandidateIds: ['cand-2'],
    baselineMetrics: metrics(),
    trials: probePayload().trials,
    ...overrides,
  }
}

/** Craft a raw entry for file-level tests (confidence is recomputed on load). */
function entry(overrides = {}) {
  return {
    id: 'exp-a',
    condition: { failurePattern: 'tool=bash;code=E1; timeout in step 2', observedIn: ['t1'] },
    edit: {
      component: 'system-prompt',
      operation: 'op',
      contentHash: hashOf('line'),
      contentPreview: 'preview',
    },
    outcome: {
      metricDelta: { completion: 1 },
      trials: 2,
      adoption: 'accepted',
      tokenCostSource: 'measured',
    },
    confidence: 0.9,
    ...overrides,
  }
}

async function createServiceAt(experiencePath, overrides = {}) {
  const errors = []
  const service = new plugin.Harness2ExperienceService({
    experiencePath,
    maxExperienceEntries: 200,
    topKInjection: 5,
    minConfidenceToInject: 0.4,
    minNegativeConfidenceToInject: 0.3,
    enableNegativeExperience: true,
    onError: (code, details) => errors.push([code, details]),
    ...overrides,
  })
  await service.settled
  return { service, errors }
}

/* 1 */
test('1. entry & Config — namespace exports, round-3 defaults', () => {
  assert.equal(plugin.name, 'harness2-meta-recursion')
  assert.ok(!('default' in plugin))
  assert.deepEqual(plugin.inject, ['llm'])
  assert.deepEqual(new plugin.Config({}), {
    experiencePath: './EXPERIENCE.md',
    maxExperienceEntries: 200,
    topKInjection: 5,
    minConfidenceToInject: 0.4,
    minNegativeConfidenceToInject: 0.3,
    enableNegativeExperience: true,
    llmReflectionModel: '',
  })
  assert.throws(() => new plugin.Config({ minNegativeConfidenceToInject: 'x' }))
  assert.throws(() => new plugin.Config({ enableNegativeExperience: 'yes' }))
})

/* 2 */
test('2. apply — three listeners + frozen two-key facade', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-verify-'))
  try {
    const stub = createStubContext()
    plugin.apply(stub.ctx, new plugin.Config({ experiencePath: path.join(dir, 'EXPERIENCE.md') }))
    assert.deepEqual([...stub.listeners.keys()].sort(), [...EXPECTED_EVENTS].sort())
    const facade = stub.provided.get('harness2Experience')
    assert.ok(Object.isFrozen(facade))
    assert.deepEqual(Object.keys(facade).sort(), ['queryPriors', 'ready'])
    for (const mutator of ['recordApplied', 'recordRejected', 'noteProbe', 'entries', 'flush', 'settled']) {
      assert.equal(facade[mutator], undefined)
    }
    await waitFor(async () => facade.ready === true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* 3 */
test('3. source — constants identical, no raw events, no workflow-control fallback', async () => {
  assert.doesNotMatch(source, /^\s*export\s+default\b/m)
  assert.doesNotMatch(source, /from\s+['"]harness2-task-recursion['"]/)
  assert.doesNotMatch(source, /TODO\(API_NOT_FOUND\)/)
  assert.doesNotMatch(source, /'workflow-control'/)
  assert.deepEqual([...plugin.LISTENED_EVENTS], EXPECTED_EVENTS)
  const ctxMembers = new Set([...source.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]))
  for (const member of ctxMembers) assert.ok(ALLOWED_CTX_MEMBERS.has(member), `unexpected ctx.${member}`)
  const registered = [...source.matchAll(/ctx\.on\(\s*'([^']+)'/g)].map((match) => match[1])
  assert.deepEqual([...new Set(registered)].sort(), [...EXPECTED_EVENTS].sort())
  for (const eventName of registered) {
    assert.ok(!FORBIDDEN_EVENT_PREFIXES.some((prefix) => eventName.startsWith(prefix)))
  }
  const [mine, sibling] = await Promise.all([readFile(constantsPath, 'utf8'), readFile(siblingConstantsPath, 'utf8')])
  assert.equal(mine, sibling, 'constants.ts must be byte-identical in both packages')
  assert.deepEqual([...plugin.COMPONENT_NAMES], [
    'system-prompt', 'guardrails', 'memory', 'tool-guidance',
    'subagents', 'skills', 'scripts', 'plugins',
  ])
})

/* 4 */
test('4. confidence — frozen v3 formula (base, evidence floor, repeat, source penalty, trials=0)', () => {
  assert.equal(plugin.scoreConfidence(0, 'accepted', 'measured', 4), 0)
  assert.equal(plugin.scoreConfidence(3, 'accepted', 'measured', 0), 0.6)
  assert.equal(plugin.scoreConfidence(3, 'rejected', 'measured', 0), 0.5)
  assert.equal(plugin.scoreConfidence(2, 'accepted', 'measured', 0), 0.5)
  assert.equal(plugin.scoreConfidence(2, 'accepted', 'estimated', 0), 0.45)
  assert.equal(plugin.scoreConfidence(1, 'rejected', 'measured', 0), 0.333)
  assert.equal(plugin.scoreConfidence(3, 'accepted', 'measured', 1), 0.66)
  // estimated evidence is strictly discounted vs measured.
  assert.ok(
    plugin.scoreConfidence(2, 'accepted', 'estimated', 0)
      < plugin.scoreConfidence(2, 'accepted', 'measured', 0),
  )
})

/* 4b loader applies sourcePenalty and keeps migratedFrom scoped to migrations */
test('4b. load — sourcePenalty applied when re-deriving confidence; migratedFrom only on migrated entries', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-verify-'))
  try {
    const measured = entry({ id: 'measured', condition: { failurePattern: 'pattern measured', observedIn: ['t1'] } })
    const estimated = entry({
      id: 'estimated',
      condition: { failurePattern: 'pattern estimated', observedIn: ['t2'] },
      outcome: { metricDelta: {}, trials: 2, adoption: 'accepted', tokenCostSource: 'estimated' },
    })
    const migrated = entry({
      id: 'legacy',
      condition: { failurePattern: 'pattern legacy', observedIn: ['t3'] },
      edit: { component: 'tool-policy', operation: 'op', contentHash: hashOf('l'), contentPreview: 'p' },
    })
    const experiencePath = path.join(dir, 'EXPERIENCE.md')
    await writeFile(experiencePath, plugin.serializeExperience([measured, estimated, migrated]), 'utf8')
    const { service } = await createServiceAt(experiencePath)
    const loaded = service.entries()
    const measuredEntry = loaded.find((item) => item.id === 'measured')
    const estimatedEntry = loaded.find((item) => item.id === 'estimated')
    const migratedEntry = loaded.find((item) => item.id === 'legacy')
    assert.equal(
      measuredEntry.confidence,
      plugin.scoreConfidence(2, 'accepted', 'measured', 0),
    )
    assert.equal(
      estimatedEntry.confidence,
      plugin.scoreConfidence(2, 'accepted', 'estimated', 0),
    )
    assert.ok(estimatedEntry.confidence < measuredEntry.confidence)
    assert.equal(migratedEntry.migratedFrom, 'tool-policy')
    assert.equal(measuredEntry.migratedFrom, undefined)
    assert.equal(estimatedEntry.migratedFrom, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* 5 */
test('5. queryPriors — contract table with per-adoption thresholds', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-verify-'))
  try {
    const experiencePath = path.join(dir, 'EXPERIENCE.md')
    const entries = [
      entry({ id: 'pos-a', condition: { failurePattern: 'tool=bash;code=E1; timeout', taskDomain: 'ci', observedIn: ['t1'] } }),
      entry({
        id: 'neg-a',
        condition: { failurePattern: 'tool=read;code=E2; permission denied', observedIn: ['t2'] },
        edit: { component: 'guardrails', operation: 'op', contentHash: hashOf('g'), contentPreview: 'p' },
        outcome: { metricDelta: {}, trials: 2, adoption: 'rejected', tokenCostSource: 'measured' },
      }),
      entry({
        id: 'pos-b',
        condition: { failurePattern: 'tool=write;code=E3; disk full', observedIn: ['t3'] },
        edit: { component: 'verification' in {} ? 'skills' : 'skills', operation: 'op', contentHash: hashOf('s'), contentPreview: 'p' },
        outcome: { metricDelta: {}, trials: 1, adoption: 'accepted', tokenCostSource: 'measured' },
      }),
      entry({
        id: 'neg-b',
        condition: { failurePattern: 'tool=write;code=E4; quota', observedIn: ['t4'] },
        edit: { component: 'memory', operation: 'op', contentHash: hashOf('m'), contentPreview: 'p' },
        outcome: { metricDelta: {}, trials: 1, adoption: 'rejected', tokenCostSource: 'measured' },
      }),
    ]
    await writeFile(experiencePath, plugin.serializeExperience(entries), 'utf8')

    const early = new plugin.Harness2ExperienceService({
      experiencePath,
      maxExperienceEntries: 200,
      topKInjection: 5,
      minConfidenceToInject: 0.4,
      minNegativeConfidenceToInject: 0.3,
      enableNegativeExperience: true,
    })
    assert.deepEqual(early.queryPriors({ failureSignature: { toolName: 'bash' } }), { priors: [], totalMatched: 0 })
    await early.settled

    const { service } = await createServiceAt(experiencePath)
    assert.deepEqual(service.queryPriors({ failureSignature: {} }), { priors: [], totalMatched: 0 })
    const all = service.queryPriors({ failureSignature: { messagePattern: 'tool=' }, limit: 10 })
    assert.equal(all.totalMatched, 4, 'positive 0.5/0.4 and negative 0.417/0.333 all pass their thresholds')
    assert.ok(all.priors.every((prior) => Object.isFrozen(prior) && Object.isFrozen(prior.edit) && Object.isFrozen(prior.outcome)))
    assert.equal(typeof all.then, 'undefined', 'queryPriors is synchronous')

    // Cross-threshold check: negative excluded at minNeg 0.4 while positive stays.
    const strictNegative = await createServiceAt(experiencePath, { minNegativeConfidenceToInject: 0.45 })
    const strict = strictNegative.service.queryPriors({ failureSignature: { messagePattern: 'tool=' }, limit: 10 })
    assert.equal(strict.totalMatched, 2, 'only positives remain')
    assert.ok(strict.priors.every((prior) => prior.outcome.adoption === 'accepted'))
    // Raising the positive threshold must not affect negative entries.
    const strictPositive = await createServiceAt(experiencePath, { minConfidenceToInject: 0.45 })
    const positiveStrict = strictPositive.service.queryPriors({ failureSignature: { messagePattern: 'tool=' }, limit: 10 })
    assert.ok(positiveStrict.priors.some((prior) => prior.outcome.adoption === 'rejected'))

    // appliedComponents filter applies to both polarities.
    const filtered = service.queryPriors({
      failureSignature: { messagePattern: 'tool=' },
      appliedComponents: ['guardrails', 'memory'],
    })
    assert.ok(filtered.priors.every((prior) => !['guardrails', 'memory'].includes(prior.edit.component)))
    // limit semantics.
    const limited = service.queryPriors({ failureSignature: { messagePattern: 'tool=' }, limit: 1 })
    assert.equal(limited.priors.length, 1)
    assert.equal(limited.totalMatched, 4)
    assert.equal(service.queryPriors({ failureSignature: { messagePattern: 'tool=' }, limit: 999 }).priors.length, Math.min(5, 4))
    // Sorting: confidence desc, then latest observed desc, then id asc.
    for (let index = 1; index < all.priors.length; index += 1) {
      assert.ok(all.priors[index - 1].confidence >= all.priors[index].confidence)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* 6 */
test('6. writes — positive only applied; negative only regression; edit fields from payload facts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-verify-'))
  try {
    const { service, errors } = await createServiceAt(path.join(dir, 'EXPERIENCE.md'))
    service.noteProbe(probePayload())
    assert.equal((await service.recordRejected(rejectedPayload('observe-only'))).length, 0)
    assert.equal((await service.recordRejected(rejectedPayload('cost-limit'))).length, 0)
    assert.equal((await service.recordRejected(rejectedPayload('low-evidence'))).length, 0)
    assert.equal(service.entries().length, 0)

    const positive = await service.recordApplied(appliedPayload())
    assert.ok(positive)
    assert.equal(positive.edit.component, 'system-prompt')
    assert.equal(positive.edit.operation, 'append-guardrail')
    assert.equal(positive.edit.contentHash, hashOf(CONTENT), 'edit derives from appliedEdits, not reflection')
    assert.equal(positive.outcome.adoption, 'accepted')
    assert.equal(positive.outcome.trials, 2)
    assert.equal(positive.outcome.tokenCostSource, 'measured')

    const negatives = await service.recordRejected(rejectedPayload('regression'))
    assert.equal(negatives.length, 1)
    assert.equal(negatives[0].edit.component, 'tool-guidance', 'edit derives from the rejected trial metadata')
    assert.equal(negatives[0].outcome.adoption, 'rejected')
    assert.equal(service.entries().length, 2)
    assert.deepEqual(errors, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* 7 */
test('7. outcome.metricDelta — signed; tokenCostSource preserved per entry', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-verify-'))
  try {
    const worseMetrics = metrics({ completion: false, toolFailures: 9, stepCount: 9, tokenCost: 200 })
    const worseProbe = probePayload({
      cycleId: 'cycle-worse',
      trials: [trialRecord({
        candidateId: CANDIDATE_ID,
        component: 'system-prompt',
        operation: 'append-guardrail',
        editContentHash: hashOf(CONTENT),
        metrics: worseMetrics,
      })],
      trials2: undefined,
    })
    delete worseProbe.trials2
    const { service } = await createServiceAt(path.join(dir, 'EXPERIENCE.md'), { minConfidenceToInject: 0.01, minNegativeConfidenceToInject: 0.01 })
    service.noteProbe(worseProbe)
    const [negative] = await service.recordRejected(rejectedPayload('regression', {
      cycleId: 'cycle-worse',
      rejectedCandidateIds: [CANDIDATE_ID],
      trials: [trialRecord({
        candidateId: CANDIDATE_ID,
        editContentHash: hashOf(CONTENT),
        metrics: worseMetrics,
      })],
    }))
    assert.ok(negative)
    assert.ok(negative.outcome.metricDelta.toolFailures < 0)
    assert.ok(negative.outcome.metricDelta.stepCount < 0)
    assert.ok(negative.outcome.metricDelta.tokenCost < 0)
    assert.equal(negative.outcome.tokenCostSource, 'measured')

    service.noteProbe(probePayload({ cycleId: 'cycle-ok' }))
    const positive = await service.recordApplied(appliedPayload({ cycleId: 'cycle-ok' }))
    assert.ok(positive)
    assert.ok(positive.outcome.metricDelta.completion > 0)
    assert.ok(positive.outcome.metricDelta.toolFailures > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* 8 */
test('8. reflection (Q2) — candidateId matched, source edit kept, mismatch rejected', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-verify-'))
  try {
    const matching = await createServiceAt(path.join(dir, 'ok.md'), {
      reflect: async () => ({
        candidateId: CANDIDATE_ID,
        component: 'system-prompt',
        operation: 'append-guardrail',
        contentHash: hashOf(CONTENT),
        failurePattern: 'tool=bash;code=TOOL_FAILED',
        taskDomain: 'ci',
        confidenceSeed: 0.99,
      }),
    })
    matching.service.noteProbe(probePayload())
    const recorded = await matching.service.recordApplied(appliedPayload())
    assert.ok(recorded)
    assert.equal(recorded.edit.contentHash, hashOf(CONTENT), 'edit always from source facts')
    assert.equal(recorded.condition.taskDomain, 'ci')
    assert.match(recorded.condition.failurePattern, /TOOL_FAILED/)
    assert.equal(
      recorded.confidence,
      plugin.scoreConfidence(recorded.outcome.trials, 'accepted', 'measured', 0),
      'confidenceSeed ignored',
    )
    assert.deepEqual(matching.errors, [])

    const mismatch = await createServiceAt(path.join(dir, 'bad.md'), {
      reflect: async () => ({
        candidateId: CANDIDATE_ID,
        component: 'system-prompt',
        operation: 'append-guardrail',
        contentHash: hashOf('tampered content'),
      }),
    })
    mismatch.service.noteProbe(probePayload())
    const rejected = await mismatch.service.recordApplied(appliedPayload())
    assert.equal(rejected, undefined)
    assert.equal(mismatch.service.entries().length, 0)
    assert.ok(mismatch.errors.some(([code]) => code === 'reflection-edit-mismatch'))

    const unknown = await createServiceAt(path.join(dir, 'unknown.md'), {
      reflect: async () => ({ candidateId: 'cand-unknown' }),
    })
    unknown.service.noteProbe(probePayload())
    assert.equal(await unknown.service.recordApplied(appliedPayload()), undefined)
    assert.ok(unknown.errors.some(([code]) => code === 'reflection-edit-mismatch'))

    // Invented failurePattern is discarded; fallback stays grounded in evidence.
    const invented = await createServiceAt(path.join(dir, 'invented.md'), {
      reflect: async () => ({
        candidateId: CANDIDATE_ID,
        component: 'system-prompt',
        operation: 'append-guardrail',
        contentHash: hashOf(CONTENT),
        failurePattern: 'completely invented pattern',
      }),
    })
    invented.service.noteProbe(probePayload())
    const fallback = await invented.service.recordApplied(appliedPayload())
    assert.match(fallback.condition.failurePattern, /TOOL_FAILED|command failed/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* 9 */
test('9. eviction — confidence/observed ordering, load write-back, evicted upsert undefined', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-verify-'))
  try {
    const experiencePath = path.join(dir, 'EXPERIENCE.md')
    const entries = [
      entry({ id: 'high', condition: { failurePattern: 'pattern high', observedIn: ['t1'] } }),
      entry({
        id: 'mid',
        condition: { failurePattern: 'pattern mid', observedIn: ['t2'] },
        outcome: { metricDelta: {}, trials: 1, adoption: 'accepted', tokenCostSource: 'measured' },
      }),
      entry({
        id: 'low',
        condition: { failurePattern: 'pattern low', observedIn: ['t3'] },
        outcome: { metricDelta: {}, trials: 1, adoption: 'rejected', tokenCostSource: 'measured' },
      }),
    ]
    await writeFile(experiencePath, plugin.serializeExperience(entries), 'utf8')
    const { service } = await createServiceAt(experiencePath, { maxExperienceEntries: 2 })
    assert.equal(service.entries().length, 2)
    assert.ok(!service.entries().some((item) => item.id === 'low'))
    assert.equal(plugin.parseExperience(await readFile(experiencePath, 'utf8')).entries.length, 2)

    const tiny = await createServiceAt(path.join(dir, 'tiny.md'), { maxExperienceEntries: 1 })
    tiny.service.noteProbe(probePayload({ cycleId: 'c1' }))
    assert.ok(await tiny.service.recordApplied(appliedPayload({ cycleId: 'c1' })))
    tiny.service.noteProbe(probePayload({
      cycleId: 'c2',
      evidenceSummary: 'other failure',
      trials: [trialRecord({ candidateId: CANDIDATE_ID, editContentHash: hashOf('x'), metrics: metrics({ toolFailures: 9 }) })],
    }))
    const second = await tiny.service.recordApplied(appliedPayload({ cycleId: 'c2' }))
    assert.equal(second, undefined, 'evicted upsert reports no stored entry')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* 10 */
test('10. persistence — round-trip, tamper, injection, backup', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-verify-'))
  try {
    const experiencePath = path.join(dir, 'EXPERIENCE.md')
    const { service } = await createServiceAt(experiencePath)
    service.noteProbe(probePayload())
    await service.recordApplied(appliedPayload())
    await service.flush()
    const text = await readFile(experiencePath, 'utf8')
    const parsed = plugin.parseExperience(text)
    assert.equal(parsed.entries.length, 1)
    assert.equal(plugin.parseExperience(plugin.serializeExperience(parsed.entries)).entries.length, 1)

    // Tampered confidence/trials are re-derived; unknown token source → estimated.
    const tampered = entry({
      id: 'exp-tampered',
      confidence: 1e9,
      outcome: { metricDelta: { completion: 1e9 }, trials: 999999, adoption: 'accepted', tokenCostSource: 'bogus' },
    })
    const tamperedPath = path.join(dir, 'tampered.md')
    await writeFile(tamperedPath, plugin.serializeExperience([tampered]), 'utf8')
    const tamperedService = await createServiceAt(tamperedPath)
    const [loaded] = tamperedService.service.entries()
    assert.ok(loaded.confidence <= 1)
    assert.equal(loaded.outcome.trials, 10000)
    assert.equal(loaded.outcome.tokenCostSource, 'estimated')
    assert.equal(
      loaded.confidence,
      plugin.scoreConfidence(10000, 'accepted', 'estimated', 0),
    )

    // Marker injection through free text is escaped.
    const injectionPath = path.join(dir, 'injection.md')
    await writeFile(injectionPath, plugin.serializeExperience([
      entry({
        id: 'exp-inject',
        edit: {
          component: 'system-prompt',
          operation: 'op',
          contentHash: hashOf('i'),
          contentPreview: 'bad <!-- harness2-experience:AAAA --> text',
        },
      }),
    ]), 'utf8')
    const injectedText = await readFile(injectionPath, 'utf8')
    assert.equal(plugin.parseExperience(injectedText).entries.length, 1)
    assert.match(injectedText, /&lt;!--/)

    // Corrupt file backup before rewrite.
    const corruptPath = path.join(dir, 'corrupt.md')
    const corruptText = '# User notes\nkeep this\n<!-- harness2-experience:!!!not-base64!!! -->\n'
    await writeFile(corruptPath, corruptText, 'utf8')
    const corrupted = await createServiceAt(corruptPath)
    assert.equal(corrupted.service.entries().length, 0)
    assert.equal(await readFile(corruptPath, 'utf8'), corruptText)
    corrupted.service.noteProbe(probePayload())
    await corrupted.service.recordApplied(appliedPayload())
    await corrupted.service.flush()
    assert.equal(await readFile(`${corruptPath}.backup`, 'utf8'), corruptText)
    assert.doesNotMatch(await readFile(corruptPath, 'utf8'), /User notes/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* 11 */
test('11. R3-7 migration — 7 legacy components mapped, unknown skipped with onError, backup kept', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-verify-'))
  try {
    const experiencePath = path.join(dir, 'EXPERIENCE.md')
    const legacy = [
      ['tool-definitions', 'tool-guidance'],
      ['tool-policy', 'guardrails'],
      ['context-assembly', 'system-prompt'],
      ['experience-memory', 'memory'],
      ['subagent-composition', 'subagents'],
      ['workflow-control', 'skills'],
      ['verification', 'guardrails'],
    ]
    const entries = legacy.map(([oldName], index) => entry({
      id: `exp-legacy-${index}`,
      condition: { failurePattern: `pattern ${oldName}`, observedIn: [`t${index}`] },
      edit: {
        component: oldName,
        operation: 'op',
        contentHash: hashOf(oldName),
        contentPreview: 'p',
      },
    }))
    entries.push(entry({
      id: 'exp-unknown',
      condition: { failurePattern: 'pattern unknown', observedIn: ['t9'] },
      edit: { component: 'mystery-component', operation: 'op', contentHash: hashOf('u'), contentPreview: 'p' },
    }))
    await writeFile(experiencePath, plugin.serializeExperience(entries), 'utf8')

    const { service, errors } = await createServiceAt(experiencePath)
    const loaded = service.entries()
    assert.equal(loaded.length, 7, 'all legacy entries are kept')
    for (const [expectedIndex, [, newName]] of legacy.entries()) {
      const item = loaded.find((candidate) => candidate.id === `exp-legacy-${expectedIndex}`)
      assert.ok(item)
      assert.equal(item.edit.component, newName)
      assert.equal(item.migratedFrom, legacy[expectedIndex][0])
    }
    assert.ok(errors.some(([code, details]) => code === 'unknown-component' && details.id === 'exp-unknown'))
    assert.equal(await readFile(`${experiencePath}.backup`, 'utf8'), await readFile(experiencePath, 'utf8').then(() => plugin.serializeExperience(entries)))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* 12 */
test('12. apply — listeners drive positive/negative entries; policy rejections ignored', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-verify-'))
  try {
    const stub = createStubContext({
      llm: {
        stream: () => (async function* () {
          yield { type: 'text-delta', index: 0, text: 'not json' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })(),
      },
    })
    plugin.apply(stub.ctx, new plugin.Config({
      experiencePath: path.join(dir, 'EXPERIENCE.md'),
      minConfidenceToInject: 0.4,
      minNegativeConfidenceToInject: 0.3,
    }))
    const facade = stub.provided.get('harness2Experience')
    await waitFor(async () => facade.ready === true)

    stub.listeners.get('probe/completed')(probePayload({ cycleId: 'live-1' }))
    stub.listeners.get('compose/applied')(appliedPayload({ cycleId: 'live-1' }))
    await waitFor(async () => facade.queryPriors({ failureSignature: { messagePattern: 'command failed' } }).totalMatched === 1)
    const positive = facade.queryPriors({ failureSignature: { messagePattern: 'command failed' } }).priors[0]
    assert.equal(positive.outcome.adoption, 'accepted')
    assert.equal(positive.edit.contentHash, hashOf(CONTENT))

    stub.listeners.get('probe/completed')(probePayload({ cycleId: 'live-2' }))
    stub.listeners.get('compose/rejected')(rejectedPayload('observe-only', { cycleId: 'live-2' }))
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(facade.queryPriors({ failureSignature: { messagePattern: 'command failed' } }).totalMatched, 1)

    stub.listeners.get('probe/completed')(probePayload({ cycleId: 'live-3' }))
    stub.listeners.get('compose/rejected')(rejectedPayload('regression', { cycleId: 'live-3' }))
    await waitFor(async () => facade.queryPriors({ failureSignature: { messagePattern: 'command failed' } }).totalMatched === 2)
    const all = facade.queryPriors({ failureSignature: { messagePattern: 'command failed' } })
    assert.ok(all.priors.some((prior) => prior.outcome.adoption === 'rejected'))

    // R4-1: propose/failed is diagnostic only — the library must not change.
    const before = facade.queryPriors({ failureSignature: { messagePattern: 'command failed' } }).totalMatched
    const fileBefore = await readFile(path.join(dir, 'EXPERIENCE.md'), 'utf8')
    stub.listeners.get('propose/failed')({
      taskId: 'task-1',
      cycleId: 'live-failed',
      reason: 'llm-error',
      attempts: 2,
      lastError: 'socket closed',
      baselineMetrics: metrics(),
      recordedAt: new Date().toISOString(),
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(facade.queryPriors({ failureSignature: { messagePattern: 'command failed' } }).totalMatched, before)
    assert.equal(await readFile(path.join(dir, 'EXPERIENCE.md'), 'utf8'), fileBefore, 'propose/failed never writes EXPERIENCE.md')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* 13 */
test('13. types — tsc --noEmit passes against the live dsh 0.2.1-rc.2 API', { timeout: 180000 }, async () => {
  const tsc = path.join(packageRoot, '..', '..', 'node_modules', '.bin', 'tsc')
  try {
    await run(tsc, ['-p', packageRoot, '--noEmit'], { cwd: packageRoot })
  } catch (error) {
    assert.fail(`tsc failed:\n${error.stdout ?? ''}\n${error.stderr ?? ''}`)
  }
})
