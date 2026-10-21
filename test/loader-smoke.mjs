/**
 * Loader-contract smoke: mounts both round-2 plugins on a real Cordis context.
 *
 * Exercises the production path: loader `unwrapExports` normalization, static
 * `inject` resolution, Config schema validation (raw partial configs), real
 * event-bus delivery of all three structured events, the frozen facade, and
 * positive/negative priors in the experience library.
 *
 * Run: npm run verify:loader
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'

const taskModule = await import('../packages/harness2-task-recursion/src/index.ts')
const metaModule = await import('../packages/harness2-meta-recursion/src/index.ts')
const taskLibPath = path.resolve('packages/harness2-task-recursion/lib/index.js')
const metaLibPath = path.resolve('packages/harness2-meta-recursion/lib/index.js')

/** Mirrors `Loader.unwrapExports` from @deepseek-ai/cordis-plugin-loader. */
function unwrapExports(exports) {
  if (exports === null || exports === undefined) return exports
  const unwrapped = exports.default ?? exports
  if (!unwrapped.__esModule) return unwrapped
  return unwrapped.default ?? unwrapped
}
const unwrap = (module) => unwrapExports(module)

function provideStubServices(ctx) {
  const disposers = [
    ctx.provide('tools', {
      get: () => undefined,
      register: () => () => undefined,
      schemas: () => [],
      execute: async () => ({ isError: false, content: [], value: null }),
    }),
    ctx.provide('llm', {
      listProviders: () => [],
      stream: () => {
        throw new Error('llm.stream is unused in this smoke test')
      },
    }),
    ctx.provide('agents', {
      create: async () => {
        throw new Error('agents.create is unused in this smoke test')
      },
      list: () => [],
    }),
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'smoke-provider', model: 'smoke-model' }),
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

const metrics = (overrides = {}) => ({
  completion: false,
  toolFailures: 3,
  stepCount: 4,
  tokenCost: 100,
  tokenCostSource: 'measured',
  durationMs: 1000,
  ...overrides,
})
const hashOf = (value) => `sha256:${Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64)}`

function probeEvent(cycleId, taskId = 'smoke-task') {
  return {
    taskId,
    baselineMetrics: metrics(),
    trials: [
      {
        candidateId: 'cand-1',
        candidateType: 'invariant',
        component: 'system-prompt',
        operation: 'append-guardrail',
        editContentHash: hashOf('smoke content one'),
        valid: true,
        metrics: metrics({ completion: true, toolFailures: 0, stepCount: 2, tokenCost: 50 }),
      },
      {
        candidateId: 'cand-2',
        candidateType: 'domain',
        component: 'tool-guidance',
        operation: 'add-reminder',
        editContentHash: hashOf('smoke content two'),
        valid: true,
        metrics: metrics({ completion: true, toolFailures: 1, stepCount: 3, tokenCost: 60 }),
      },
    ],
    evidenceSummary: 'tool=bash;code=TOOL_FAILED; command failed in step 2',
    cycleId,
  }
}

function appliedEvent(cycleId, taskId = 'smoke-task') {
  return {
    taskId,
    cycleId,
    appliedCandidateIds: ['cand-1'],
    appliedEdits: [{
      candidateId: 'cand-1',
      contentHash: hashOf('smoke content one'),
      component: 'system-prompt',
      operation: 'append-guardrail',
    }],
    appliedComponents: ['system-prompt'],
    previousSnapshotRef: 'led-prev',
    ledgerEntryId: 'led-applied',
    applyMode: 'next-task-ledger',
  }
}

function rejectedEvent(cycleId, taskId = 'smoke-task') {
  return {
    taskId,
    cycleId,
    reason: 'regression',
    rejectedCandidateIds: ['cand-2'],
    baselineMetrics: metrics(),
    trials: probeEvent(cycleId, taskId).trials,
  }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

test('loader contract — namespace exports survive unwrapExports', () => {
  const task = unwrap(taskModule)
  const meta = unwrap(metaModule)
  assert.equal(task, taskModule)
  assert.equal(meta, metaModule)
  assert.deepEqual(task.inject, ['tools', 'llm', 'agents'])
  assert.deepEqual(meta.inject, ['llm'])
})

test('loader contract — raw configs mount; all three events reach the real bus', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-loader-smoke-'))
  const ctx = new Context()
  const disposeServices = provideStubServices(ctx)
  const task = unwrap(taskModule)
  const meta = unwrap(metaModule)
  try {
    const taskFiber = ctx.plugin(task, { ledgerPath: path.join(dir, 'ledger.jsonl') })
    await taskFiber
    const metaFiber = ctx.plugin(meta, { experiencePath: path.join(dir, 'EXPERIENCE.md') })
    await metaFiber

    const facade = ctx.get('harness2Experience')
    assert.ok(facade)
    assert.ok(Object.isFrozen(facade))
    assert.deepEqual(Object.keys(facade).sort(), ['queryPriors', 'ready'])
    await waitFor(async () => facade.ready === true)

    ctx.emit('probe/completed', probeEvent('live-1'))
    ctx.emit('compose/applied', appliedEvent('live-1'))
    ctx.emit('probe/completed', probeEvent('live-2'))
    ctx.emit('compose/rejected', rejectedEvent('live-2'))

    // PR-5: compose decisions are diagnostic only; they must not write
    // experience. The real bus delivery is exercised by these emits.
    await new Promise((resolve) => setTimeout(resolve, 80))
    const result = facade.queryPriors({ failureSignature: { messagePattern: 'command failed' } })
    assert.equal(result.totalMatched, 0)
    assert.equal(result.priors.length, 0)

    // R4-1: propose/failed is diagnostic only; it must not change the library.
    const before = facade.queryPriors({ failureSignature: { messagePattern: 'command failed' } }).totalMatched
    ctx.emit('propose/failed', {
      taskId: 'smoke-task',
      cycleId: 'smoke-failed',
      reason: 'schema-invalid',
      attempts: 2,
      lastError: 'proposal is not JSON',
      baselineMetrics: metrics(),
      recordedAt: new Date().toISOString(),
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(
      facade.queryPriors({ failureSignature: { messagePattern: 'command failed' } }).totalMatched,
      before,
    )

    await metaFiber.dispose()
    await taskFiber.dispose()
  } finally {
    disposeServices()
    await rm(dir, { recursive: true, force: true })
  }
})

test('loader contract — built lib/ artifacts mount and expose the facade', async (t) => {
  if (!existsSync(taskLibPath) || !existsSync(metaLibPath)) {
    t.skip('lib/ not built yet; run `npm run build` first')
    return
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-loader-smoke-lib-'))
  const ctx = new Context()
  const disposeServices = provideStubServices(ctx)
  try {
    const task = unwrap(await import(pathToFileURL(taskLibPath).href))
    const meta = unwrap(await import(pathToFileURL(metaLibPath).href))
    const taskFiber = ctx.plugin(task, { ledgerPath: path.join(dir, 'ledger.jsonl') })
    await taskFiber
    const metaFiber = ctx.plugin(meta, { experiencePath: path.join(dir, 'EXPERIENCE.md') })
    await metaFiber
    const facade = ctx.get('harness2Experience')
    assert.ok(facade)
    await waitFor(async () => facade.ready === true)
    ctx.emit('probe/completed', probeEvent('lib-1'))
    ctx.emit('compose/applied', appliedEvent('lib-1'))
    // PR-5: no compose-derived priors even from the built facade.
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(facade.queryPriors({ failureSignature: { messagePattern: 'command failed' } }).priors.length, 0)
    await metaFiber.dispose()
    await taskFiber.dispose()
  } finally {
    disposeServices()
    await rm(dir, { recursive: true, force: true })
  }
})

test('round-4 — propose/failed tail does not break next-task-ledger detection', async () => {
  const task = unwrap(taskModule)
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-loader-smoke-rev-'))
  try {
    const ledgerPath = path.join(dir, 'ledger.jsonl')
    const applied = {
      version: 'harness2-ledger/v3',
      id: 'led-revision',
      previousSnapshotRef: null,
      ledgerEntryId: 'led-revision',
      event: 'compose/applied',
      payload: appliedEvent('rev-cycle'),
      recordedAt: new Date().toISOString(),
    }
    const failed = {
      version: 'harness2-ledger/v3',
      id: 'led-failed',
      previousSnapshotRef: 'led-revision',
      ledgerEntryId: 'led-failed',
      event: 'propose/failed',
      payload: {
        taskId: 'smoke-task', cycleId: 'rev-failed', reason: 'llm-error', attempts: 2,
        baselineMetrics: metrics(), recordedAt: new Date().toISOString(),
      },
      recordedAt: new Date().toISOString(),
    }
    await writeFile(ledgerPath, `${JSON.stringify(applied)}\n${JSON.stringify(failed)}\n`, 'utf8')
    const tail = await task.readLedgerTail(ledgerPath)
    assert.equal(tail.id, 'led-failed')
    const revision = await task.readRevisionAnchor(ledgerPath)
    assert.equal(revision.found, true)
    assert.equal(revision.id, 'led-revision')
    assert.equal(
      await task.detectApplyMode(new Context(), new task.Config({ ledgerPath })),
      'next-task-ledger',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('round-5 — plugin unload leaves no listeners and no ledger/experience writes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-loader-smoke-unload-'))
  const ctx = new Context()
  const disposeServices = provideStubServices(ctx)
  try {
    const ledgerPath = path.join(dir, 'ledger.jsonl')
    const experiencePath = path.join(dir, 'EXPERIENCE.md')
    const task = unwrap(taskModule)
    const meta = unwrap(metaModule)
    const taskFiber = ctx.plugin(task, { ledgerPath })
    await taskFiber
    const metaFiber = ctx.plugin(meta, { experiencePath })
    await metaFiber
    const facade = ctx.get('harness2Experience')
    await waitFor(async () => facade.ready === true)

    const hooks = ctx.events._hooks
    const count = (name) => (hooks[name] ?? []).length
    const watched = ['tools/result', 'agent/request-error', 'agent/pre-step', 'probe/completed', 'compose/applied', 'compose/rejected', 'propose/failed']
    const before = Object.fromEntries(watched.map((name) => [name, count(name)]))
    for (const name of watched) assert.ok(before[name] >= 1, `${name} has a listener while mounted`)

    await metaFiber.dispose()
    await taskFiber.dispose()
    for (const name of watched) {
      assert.equal(count(name), before[name] - 1, `${name} listener is released on dispose`)
    }

    // No residual observer may write after disposal.
    ctx.emit('probe/completed', probeEvent('unloaded-cycle'))
    ctx.emit('compose/applied', appliedEvent('unloaded-cycle'))
    ctx.emit('compose/rejected', rejectedEvent('unloaded-cycle'))
    ctx.emit('propose/failed', {
      taskId: 'smoke-task', cycleId: 'unloaded-cycle', reason: 'llm-error', attempts: 2,
      baselineMetrics: metrics(), recordedAt: new Date().toISOString(),
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(existsSync(ledgerPath), false, 'no ledger writes after disposal')
    assert.equal(existsSync(experiencePath), false, 'no experience writes after disposal')
  } finally {
    disposeServices()
    await rm(dir, { recursive: true, force: true })
  }
})
