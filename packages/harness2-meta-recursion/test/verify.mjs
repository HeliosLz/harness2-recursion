/** Round-6 PR-5 contract verification for harness2-meta-recursion. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const plugin = await import(path.join(packageRoot, 'src', 'index.ts'))

const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
const hashOf = (value) => `sha256:${sha(value)}`
const stable = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
}
const reportHashOf = (report) => {
  const { reportHash: _ignored, ...rest } = report
  return hashOf(stable(rest))
}

function metrics(overrides = {}) {
  return { completion: false, toolFailures: 2, stepCount: 4, tokenCost: 100, tokenCostSource: 'measured', durationMs: 5, ...overrides }
}
function probe(cycleId) {
  return { taskId: 'source-task', baselineMetrics: metrics(), evidenceSummary: 'command failed with exit code 1', cycleId, trials: [] }
}
function applied(cycleId) {
  return { taskId: 'source-task', cycleId, appliedCandidateIds: ['cand-1'], appliedEdits: [{ candidateId: 'cand-1', contentHash: 'sha256:' + 'a'.repeat(64), component: 'system-prompt', operation: 'set-persona-prefix' }], appliedComponents: ['system-prompt'], previousSnapshotRef: 'none', ledgerEntryId: 'led', applyMode: 'next-task-ledger' }
}
function rejected(cycleId) {
  return { taskId: 'source-task', cycleId, reason: 'regression', rejectedCandidateIds: ['cand-1'], baselineMetrics: metrics(), trials: [] }
}
function legacyEntry(overrides = {}) {
  return {
    id: 'exp-legacy', condition: { failurePattern: 'command failed', observedIn: ['task-1'] },
    edit: { component: 'system-prompt', operation: 'set-persona-prefix', contentHash: 'sha256:' + 'b'.repeat(64), contentPreview: 'preview' },
    outcome: { metricDelta: { completion: 1 }, trials: 3, adoption: 'accepted', tokenCostSource: 'measured' },
    confidence: 0.9, ...overrides,
  }
}

async function makeVerificationFixture(dir, { providerClass = 'real', verdict = 'accept', source = { taskId: 'source-task', cycleId: 'c1', failurePattern: 'command failed', taskDomain: 'repo-fix' }, sourceMissing = false, hashValid = true, reportHashOverride = undefined } = {}) {
  const batchId = `batch-${Math.random().toString(16).slice(2, 8)}`
  const revisionId = 'rev-3aa3b56f7f5f'
  const report = {
    schema: 'harness2-eval/v1', batchId, revisionId, profile: 'isolated', cycleId: 'c1',
    contentHash: 'sha256:' + 'a'.repeat(64), planToken: 'sha256:' + 'c'.repeat(64),
    preregHash: 'sha256:' + 'd'.repeat(64), tasksHash: 'sha256:' + 'e'.repeat(64),
    evaluatedAt: new Date().toISOString(), providerClass, fold: 0, arms: ['C', 'R', 'I', 'T'], perTask: [],
    b: 10, c: 0, N: 12, delta: 10 / 12, p: 0.001, secondary: {}, drift: {}, inert: {},
    inertControlRejected: true, nullProxyRejected: true, mountSchemaFailures: 0, verdict,
    edit: { candidateId: 'cand-1', component: 'system-prompt', operation: 'set-persona-prefix', contentHash: 'sha256:' + 'a'.repeat(64) },
    ...(sourceMissing ? { sourceMissing: true } : { source }),
    tokenCostSource: 'measured',
  }
  report.reportHash = reportHashOf(report)
  const indexDir = path.join(dir, 'eval')
  await mkdir(indexDir, { recursive: true })
  const reportPath = path.join(indexDir, `${batchId}.json`)
  await writeFile(reportPath, JSON.stringify(report), 'utf8')
  const indexedHash = reportHashOverride ?? (hashValid ? report.reportHash : hashOf('wrong'))
  const index = path.join(indexDir, 'index.jsonl')
  await writeFile(index, `${JSON.stringify({
    schema: 'harness2-eval-index/v1', batchId, revisionId, reportPath: path.basename(reportPath),
    reportHash: indexedHash, providerClass, verdict, fold: 0, createdAt: new Date().toISOString(),
  })}\n`, 'utf8')
  return { index, reportPath, batchId, revisionId, report }
}

async function serviceAt(dir, overrides = {}) {
  const service = new plugin.Harness2ExperienceService({
    experiencePath: path.join(dir, 'EXPERIENCE.md'),
    maxExperienceEntries: 50, topKInjection: 5,
    minConfidenceToInject: 0.4, minNegativeConfidenceToInject: 0.3,
    enableNegativeExperience: true, enableLegacyExperience: false,
    evaluationsPath: path.join(dir, 'eval', 'index.jsonl'),
    ledgerPath: path.join(dir, 'ledger.jsonl'),
    applyStatePath: path.join(dir, 'apply', 'active.json'),
    onError: () => {},
    ...overrides,
  })
  await service.settled
  return service
}

test('1. Config — PR-5 additive defaults', () => {
  assert.deepEqual(new plugin.Config({}), {
    experiencePath: './EXPERIENCE.md',
    maxExperienceEntries: 200,
    topKInjection: 5,
    minConfidenceToInject: 0.4,
    minNegativeConfidenceToInject: 0.3,
    enableNegativeExperience: true,
    llmReflectionModel: '',
    evaluationsPath: '',
    ledgerPath: './harness2-ledger.jsonl',
    applyStatePath: '',
    enableLegacyExperience: false,
  })
  assert.throws(() => new plugin.Config({ enableLegacyExperience: 'yes' }))
})

test('2. confidence — frozen v3 formula unchanged', () => {
  assert.equal(plugin.scoreConfidence(0, 'accepted', 'measured', 0), 0)
  assert.equal(plugin.scoreConfidence(3, 'accepted', 'measured', 0), 0.6)
  assert.equal(plugin.scoreConfidence(3, 'rejected', 'estimated', 0), 0.45)
})

test('3. real accept evaluation ingests a verified positive entry', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-v1-'))
  try {
    await makeVerificationFixture(dir)
    const service = await serviceAt(dir)
    const result = service.queryPriors({ failureSignature: { messagePattern: 'command failed' } })
    assert.equal(result.totalMatched, 1)
    const entry = result.priors[0]
    assert.equal(entry.outcome.adoption, 'accepted')
    assert.equal(entry.verification.schema, 'harness2-verification/v1')
    assert.equal(entry.verification.providerClass, 'real')
    assert.equal(entry.verification.verdict, 'accept')
    assert.equal(entry.outcome.trials, 12)
    assert.deepEqual(entry.condition.observedIn, [`eval:${entry.verification.batchId}`])
    const text = await readFile(path.join(dir, 'EXPERIENCE.md'), 'utf8')
    assert.match(text, /harness2-experience/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('4. real reject evaluation ingests a verified negative entry', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-v2-'))
  try {
    await makeVerificationFixture(dir, { verdict: 'reject' })
    const service = await serviceAt(dir)
    const entry = service.queryPriors({ failureSignature: { messagePattern: 'command failed' } }).priors[0]
    assert.equal(entry.outcome.adoption, 'rejected')
    assert.equal(entry.verification.verdict, 'reject')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('5. fake/hash-mismatch/source-missing evaluations never write experience', async () => {
  for (const fixture of [
    { providerClass: 'fake-calibration' },
    { hashValid: false },
    { sourceMissing: true },
  ]) {
    const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-v3-'))
    try {
      await makeVerificationFixture(dir, fixture)
      const service = await serviceAt(dir)
      assert.equal(service.queryPriors({ failureSignature: { messagePattern: 'command failed' } }).totalMatched, 0)
      const text = await readFile(path.join(dir, 'EXPERIENCE.md'), 'utf8').catch(() => '')
      assert.equal(text.trim(), '')
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
})

test('6. same reportHash is idempotent across reloads', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-v4-'))
  try {
    const fixture = await makeVerificationFixture(dir)
    const first = await serviceAt(dir)
    assert.equal(first.queryPriors({ failureSignature: { messagePattern: 'command failed' } }).totalMatched, 1)
    const line = await readFile(fixture.index, 'utf8')
    await writeFile(fixture.index, line + line, 'utf8')
    const second = await serviceAt(dir)
    assert.equal(second.queryPriors({ failureSignature: { messagePattern: 'command failed' } }).totalMatched, 1)
    const parsed = plugin.parseExperience(await readFile(path.join(dir, 'EXPERIENCE.md'), 'utf8'))
    assert.equal(parsed.entries.length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('7. compose/applied and compose/rejected are diagnostic only (no EXPERIENCE bytes change)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-v5-'))
  try {
    const experiencePath = path.join(dir, 'EXPERIENCE.md')
    await writeFile(experiencePath, plugin.serializeExperience([legacyEntry()]), 'utf8')
    const before = await readFile(experiencePath, 'utf8')
    const errors = []
    const service = await serviceAt(dir, { onError: (code) => errors.push(code) })
    assert.equal(await service.recordApplied(applied('c1')), undefined)
    assert.deepEqual(await service.recordRejected(rejected('c1')), [])
    assert.equal(await readFile(experiencePath, 'utf8'), before)
    assert.ok(errors.includes('gate-decision-not-evidence'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('8. legacy entries are quarantined by default; enableLegacyExperience reveals them without verification', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-v6-'))
  try {
    await writeFile(path.join(dir, 'EXPERIENCE.md'), plugin.serializeExperience([legacyEntry()]), 'utf8')
    const defaults = await serviceAt(dir)
    assert.equal(defaults.queryPriors({ failureSignature: { messagePattern: 'command failed' } }).totalMatched, 0)
    const legacy = await serviceAt(dir, { enableLegacyExperience: true })
    const result = legacy.queryPriors({ failureSignature: { messagePattern: 'command failed' } })
    assert.equal(result.totalMatched, 1)
    assert.equal(result.priors[0].verification, undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('9. eval-holdout verified entries never inject', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-v7-'))
  try {
    await makeVerificationFixture(dir, { source: { taskId: 'eval-task', cycleId: 'c1', failurePattern: 'command failed', taskDomain: 'eval-holdout' } })
    const service = await serviceAt(dir, { enableLegacyExperience: true })
    assert.equal(service.queryPriors({ failureSignature: { messagePattern: 'command failed' } }).totalMatched, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('10. active appliedComponents seed and rolled-back revision eviction', async () => {
  const activeDir = await mkdtemp(path.join(tmpdir(), 'h2-meta-v8-'))
  try {
    const activePath = path.join(activeDir, 'apply', 'active.json')
    await mkdir(path.dirname(activePath), { recursive: true })
    await writeFile(activePath, JSON.stringify({ schema: 'harness2-apply/v1', status: 'active', revisionId: 'rev-1', appliedComponents: ['system-prompt'] }), 'utf8')
    await makeVerificationFixture(activeDir)
    // fixture's index lives at activeDir/eval; service uses its own index path
    const seeded = new plugin.Harness2ExperienceService({
      experiencePath: path.join(activeDir, 'EXPERIENCE.md'), maxExperienceEntries: 50, topKInjection: 5,
      minConfidenceToInject: 0.4, minNegativeConfidenceToInject: 0.3, enableNegativeExperience: true,
      enableLegacyExperience: false, evaluationsPath: path.join(activeDir, 'eval', 'index.jsonl'),
      ledgerPath: path.join(activeDir, 'ledger.jsonl'), applyStatePath: activePath, onError: () => {},
    })
    await seeded.settled
    assert.equal(seeded.queryPriors({ failureSignature: { messagePattern: 'command failed' } }).totalMatched, 0)
    await writeFile(activePath, JSON.stringify({ schema: 'harness2-apply/v1', status: 'rolled-back', revisionId: 'rev-3aa3b56f7f5f', contentHashes: ['sha256:' + 'a'.repeat(64)] }), 'utf8')
    const evicted = await serviceAt(activeDir, { applyStatePath: activePath })
    assert.equal(evicted.queryPriors({ failureSignature: { messagePattern: 'command failed' } }).totalMatched, 0)
  } finally { await rm(activeDir, { recursive: true, force: true }) }
})

test('11. verification round-trips through EXPERIENCE serialization', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-v9-'))
  try {
    await makeVerificationFixture(dir)
    const service = await serviceAt(dir)
    const entry = service.entries()[0]
    assert.ok(entry.verification)
    const text = plugin.serializeExperience(service.entries())
    const parsed = plugin.parseExperience(text)
    assert.equal(parsed.entries[0].verification.reportHash, entry.verification.reportHash)
    assert.equal(parsed.entries[0].verification.verdict, 'accept')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('12. composed source evidence is used for failurePattern (not eval task text)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-v10-'))
  try {
    await makeVerificationFixture(dir, { source: { taskId: 'source-task', cycleId: 'c1', failurePattern: 'exit code 127 missing binary', taskDomain: 'repo-fix' } })
    const service = await serviceAt(dir)
    const entry = service.queryPriors({ failureSignature: { messagePattern: 'exit code 127' } }).priors[0]
    assert.match(entry.condition.failurePattern, /exit code 127/)
    assert.equal(entry.edit.contentPreview.includes('eval-holdout'), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('13. legacy migration still applies to quarantined entries', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-v11-'))
  try {
    const legacy = legacyEntry({ edit: { component: 'context-assembly', operation: 'set-persona-prefix', contentHash: 'sha256:' + 'b'.repeat(64), contentPreview: '' } })
    await writeFile(path.join(dir, 'EXPERIENCE.md'), plugin.serializeExperience([legacy]), 'utf8')
    const service = await serviceAt(dir, { enableLegacyExperience: true })
    const entry = service.queryPriors({ failureSignature: { messagePattern: 'command failed' } }).priors[0]
    assert.equal(entry.edit.component, 'system-prompt')
    assert.equal(entry.migratedFrom, 'context-assembly')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('14. facade remains two-key frozen and queryPriors stays sync read-only', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-meta-v12-'))
  try {
    const service = await serviceAt(dir)
    const facade = Object.freeze({ get ready() { return service.ready }, queryPriors: service.queryPriors })
    assert.deepEqual(Object.keys(facade).sort(), ['queryPriors', 'ready'])
    const result = facade.queryPriors({ failureSignature: {} })
    assert.deepEqual(result, { priors: [], totalMatched: 0 })
    assert.equal(typeof facade.queryPriors({ failureSignature: { toolName: 'bash' } }).then, 'undefined')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
