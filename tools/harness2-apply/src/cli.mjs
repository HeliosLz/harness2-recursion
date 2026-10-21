#!/usr/bin/env node
/**
 * harness2-apply CLI (PR-3 offline profile-patch applier).
 *
 * Commands: plan, preflight, apply, verify, rollback, status, help.
 * Exit codes: 0 ok, 1 user/blocked-by-policy error, 2 internal failure.
 */
import path from 'node:path'

import {
  ApplyError, applyRevision, findRevision, loadRevisionByIndex, planRevision,
  preflightRevision, resolveDshHome, rollbackRevision, statusReport, verifyRevision,
} from './lib.mjs'

const COMMANDS = new Set(['plan', 'preflight', 'apply', 'verify', 'rollback', 'status', 'help'])

function parseArgs(argv) {
  // `--help`/`-h` are global: they must work before a subcommand is chosen.
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return { command: 'help', options: {} }
  }
  const command = argv[0]
  if (!COMMANDS.has(command)) throw new ApplyError('unknown-command', `unknown command: ${String(command)}`)
  const options = {}
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (!arg.startsWith('--')) throw new ApplyError('invalid-argument', `unexpected argument: ${arg}`)
    const key = arg.slice(2)
    const booleanKeys = new Set(['yes', 'force', 'allow-unevaluated', 'allow-body-metadata-mismatch', 'help'])
    if (booleanKeys.has(key)) { options[key] = true; continue }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new ApplyError('missing-value', `missing value for --${key}`)
    index += 1
    options[key] = value
  }
  return { command, options }
}

function help() {
  return `harness2-apply — PR-3 offline profile-patch applier

Usage:
  harness2-apply plan --profile <name> --ledger <path> [--edits <dir>] [--cycle <id>] [--cli <dsh bin.js>]
  harness2-apply preflight --rev <rev> [--smoke-cmd <shell command>] [--cli <dsh bin.js>] [--home <DSH_HOME>]
  harness2-apply apply --rev <rev> --token <planToken> --allow-unevaluated --yes [--home <DSH_HOME>]
  harness2-apply verify --rev <rev> [--smoke-cmd <shell command>] [--cli <dsh bin.js>] [--home <DSH_HOME>]
  harness2-apply rollback --rev <rev> [--force] [--home <DSH_HOME>]
  harness2-apply status [--home <DSH_HOME>] [--edits <dir>]

Global options:
  --home <dir>   DSH_HOME override (default: $DSH_HOME or ~/.dsh)
  --cli <path>   dsh 0.2.1 CLI lib/bin.js (default: $HARNESS2_DSH_CLI or /tmp/dsh021/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js)
  --help         this help

Policy:
  - refuses the desktop profile and path traversal;
  - apply requires preflight + --yes + --allow-unevaluated (PR-4 Gate-B is not wired);
  - toolOrder / persona-suffix revisions require an explicit --smoke-cmd;
  - reload is reported as restart-required or hmr-pending-human-confirm, never "live".
`
}

function defaultCli() {
  return process.env.HARNESS2_DSH_CLI ?? '/tmp/dsh021/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
}

async function requireRevision(dshHome, rev, editsDir) {
  if (typeof rev !== 'string' || rev.length === 0) throw new ApplyError('missing-argument', '--rev is required')
  if (typeof editsDir === 'string') {
    const { loadRevision } = await import('./lib.mjs')
    return { ...(await loadRevision(path.resolve(editsDir), rev)), editsDir: path.resolve(editsDir) }
  }
  return loadRevisionByIndex(dshHome, rev)
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  if (command === 'help' || options.help) { process.stdout.write(help()); return }
  const dshHome = resolveDshHome(options.home)
  const cliPath = options.cli ?? defaultCli()
  if (command === 'plan') {
    if (typeof options.profile !== 'string' || typeof options.ledger !== 'string') {
      throw new ApplyError('missing-argument', 'plan requires --profile and --ledger')
    }
    const result = await planRevision({
      dshHome,
      profile: options.profile,
      ledgerPath: path.resolve(options.ledger),
      editsDir: options.edits === undefined ? undefined : path.resolve(options.edits),
      cycleId: options.cycle,
      cliPath,
      allowBodyMetadataMismatch: options['allow-body-metadata-mismatch'] === true,
    })
    process.stdout.write(`${JSON.stringify({ ok: true, revId: result.revId, dir: result.dir, planToken: result.manifest.planToken, smokeRequired: result.smokeRequired, renderer: result.manifest.renderer }, null, 2)}\n`)
    return
  }
  if (command === 'status') {
    const report = await statusReport({ dshHome, editsDir: options.edits === undefined ? undefined : path.resolve(options.edits) })
    process.stdout.write(`${JSON.stringify({ ok: true, ...report }, null, 2)}\n`)
    return
  }
  const revision = await requireRevision(dshHome, options.rev, options.edits)
  const editsDir = revision.editsDir
  if (command === 'preflight') {
    const result = await preflightRevision({ dshHome, editsDir, revId: options.rev, cliPath, smokeCmd: options['smoke-cmd'] })
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
    return
  }
  if (command === 'apply') {
    const result = await applyRevision({
      dshHome, editsDir, revId: options.rev,
      token: options.token,
      yes: options.yes === true,
      allowUnevaluated: options['allow-unevaluated'] === true,
      cliPath,
    })
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
    return
  }
  if (command === 'verify') {
    const result = await verifyRevision({ dshHome, editsDir, revId: options.rev, cliPath, smokeCmd: options['smoke-cmd'] })
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
    return
  }
  if (command === 'rollback') {
    const result = await rollbackRevision({ dshHome, editsDir, revId: options.rev, force: options.force === true })
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
    return
  }
  throw new ApplyError('unknown-command', `unhandled command: ${command}`)
}

try {
  await main()
} catch (error) {
  if (error instanceof ApplyError) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error.code, error: error.message, details: error.details ?? null })}\n`)
    process.exitCode = 1
  } else {
    process.stderr.write(`${JSON.stringify({ ok: false, code: 'internal-error', error: error instanceof Error ? error.message : String(error) })}\n`)
    process.exitCode = 2
  }
}
