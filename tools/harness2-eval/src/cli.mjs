#!/usr/bin/env node
/**
 * harness2-eval CLI (Gate-B offline evaluation).
 * Commands: run, replay, help. Exit codes 0/1/2.
 */
import { spawnSync } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { copyProfileResolvedLinks, loadRevisionByIndex, profilePaths, resolveDshHome } from '../../harness2-apply/src/lib.mjs'
import {
  EvalError, fakeMatrixRunner, hashOf, loadTasks, loadPrereg, makeInertPatch,
  realRunner, replayReport, runBatch, validatePrereg,
} from './lib.mjs'

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_TASKS = path.resolve(EVAL_DIR, '../../../e2e/holdout/tasks.jsonl')
const DEFAULT_PREREG = path.resolve(EVAL_DIR, '../../../e2e/holdout/preregistration.json')
const DEFAULT_CLI = process.env.HARNESS2_DSH_CLI ?? '/tmp/dsh021/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'

function help() {
  return `harness2-eval — PR-4 Gate-B offline evaluation

Usage:
  harness2-eval run --revision <rev> [--home <DSH_HOME>] [--fold <n>] [--batch <id>] \\
      [--tasks <tasks.jsonl>] [--prereg <preregistration.json>] \\
      [--runner fake|real] [--matrix <fake-matrix.json>] [--cli <dsh bin.js>]
  harness2-eval replay --report <report.json> [--tasks <file>] [--prereg <file>]
  harness2-eval help

Rules: OEP/v1 (paired risk difference + exact one-sided McNemar, secondary
median/slack, drift/inert/null checks). fake-calibration runs are tooling
calibration only; production apply requires a real-provider report.
`
}

function parseArgs(argv) {
  let command = argv[0]
  let rest = argv.slice(1)
  if (command === '--help' || command === '-h' || command === undefined) return { command: 'help', options: {} }
  if (!['run', 'replay', 'help'].includes(command)) throw new EvalError('unknown-command', `unknown command: ${String(command)}`)
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (!arg.startsWith('--')) throw new EvalError('invalid-argument', `unexpected argument: ${arg}`)
    const key = arg.slice(2)
    const value = rest[index + 1]
    if (value === undefined || value.startsWith('--')) throw new EvalError('missing-value', `missing value for --${key}`)
    index += 1
    options[key] = value
  }
  return { command, options }
}

function runHeadless({ home, profile, prompt, timeoutMs }) {
  const result = spawnSync(process.execPath, [CLI_PATH, '--profile', profile, prompt], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
let CLI_PATH = DEFAULT_CLI

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  if (command === 'help' || options.help) { process.stdout.write(help()); return }
  if (command === 'replay') {
    if (typeof options.report !== 'string') throw new EvalError('missing-argument', 'replay requires --report')
    const result = await replayReport({
      reportFile: path.resolve(options.report),
      tasksFile: path.resolve(options.tasks ?? DEFAULT_TASKS),
      preregFile: path.resolve(options.prereg ?? DEFAULT_PREREG),
    })
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
    return
  }
  if (typeof options.revision !== 'string') throw new EvalError('missing-argument', 'run requires --revision')
  const dshHome = resolveDshHome(options.home)
  const revision = await loadRevisionByIndex(dshHome, options.revision)
  const manifest = revision.manifest
  const tasksFile = path.resolve(options.tasks ?? DEFAULT_TASKS)
  const preregFile = path.resolve(options.prereg ?? DEFAULT_PREREG)
  const { tasks, text: tasksText } = await loadTasks(tasksFile)
  const prereg = await loadPrereg(preregFile)
  const tasksHash = hashOf(tasksText)
  const preregHash = hashOf(await readFile(preregFile, 'utf8'))
  const fold = options.fold === undefined ? prereg.folds[0] : Number(options.fold)
  const { batch } = validatePrereg({ prereg, tasks: { tasks }, tasksHash, fold })
  const patch = await readFile(path.join(revision.dir, 'patch.yml'), 'utf8')
  const batchId = options.batch ?? `batch-f${fold}-${manifest.revId}`
  let runner
  if ((options.runner ?? 'fake') === 'fake') {
    if (typeof options.matrix !== 'string') throw new EvalError('missing-matrix', 'fake runner requires --matrix <file>')
    const matrix = JSON.parse(await readFile(path.resolve(options.matrix), 'utf8'))
    runner = fakeMatrixRunner(matrix)
  } else {
    CLI_PATH = options.cli ?? DEFAULT_CLI
    if (spawnSync('test', ['-f', CLI_PATH]).status !== 0) throw new EvalError('cli-missing', `dsh CLI not found at ${CLI_PATH}`)
    runner = realRunner({
      profilePaths: profilePaths(dshHome, manifest.profile),
      copyProfile: copyProfileResolvedLinks,
      patched: patch,
      inertPatch: makeInertPatch(patch),
      makeTempHome: () => mkdtemp(path.join(tmpdir(), 'h2-eval-')),
      removeTempHome: (dir) => rm(dir, { recursive: true, force: true }),
      runHeadless: (input) => runHeadless({ ...input, timeoutMs: 180_000 }),
    })
  }
  const { report, runs, order } = await runBatch({
    revisionId: manifest.revId, profile: manifest.profile, cycleId: manifest.cycleId,
    contentHash: manifest.contentHashes[0], planToken: manifest.planToken,
    prereg, batch, tasksHash, preregHash, runner, batchId,
    edit: manifest.edit, source: manifest.source, sourceMissing: manifest.sourceMissing === true,
    tokenCostSource: 'estimated',
  })
  const reportDir = path.join(path.dirname(revision.editsDir), 'eval', batchId)
  await mkdir(path.join(reportDir, 'runs'), { recursive: true })
  await writeFile(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(path.join(reportDir, 'runs', 'runs.jsonl'), `${runs.map((run) => JSON.stringify(run)).join('\n')}\n`, 'utf8')
  const indexDir = path.dirname(reportDir)
  await mkdir(indexDir, { recursive: true })
  await appendFile(path.join(indexDir, 'index.jsonl'), `${JSON.stringify({
    schema: 'harness2-eval-index/v1',
    batchId, revisionId: manifest.revId, reportPath: path.join(path.basename(reportDir), 'report.json'),
    reportHash: report.reportHash, providerClass: report.providerClass, verdict: report.verdict,
    fold: report.fold, createdAt: new Date().toISOString(),
  })}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ ok: true, batchId, report: path.join(reportDir, 'report.json'), verdict: report.verdict, b: report.b, c: report.c, N: report.N, delta: report.delta, p: report.p, reportHash: report.reportHash, order }, null, 2)}\n`)
}

try {
  await main()
} catch (error) {
  const known = error instanceof EvalError
  process.stderr.write(`${JSON.stringify({ ok: false, code: known ? error.code : 'internal-error', error: error instanceof Error ? error.message : String(error), details: known ? error.details ?? null : null })}\n`)
  process.exitCode = known ? 1 : 2
}
