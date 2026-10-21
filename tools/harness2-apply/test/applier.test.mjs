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
    const applied = await run(['apply', '--home', ctx.home, '--rev', planned.json.revId, '--token', planned.json.planToken, '--allow-unevaluated', '--yes'])
    assert.equal(applied.status, 0, applied.stderr)
    assert.equal(applied.json.reload, 'restart-required')
    const patch = await readFile(path.join(ctx.profileDir, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /# >>> harness2:managed/)
    assert.match(patch, /personaPrefix: You are a coding agent/)
    await stat(path.join(planned.json.dir, 'backup', 'cordis.patch.yml'))
    const active = JSON.parse(await readFile(path.join(ctx.home, 'apply', 'active.json'), 'utf8'))
    assert.equal(active.revisionId, planned.json.revId)
    assert.equal(active.evaluation, 'not-run')
    const journal = (await readFile(path.join(ctx.home, 'apply', 'journal.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(journal.at(-1).kind, 'committed')
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
    await run(['apply', '--home', ctx.home, '--rev', planned.json.revId, '--token', planned.json.planToken, '--allow-unevaluated', '--yes'])
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
    assert.match(result.stdout, /apply --rev <rev> --token <planToken> --allow-unevaluated --yes/)
  }
  const unknown = run(['--not-a-command'])
  assert.equal(unknown.status, 1)
  assert.equal(unknown.json.code, 'unknown-command')
})
