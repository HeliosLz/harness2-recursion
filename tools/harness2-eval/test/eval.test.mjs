/** PR-4 Gate-B statistics / preregistration / report / replay tests. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  EVAL_SCHEMA, buildReport, exactMcNemarOneSided, hashOf, loadPrereg, loadTasks,
  makeInertPatch, replayReport, reportHash, runBatch, validatePrereg, validateReport, evaluateVerdict,
  fakeMatrixRunner,
} from '../src/lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const TASKS_FILE = path.join(REPO, 'e2e', 'holdout', 'tasks.jsonl')
const PREREG_FILE = path.join(REPO, 'e2e', 'holdout', 'preregistration.json')

async function fixtures() {
  const { tasks, text } = await loadTasks(TASKS_FILE)
  const prereg = await loadPrereg(PREREG_FILE)
  return { tasks, tasksText: text, prereg, tasksHash: hashOf(text), preregHash: hashOf(await readFile(PREREG_FILE, 'utf8')) }
}

function matrixFor(batch, { tSuccess = true, inertSuccess = false } = {}) {
  const matrix = {}
  for (const [index, task] of batch.entries()) {
    const success = tSuccess && index < 10
    matrix[`${task.id}:C`] = { success: false, toolFailures: 0, stepCount: 1, tokenCost: 1000 }
    matrix[`${task.id}:R`] = { success: false, toolFailures: 0, stepCount: 1, tokenCost: 1000 }
    matrix[`${task.id}:I`] = { success: inertSuccess && index < 10, toolFailures: 0, stepCount: 1, tokenCost: 1000 }
    matrix[`${task.id}:T`] = { success, toolFailures: 0, stepCount: 1, tokenCost: 1000 }
  }
  return matrix
}

test('statistics: paired b/c/delta and exact one-sided McNemar boundaries', () => {
  assert.equal(exactMcNemarOneSided(0, 0), 1)
  assert.equal(exactMcNemarOneSided(1, 0), 0.5)
  assert.equal(exactMcNemarOneSided(2, 0), 0.25)
  assert.ok(Math.abs(exactMcNemarOneSided(10, 0) - 0.0009765625) < 1e-12)
  assert.ok(exactMcNemarOneSided(0, 10) > 0.99)

  const baseArm = { success: false, toolFailures: 0, stepCount: 1, tokenCost: 1000 }
  const goodArm = { ...baseArm, success: true }
  const perTask = Array.from({ length: 12 }, (_, index) => ({
    taskId: `t${index}`,
    arms: { C: baseArm, R: baseArm, I: baseArm, T: index < 12 ? goodArm : baseArm },
  }))
  const { tasks, prereg } = { tasks: [], prereg: { n: 12, rules: { minDelta: 0.15, maxP: 0.05, toolFailureSlack: 1, tokenRatioMax: 1.25, maxDriftDiff: 2 } } }
  const stats = evaluateVerdict({ perTask, prereg })
  assert.equal(stats.b, 12)
  assert.equal(stats.c, 0)
  assert.equal(stats.delta, 1)
  assert.ok(stats.p < 0.05)
  assert.equal(stats.verdict, 'accept')
  assert.equal(stats.nullRevisionRejected, true)
})

test('statistics: inert/null accepted or incomplete data cannot be accepted', async () => {
  const { tasks, prereg } = await fixtures()
  const batch = tasks.filter((task) => task.fold === 0)
  const inertAccepted = batch.map((task) => ({
    taskId: task.id,
    arms: {
      C: { success: false, toolFailures: 0, tokenCost: 1000 },
      R: { success: false, toolFailures: 0, tokenCost: 1000 },
      I: { success: true, toolFailures: 0, tokenCost: 1000 },
      T: { success: true, toolFailures: 0, tokenCost: 1000 },
    },
  }))
  const stats = evaluateVerdict({ perTask: inertAccepted, prereg })
  assert.equal(stats.inert.accepted, true)
  assert.equal(stats.nullRevisionRejected, false)
  assert.equal(stats.verdict, 'reject')

  const incomplete = inertAccepted.slice(0, 5).map((task) => ({ ...task, arms: { ...task.arms, I: { success: false } } }))
  assert.equal(evaluateVerdict({ perTask: incomplete, prereg }).verdict, 'inconclusive')
})

test('prereg: tasksHash/arms/fold validation and replay rejects a modified preregistration', async () => {
  const { tasks, tasksText, prereg, preregHash } = await fixtures()
  assert.throws(() => validatePrereg({ prereg, tasks: { tasks }, tasksHash: hashOf('bogus'), fold: 0 }), /tasksHash/)
  assert.throws(() => validatePrereg({ prereg: { ...prereg, arms: ['C', 'T'] }, tasks: { tasks }, tasksHash: hashOf(tasksText), fold: 0 }), /arms/)
  assert.throws(() => validatePrereg({ prereg, tasks: { tasks }, tasksHash: hashOf(tasksText), fold: 99 }), /fold/)

  const dir = await mkdtemp(path.join(tmpdir(), 'h2-eval-replay-'))
  try {
    const tasksFile = path.join(dir, 'tasks.jsonl')
    const preregFile = path.join(dir, 'prereg.json')
    await writeFile(tasksFile, tasksText, 'utf8')
    await writeFile(preregFile, JSON.stringify(prereg, null, 2) + '\n', 'utf8')
    const batch = tasks.filter((task) => task.fold === 0)
    const matrix = matrixFor(batch)
    const run = await runBatch({
      revisionId: 'rev-000000000000', profile: 'p', cycleId: 'c', contentHash: 'sha256:' + 'a'.repeat(64),
      planToken: 'sha256:' + 'b'.repeat(64), prereg, batch, tasksHash: hashOf(tasksText), preregHash,
      runner: fakeMatrixRunner(matrix), batchId: 'batch-replay',
    })
    const reportFile = path.join(dir, 'report.json')
    await writeFile(reportFile, JSON.stringify(run.report, null, 2) + '\n', 'utf8')
    const replay = await replayReport({ reportFile, tasksFile, preregFile })
    assert.equal(replay.ok, true)
    assert.equal(replay.verdict, 'accept')
    // A prereg modified after the run no longer replays.
    await writeFile(preregFile, JSON.stringify({ ...prereg, n: 11 }, null, 2) + '\n', 'utf8')
    await assert.rejects(replayReport({ reportFile, tasksFile, preregFile }), /preregHash|verdict|tasks/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('report: accept matrix, schema/reportHash, inert and null checks', async () => {
  const { tasks, tasksText, prereg, tasksHash, preregHash } = await fixtures()
  const batch = tasks.filter((task) => task.fold === 0)
  const good = await runBatch({
    revisionId: 'rev-111111111111', profile: 'p', cycleId: 'c', contentHash: 'sha256:' + 'a'.repeat(64),
    planToken: 'sha256:' + 'b'.repeat(64), prereg, batch, tasksHash, preregHash,
    runner: fakeMatrixRunner(matrixFor(batch)), batchId: 'batch-good',
  })
  assert.equal(good.report.schema, EVAL_SCHEMA)
  assert.equal(good.report.verdict, 'accept')
  assert.equal(good.report.reportHash, reportHash(good.report))
  assert.deepEqual(validateReport(good.report, { prereg, tasksHash, preregHash }), [])
  assert.equal(good.report.perTask.length, 12)
  assert.equal(good.report.order, undefined) // order is in runs / not part of schema

  const tampered = { ...good.report, delta: 0 }
  assert.ok(validateReport(tampered, { prereg, tasksHash, preregHash }).length > 0)

  const inert = await runBatch({
    revisionId: 'rev-222222222222', profile: 'p', cycleId: 'c', contentHash: 'sha256:' + 'a'.repeat(64),
    planToken: 'sha256:' + 'b'.repeat(64), prereg, batch, tasksHash, preregHash,
    runner: fakeMatrixRunner(matrixFor(batch, { inertSuccess: true })), batchId: 'batch-inert',
  })
  assert.equal(inert.report.verdict, 'reject')
  assert.equal(inert.report.inert.accepted, true)
  assert.equal(inert.report.nullRevisionRejected, false)
})

test('inert patch: same shape, neutral string values, still parses', () => {
  const patch = `# >>> harness2:managed rev rev-aaaaaaaaaaaa sha256:${'a'.repeat(64)}\n- id: system-prompt\n  config:\n    personaPrefix: ORIGINAL PERSONA\n    toolDescription: keep\n# <<< harness2:managed\n`
  const inert = makeInertPatch(patch)
  assert.ok(inert.includes('personaPrefix:'))
  assert.ok(!inert.includes('ORIGINAL PERSONA'))
  assert.ok(inert.includes('toolDescription:'))
})

test('cli: help works before a subcommand and unknown commands fail', () => {
  const cli = path.join(REPO, 'tools', 'harness2-eval', 'bin', 'harness2-eval.mjs')
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /harness2-eval — PR-4 Gate-B/)
  const unknown = spawnSync(process.execPath, [cli, 'bogus'], { encoding: 'utf8' })
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /unknown-command/)
})
