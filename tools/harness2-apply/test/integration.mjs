/**
 * Optional PR-3 live integration: plan → preflight → apply → verify dump →
 * rollback against an isolated DSH_HOME/profile, using a real 0.2.1 CLI and the
 * committed stage0:r6:positive ledger/edits. Never touches the desktop profile.
 */
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readFile as readText, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { hashOf } from '../src/lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const APP = path.join(REPO, 'tools', 'harness2-apply', 'bin', 'harness2-apply.mjs')
const CLI = process.env.HARNESS2_DSH_CLI ?? '/tmp/dsh021/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
const LEDGER = path.join(REPO, 'e2e', 'stage0-r6', 'artifacts', 'positive', 'ledger.jsonl')
const EDITS = path.join(REPO, 'e2e', 'stage0-r6', 'artifacts', 'positive', 'edits')

function run(cmd, args, env) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 180_000 })
  if (result.status !== 0) throw new Error(`command failed: ${cmd} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

async function main() {
  if (spawnSync('test', ['-f', CLI]).status !== 0) {
    console.log(`SKIP: dsh CLI not found at ${CLI}; set HARNESS2_DSH_CLI to a 0.2.1 bin.js`)
    return
  }
  const root = await mkdtemp(path.join(tmpdir(), 'h2-apply-integration-'))
  const home = path.join(root, 'home')
  const profile = 'pr3-int'
  const env = { DSH_HOME: home }
  try {
    run(process.execPath, [CLI, '--profile', profile, '--from-default-profile', 'headless', '--dump-config'], env)
    for (const name of ['harness2-task-recursion', 'harness2-meta-recursion']) {
      run(process.execPath, [CLI, 'plugin', '--profile', profile, 'add', path.join(REPO, 'packages', name)], env)
    }
    const basePatchPath = path.join(home, 'profiles', profile, 'cordis.patch.yml')
    const basePatch = await readFile(basePatchPath, 'utf8')
    const app = (args) => JSON.parse(run(process.execPath, [APP, ...args], env))
    const planned = app(['plan', '--home', home, '--profile', profile, '--ledger', LEDGER, '--edits', EDITS, '--cli', CLI])
    const pre = app(['preflight', '--home', home, '--rev', planned.revId, '--cli', CLI])
    if (pre.ok !== true) throw new Error('preflight not ok')
    const applied = app(['apply', '--home', home, '--rev', planned.revId, '--token', planned.planToken, '--allow-unevaluated', '--yes', '--cli', CLI])
    const dump = run(process.execPath, [CLI, '--profile', profile, '--dump-config'], env)
    const ledgerRecords = (await readFile(LEDGER, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const appliedRecord = [...ledgerRecords].reverse().find((record) => record.event === 'compose/applied')
    const appliedEdit = appliedRecord.payload.appliedEdits[0]
    const body = JSON.parse(await readFile(path.join(EDITS, `${appliedEdit.contentHash.slice(7)}.json`), 'utf8'))
    if (!dump.includes(body.content.slice(0, 40))) throw new Error('applied persona not visible in dump')
    app(['verify', '--home', home, '--rev', planned.revId, '--cli', CLI])
    const rolled = app(['rollback', '--home', home, '--rev', planned.revId])
    if (rolled.restoredPatchHash !== hashOf(basePatch)) throw new Error('rollback hash mismatch')
    const restored = await readText(basePatchPath, 'utf8')
    if (restored !== basePatch) throw new Error('rollback did not restore base patch bytes')
    console.log(JSON.stringify({
      ok: true, profile, revId: planned.revId, applyReload: applied.reload,
      evaluation: 'not-run', restored: true,
    }, null, 2))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
