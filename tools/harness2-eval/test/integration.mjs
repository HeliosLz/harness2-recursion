/**
 * PR-4 synthetic integration: applier revision → fake-matrix four-arm eval →
 * accept report → applier apply with --evaluation → verify → rollback.
 * Uses the fake dsh CLI fixture; this is calibration evidence, not real efficacy.
 */
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildReport, fakeMatrixRunner, hashOf, loadPrereg, loadTasks, runBatch } from '../src/lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const APPLY = path.join(REPO, 'tools', 'harness2-apply', 'bin', 'harness2-apply.mjs')
const FAKE_CLI = path.join(REPO, 'tools', 'harness2-apply', 'test', 'fixtures', 'fake-dsh.mjs')
const TASKS_FILE = path.join(REPO, 'e2e', 'holdout', 'tasks.jsonl')
const PREREG_FILE = path.join(REPO, 'e2e', 'holdout', 'preregistration.json')
const PERSONA = 'You are a coding agent that verifies an applied profile patch before continuing.'
const candidateId = (type, component, content) => `cand-${hashOf(`${type}:${component}:${content}`).slice(7, 23)}`

function run(args, env = {}) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120_000 })
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-pr4-integration-'))
  try {
    const home = path.join(dir, 'home')
    const profile = 'pr4-int'
    const profileDir = path.join(home, 'profiles', profile)
    await mkdir(profileDir, { recursive: true })
    await writeFile(path.join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8')
    const ledgerPath = path.join(dir, 'ledger.jsonl')
    const editsDir = path.join(dir, 'edits')
    await mkdir(editsDir, { recursive: true })
    const contentHash = hashOf(PERSONA)
    const id = candidateId('invariant', 'system-prompt', PERSONA)
    const body = {
      schema: 'harness2-edit/v1', contentHash, candidateId: id, candidateType: 'invariant',
      component: 'system-prompt', operation: 'set-persona-prefix', content: PERSONA,
      renderer: { kind: 'persona-prefix', hints: {} }, taskId: 'task-int', cycleId: 'cycle-int',
      createdAt: new Date().toISOString(),
    }
    await writeFile(path.join(editsDir, `${contentHash.slice(7)}.json`), `${JSON.stringify(body, null, 2)}\n`, 'utf8')
    await writeFile(ledgerPath, `${JSON.stringify({
      version: 'harness2-ledger/v3', id: 'led-int', event: 'compose/applied',
      payload: {
        taskId: 'task-int', cycleId: 'cycle-int', appliedCandidateIds: [id],
        appliedEdits: [{ candidateId: id, contentHash, component: 'system-prompt', operation: 'set-persona-prefix' }],
        appliedComponents: ['system-prompt'], previousSnapshotRef: 'none', ledgerEntryId: 'led-int', applyMode: 'next-task-ledger',
      },
    })}\n`, 'utf8')
    const planned = run([APPLY, 'plan', '--home', home, '--profile', profile, '--ledger', ledgerPath, '--edits', editsDir, '--cli', FAKE_CLI])
    run([APPLY, 'preflight', '--home', home, '--rev', planned.revId, '--cli', FAKE_CLI])
    const manifest = JSON.parse(await readFile(path.join(planned.dir, 'manifest.json'), 'utf8'))
    const { tasks, text } = await loadTasks(TASKS_FILE)
    const prereg = await loadPrereg(PREREG_FILE)
    const batch = tasks.filter((task) => task.fold === 0)
    const matrix = {}
    for (const [index, task] of batch.entries()) {
      for (const arm of ['C', 'R', 'I', 'T']) {
        matrix[`${task.id}:${arm}`] = { success: arm === 'T' && index < 10, toolFailures: 0, stepCount: 1, tokenCost: 1000 }
      }
    }
    const runReport = await runBatch({
      revisionId: manifest.revId, profile, cycleId: manifest.cycleId, contentHash,
      planToken: manifest.planToken, prereg, batch,
      tasksHash: hashOf(text), preregHash: hashOf(await readFile(PREREG_FILE, 'utf8')),
      runner: fakeMatrixRunner(matrix), batchId: 'batch-pr4-int',
    })
    const reportFile = path.join(dir, 'report.json')
    await writeFile(reportFile, `${JSON.stringify(runReport.report, null, 2)}\n`, 'utf8')
    const applied = run([APPLY, 'apply', '--home', home, '--rev', planned.revId, '--token', planned.planToken, '--evaluation', reportFile, '--yes'])
    if (applied.evaluation !== 'accept') throw new Error('apply did not record accept evaluation')
    run([APPLY, 'verify', '--home', home, '--rev', planned.revId, '--cli', FAKE_CLI])
    const rolled = run([APPLY, 'rollback', '--home', home, '--rev', planned.revId])
    if (rolled.restoredPatchHash !== hashOf('[]\n')) throw new Error('rollback did not restore base patch')
    console.log(JSON.stringify({
      ok: true, profile, revisionId: planned.revId, verdict: runReport.report.verdict,
      b: runReport.report.b, c: runReport.report.c, evaluation: applied.evaluation,
      providerClass: prereg.providerClass, note: 'synthetic fake-matrix calibration; not real efficacy',
    }, null, 2))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await main()
