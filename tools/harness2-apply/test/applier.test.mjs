/**
 * PR-3 applier unit/integration tests (no real dsh runtime required).
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { applyManagedBlock, hashOf, sha256Hex } from '../src/lib.mjs'
import { buildReport, hashOf as evalHashOf, loadPrereg, loadTasks, reportHash as evalReportHash } from '../../harness2-eval/src/lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const CLI = path.join(APP, 'bin', 'harness2-apply.mjs')
const FAKE_CLI = path.join(HERE, 'fixtures', 'fake-dsh.mjs')
const PERSONA = 'You are a coding agent that checks the failing command before retrying.'

const candidateId = (type, component, content) =>
  `cand-${sha256Hex(`${type}:${component}:${content}`).slice(0, 16)}`

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 120_000,
  })
  let json
  try { json = JSON.parse((result.stdout || result.stderr).trim()) } catch { json = undefined }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json }
}

async function setup({ content = PERSONA, component = 'system-prompt', operation = 'set-persona-prefix', ledgerCandidateId = undefined } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'h2-apply-'))
  const home = path.join(dir, 'home')
  const profile = 'test-profile'
  const profileDir = path.join(home, 'profiles', profile)
  await mkdir(profileDir, { recursive: true })
  await writeFile(path.join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8')
  const ledgerPath = path.join(dir, 'ledger.jsonl')
  const editsDir = path.join(dir, 'edits')
  await mkdir(editsDir, { recursive: true })
  const contentHash = hashOf(content)
  const id = candidateId('invariant', component, content)
  const body = {
    schema: 'harness2-edit/v1', contentHash, candidateId: id, candidateType: 'invariant',
    component, operation, content,
    renderer: { kind: 'persona-prefix', hints: {} },
    taskId: 'task-1', cycleId: 'cycle-1', createdAt: new Date().toISOString(),
  }
  await writeFile(path.join(editsDir, `${contentHash.slice(7)}.json`), `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  await writeFile(ledgerPath, `${JSON.stringify({
    version: 'harness2-ledger/v3', id: 'led-cycle-1', previousSnapshotRef: null,
    ledgerEntryId: 'led-cycle-1', event: 'compose/applied', recordedAt: new Date().toISOString(),
    payload: {
      taskId: 'task-1', cycleId: 'cycle-1',
      appliedCandidateIds: [ledgerCandidateId ?? id],
      appliedEdits: [{ candidateId: ledgerCandidateId ?? id, contentHash, component, operation }],
      appliedComponents: [component], previousSnapshotRef: 'none', ledgerEntryId: 'led-cycle-1',
      applyMode: 'next-task-ledger',
    },
  })}\n`, 'utf8')
  return { dir, home, profile, profileDir, ledgerPath, editsDir, contentHash, body, id }
}

async function evaluationReport(ctx, planned, { accept = true } = {}) {
  const repo = path.resolve(HERE, '..', '..', '..')
  const tasksFile = path.join(repo, 'e2e', 'holdout', 'tasks.jsonl')
  const preregFile = path.join(repo, 'e2e', 'holdout', 'preregistration.json')
  const { tasks, text } = await loadTasks(tasksFile)
  const prereg = await loadPrereg(preregFile)
  const realPrereg = { ...prereg, providerClass: 'real' }
  const realPreregFile = path.join(ctx.dir, 'prereg-real.json')
  const realTasksFile = path.join(ctx.dir, 'tasks.jsonl')
  await writeFile(realPreregFile, JSON.stringify(realPrereg, null, 2) + '\n', 'utf8')
  await writeFile(realTasksFile, text, 'utf8')
  const batch = tasks.filter((task) => task.fold === 0)
  const manifest = JSON.parse(await readFile(path.join(planned.json.dir, 'manifest.json'), 'utf8'))
  const perTask = batch.map((task, index) => {
    const tSuccess = accept && index < 10
    const arms = {
      C: { success: false, toolFailures: 0, stepCount: 1, tokenCost: 1000, durationMs: 5, mountFailed: false, schemaFailed: false },
      R: { success: false, toolFailures: 0, stepCount: 1, tokenCost: 1000, durationMs: 5, mountFailed: false, schemaFailed: false },
      I: { success: false, toolFailures: 0, stepCount: 1, tokenCost: 1000, durationMs: 5, mountFailed: false, schemaFailed: false },
      T: { success: tSuccess, toolFailures: 0, stepCount: 1, tokenCost: 1000, durationMs: 5, mountFailed: false, schemaFailed: false },
    }
    return { taskId: task.id, arms }
  })
  const report = buildReport({
    batchId: 'batch-f0-test', revisionId: manifest.revId, profile: manifest.profile,
    cycleId: manifest.cycleId, contentHash: manifest.contentHashes[0], planToken: manifest.planToken,
    prereg: realPrereg, preregHash: evalHashOf(await readFile(realPreregFile, 'utf8')), tasksHash: evalHashOf(text),
    perTask, fold: 0, evaluatedAt: new Date().toISOString(),
  })
  const file = path.join(ctx.dir, 'evaluation.json')
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return { file, report, preregFile: realPreregFile, tasksFile: realTasksFile }
}

async function plan(ctx, extra = []) {
  return run(['plan', '--home', ctx.home, '--profile', ctx.profile, '--ledger', ctx.ledgerPath, '--edits', ctx.editsDir, '--cli', FAKE_CLI, ...extra])
}

test('render: managed block replaces the empty [] patch, preserves outside rows, round-trips', () => {
  const base = '[]\n'
  const next = applyManagedBlock(base, 'rev-aaaaaaaaaaaa', 'sha256:' + 'a'.repeat(64), [{
    rowId: 'system-prompt', row: { id: 'system-prompt', name: 'name', config: { personaPrefix: 'BASE' } },
    config: { personaPrefix: PERSONA, toolDescription: 'keep-me' },
  }])
  assert.match(next, /# >>> harness2:managed rev rev-aaaaaaaaaaaa sha256:/)
  assert.match(next, /personaPrefix: You are a coding agent/)
  const other = '- id: other\n  config:\n    x: 1\n'
  const appended = applyManagedBlock(other, 'rev-bbbbbbbbbbbb', hashOf('x'), [{
    rowId: 'system-prompt', row: { id: 'system-prompt' }, config: { personaPrefix: PERSONA },
  }])
  assert.ok(appended.startsWith(other), 'outside bytes are preserved')
  assert.match(appended, /# <<< harness2:managed/)
  const replaced = applyManagedBlock(appended, 'rev-cccccccccccc', hashOf('y'), [{
    rowId: 'system-prompt', row: { id: 'system-prompt' }, config: { personaPrefix: PERSONA },
  }])
  assert.match(replaced, /rev-cccccccccccc/)
  assert.equal((replaced.match(/# >>> harness2:managed/g) ?? []).length, 1)
})

test('plan: renders persona into a revision, preserves config keys, writes manifest/plan/token', async () => {
  const ctx = await setup()
  try {
    const result = await plan(ctx)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.json.ok, true)
    assert.match(result.json.revId, /^rev-[0-9a-f]{12}$/)
    assert.equal(typeof result.json.planToken, 'string')
    assert.equal(result.json.smokeRequired, false)
    const patch = await readFile(path.join(result.json.dir, 'patch.yml'), 'utf8')
    assert.match(patch, /personaPrefix: You are a coding agent/)
    assert.match(patch, /toolDescription: keep-me/, 'untouched config keys are restated')
    const manifest = JSON.parse(await readFile(path.join(result.json.dir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.basePatchHash, hashOf('[]\n'))
    assert.equal(manifest.evaluation, 'not-run')
  } finally { await rm(ctx.dir, { recursive: true, force: true }) }
})

test('plan: rejects missing body, tampered hash and body metadata mismatch (allow flag only for plan)', async () => {
  const missing = await setup()
  try {
    await rm(path.join(missing.editsDir, `${missing.contentHash.slice(7)}.json`))
    const result = await plan(missing)
    assert.equal(result.status, 1)
    assert.equal(result.json.code, 'edit-body-missing')
  } finally { await rm(missing.dir, { recursive: true, force: true }) }

  const tampered = await setup()
  try {
    const file = path.join(tampered.editsDir, `${tampered.contentHash.slice(7)}.json`)
    const body = JSON.parse(await readFile(file, 'utf8'))
    await writeFile(file, JSON.stringify({ ...body, content: 'tampered body content' }), 'utf8')
    const result = await plan(tampered)
    assert.equal(result.status, 1)
    assert.equal(result.json.code, 'edit-body-missing')
  } finally { await rm(tampered.dir, { recursive: true, force: true }) }

  const mismatch = await setup({ ledgerCandidateId: 'cand-0000000000000000' })
  try {
    const rejected = await plan(mismatch)
    assert.equal(rejected.status, 1)
    assert.equal(rejected.json.code, 'body-metadata-mismatch')
    const allowed = await plan(mismatch, ['--allow-body-metadata-mismatch'])
    assert.equal(allowed.status, 0, allowed.stderr)
  } finally { await rm(mismatch.dir, { recursive: true, force: true }) }
})

test('preflight: skipped bundle fails, toolOrder without smoke fails, persona succeeds and records preflight', async () => {
  const ctx = await setup()
  try {
    const planned = await plan(ctx)
    assert.equal(planned.status, 0)
    const skipped = await run(['preflight', '--home', ctx.home, '--rev', planned.json.revId, '--cli', FAKE_CLI], { FAKE_SKIP_BUNDLE: '1' })
    assert.equal(skipped.status, 1)
    assert.equal(skipped.json.code, 'preflight-skipped-bundle')
    const ok = await run(['preflight', '--home', ctx.home, '--rev', planned.json.revId, '--cli', FAKE_CLI])
    assert.equal(ok.status, 0, ok.stderr)
    assert.equal(JSON.parse(await readFile(path.join(planned.json.dir, 'preflight.json'), 'utf8')).ok, true)
  } finally { await rm(ctx.dir, { recursive: true, force: true }) }

  const tool = await setup({ component: 'tool-guidance', operation: 'set-tool-order', content: '["bash","read","<unlisted-tools>"]' })
  try {
    const planned = await plan(tool)
    assert.equal(planned.status, 0, planned.stderr)
    assert.equal(planned.json.smokeRequired, true)
    const noSmoke = await run(['preflight', '--home', tool.home, '--rev', planned.json.revId, '--cli', FAKE_CLI])
    assert.equal(noSmoke.status, 1)
    assert.equal(noSmoke.json.code, 'smoke-required')
    const withSmoke = await run(['preflight', '--home', tool.home, '--rev', planned.json.revId, '--cli', FAKE_CLI, '--smoke-cmd', `${process.execPath} -e "process.exit(0)"`])
    assert.equal(withSmoke.status, 0, withSmoke.stderr)
  } finally { await rm(tool.dir, { recursive: true, force: true }) }
})

test('apply: token/preflight/flags enforced; writes patch, backup, active and journal', async () => {
  const ctx = await setup()
  try {
    const planned = await plan(ctx)
    assert.equal(planned.status, 0)
    const noPreflight = await run(['apply', '--home', ctx.home, '--rev', planned.json.revId, '--token', planned.json.planToken, '--allow-unevaluated', '--yes'])
    assert.equal(noPreflight.status, 1)
    assert.equal(noPreflight.json.code, 'preflight-required')
    const pre = await run(['preflight', '--home', ctx.home, '--rev', planned.json.revId, '--cli', FAKE_CLI])
    assert.equal(pre.status, 0)
    const noToken = await run(['apply', '--home', ctx.home, '--rev', planned.json.revId, '--token', 'sha256:' + '0'.repeat(64), '--allow-unevaluated', '--yes'])
    assert.equal(noToken.status, 1)
    assert.equal(noToken.json.code, 'token-mismatch')
    const noUnevaluated = await run(['apply', '--home', ctx.home, '--rev', planned.json.revId, '--token', planned.json.planToken, '--yes'])
    assert.equal(noUnevaluated.status, 1)
    assert.equal(noUnevaluated.json.code, 'evaluation-required')
    const forcedWithoutEnv = await run(['apply', '--home', ctx.home, '--rev', planned.json.revId, '--token', planned.json.planToken, '--allow-unevaluated', '--yes'])
    assert.equal(forcedWithoutEnv.status, 1)
    assert.equal(forcedWithoutEnv.json.code, 'evaluation-force-env-required')
    const evaluation = await evaluationReport(ctx, planned)
    const applied = await run(['apply', '--home', ctx.home, '--rev', planned.json.revId, '--token', planned.json.planToken, '--evaluation', evaluation.file, '--prereg', evaluation.preregFile, '--tasks', evaluation.tasksFile, '--yes'])
    assert.equal(applied.status, 0, applied.stderr)
    assert.equal(applied.json.reload, 'restart-required')
    assert.equal(applied.json.evaluation, 'accept')
    assert.equal(applied.json.verdict, 'accept')
    const patch = await readFile(path.join(ctx.profileDir, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /# >>> harness2:managed/)
    assert.match(patch, /personaPrefix: You are a coding agent/)
    await stat(path.join(planned.json.dir, 'backup', 'cordis.patch.yml'))
    const active = JSON.parse(await readFile(path.join(ctx.home, 'apply', 'active.json'), 'utf8'))
    assert.equal(active.revisionId, planned.json.revId)
    assert.equal(active.evaluation, 'accept')
    assert.equal(active.verdict, 'accept')
    assert.equal(active.evaluationReportHash, evaluation.report.reportHash)
    const journal = (await readFile(path.join(ctx.home, 'apply', 'journal.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(journal.at(-1).kind, 'committed')
    assert.equal(journal.at(-1).evaluation, 'accept')
    assert.equal(journal.at(-1).batchId, 'batch-f0-test')
    const recorded = JSON.parse(await readFile(path.join(planned.json.dir, 'manifest.json'), 'utf8'))
    assert.equal(recorded.application.evaluationReportHash, evaluation.report.reportHash)
    const verify = await run(['verify', '--home', ctx.home, '--rev', planned.json.revId, '--cli', FAKE_CLI])
    assert.equal(verify.status, 0, verify.stderr)
    const rolled = await run(['rollback', '--home', ctx.home, '--rev', planned.json.revId])
    assert.equal(rolled.status, 0, rolled.stderr)
    assert.equal(await readFile(path.join(ctx.profileDir, 'cordis.patch.yml'), 'utf8'), '[]\n')
    const again = await run(['rollback', '--home', ctx.home, '--rev', planned.json.revId])
    assert.equal(again.status, 0)
    assert.equal(again.json.alreadyBase, true)
  } finally { await rm(ctx.dir, { recursive: true, force: true }) }
})

test('rollback: modified patch requires --force; desktop profile is refused', async () => {
  const ctx = await setup()
  try {
    const planned = await plan(ctx)
    await run(['preflight', '--home', ctx.home, '--rev', planned.json.revId, '--cli', FAKE_CLI])
    const evaluation = await evaluationReport(ctx, planned)
    await run(['apply', '--home', ctx.home, '--rev', planned.json.revId, '--token', planned.json.planToken, '--evaluation', evaluation.file, '--prereg', evaluation.preregFile, '--tasks', evaluation.tasksFile, '--yes'])
    await writeFile(path.join(ctx.profileDir, 'cordis.patch.yml'), '# externally changed\n[]\n', 'utf8')
    const refused = await run(['rollback', '--home', ctx.home, '--rev', planned.json.revId])
    assert.equal(refused.status, 1)
    assert.equal(refused.json.code, 'patch-modified')
    const forced = await run(['rollback', '--home', ctx.home, '--rev', planned.json.revId, '--force'])
    assert.equal(forced.status, 0, forced.stderr)
    assert.equal(JSON.parse(await readFile(path.join(ctx.home, 'apply', 'active.json'), 'utf8')).status, 'rolled-back')

    const desktop = run(['plan', '--home', ctx.home, '--profile', 'desktop', '--ledger', ctx.ledgerPath, '--edits', ctx.editsDir, '--cli', FAKE_CLI])
    assert.equal(desktop.status, 1)
    assert.equal(desktop.json.code, 'desktop-profile-refused')
  } finally { await rm(ctx.dir, { recursive: true, force: true }) }
})


test('cli: --help and the help subcommand print usage', () => {
  for (const args of [['--help'], ['-h'], ['help']]) {
    const result = run(args)
    assert.equal(result.status, 0, `${args.join(' ')} must exit 0: ${result.stderr}`)
    assert.match(result.stdout, /harness2-apply — PR-3 offline profile-patch applier/)
    assert.match(result.stdout, /Usage:/)
    assert.match(result.stdout, /apply --rev <rev> --token <planToken> --evaluation <report.json> --yes/)
  }
  const unknown = run(['--not-a-command'])
  assert.equal(unknown.status, 1)
  assert.equal(unknown.json.code, 'unknown-command')
})


test('apply: evaluation report required; reject/mismatch/forced-escape hatch enforced', async () => {
  const ctx = await setup()
  try {
    const planned = await plan(ctx)
    await run(['preflight', '--home', ctx.home, '--rev', planned.json.revId, '--cli', FAKE_CLI])
    // reject verdict is refused
    const rejectedReport = await evaluationReport(ctx, planned, { accept: false })
    const rejected = await run(['apply', '--home', ctx.home, '--rev', planned.json.revId, '--token', planned.json.planToken, '--evaluation', rejectedReport.file, '--prereg', rejectedReport.preregFile, '--tasks', rejectedReport.tasksFile, '--yes'])
    assert.equal(rejected.status, 1)
    assert.equal(rejected.json.code, 'evaluation-rejected')
    // report with the wrong revision is refused
    const good = await evaluationReport(ctx, planned)
    const tampered = { ...good.report, revisionId: 'rev-000000000000' }
    const tamperedFile = path.join(ctx.dir, 'tampered-eval.json')
    await writeFile(tamperedFile, JSON.stringify(tampered), 'utf8')
    const mismatch = await run(['apply', '--home', ctx.home, '--rev', planned.json.revId, '--token', planned.json.planToken, '--evaluation', tamperedFile, '--prereg', good.preregFile, '--tasks', good.tasksFile, '--yes'])
    assert.equal(mismatch.status, 1)
    assert.equal(mismatch.json.code, 'evaluation-invalid')
    // forced escape hatch requires the env var and records forced-unevaluated
    const forced = await run(['apply', '--home', ctx.home, '--rev', planned.json.revId, '--token', planned.json.planToken, '--allow-unevaluated', '--yes'], { HARNESS2_ALLOW_UNEVALUATED: '1' })
    assert.equal(forced.status, 0, forced.stderr)
    assert.equal(forced.json.evaluation, 'forced-unevaluated')
    const journal = (await readFile(path.join(ctx.home, 'apply', 'journal.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(journal.at(-1).evaluation, 'forced-unevaluated')
    assert.equal(journal.at(-1).verdict, 'forced-unevaluated')
  } finally { await rm(ctx.dir, { recursive: true, force: true }) }
})


test('evaluation forgery: accept with forged stats/fold/provider/fields is rejected', async () => {
  const ctx = await setup()
  try {
    const planned = await plan(ctx)
    await run(['preflight', '--home', ctx.home, '--rev', planned.json.revId, '--cli', FAKE_CLI])
    const good = await evaluationReport(ctx, planned)
    const writeReport = async (report, name) => {
      const file = path.join(ctx.dir, name)
      report.reportHash = evalReportHash(report)
      await writeFile(file, JSON.stringify(report), 'utf8')
      return file
    }
    const applyWith = (file) => run(['apply', '--home', ctx.home, '--rev', planned.json.revId,
      '--token', planned.json.planToken, '--evaluation', file,
      '--prereg', good.preregFile, '--tasks', good.tasksFile, '--yes'])

    const n1 = { ...good.report, perTask: good.report.perTask.slice(0, 1), N: 1, b: 1, c: 0, delta: 1, p: 0.5, verdict: 'accept' }
    const n1Result = await applyWith(await writeReport(n1, 'forged-n1.json'))
    assert.equal(n1Result.status, 1)
    assert.equal(n1Result.json.code, 'evaluation-invalid')

    const badB = { ...good.report, b: 11 }
    assert.equal((await applyWith(await writeReport(badB, 'forged-b.json'))).status, 1)

    const badP = { ...good.report, p: 0.0001 }
    assert.equal((await applyWith(await writeReport(badP, 'forged-p.json'))).status, 1)

    const wrongTask = { ...good.report, perTask: good.report.perTask.map((task, index) => index === 0 ? { ...task, taskId: 'not-a-holdout-task' } : task) }
    const wrongTaskResult = await applyWith(await writeReport(wrongTask, 'forged-task.json'))
    assert.equal(wrongTaskResult.status, 1)
    assert.equal(wrongTaskResult.json.code, 'evaluation-mismatch')

    const extraField = { ...good.report, forged: true }
    assert.equal((await applyWith(await writeReport(extraField, 'forged-extra.json'))).status, 1)

    const fakeProvider = { ...good.report, providerClass: 'fake-calibration' }
    const fakeResult = await applyWith(await writeReport(fakeProvider, 'forged-fake.json'))
    assert.equal(fakeResult.status, 1)
    assert.equal(fakeResult.json.code, 'evaluation-fake-provider')

    const badSecondary = { ...good.report, secondary: { ...good.report.secondary, medianToolFailuresT: 99 } }
    assert.equal((await applyWith(await writeReport(badSecondary, 'forged-secondary.json'))).status, 1)

    const wrongFold = { ...good.report, fold: 99 }
    assert.equal((await applyWith(await writeReport(wrongFold, 'forged-fold.json'))).status, 1)

    // Unmodified real-provider report still applies.
    const ok = await applyWith(good.file)
    assert.equal(ok.status, 0, ok.stderr)
    assert.equal(ok.json.evaluation, 'accept')
  } finally { await rm(ctx.dir, { recursive: true, force: true }) }
})
