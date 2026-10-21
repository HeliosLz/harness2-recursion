/**
 * harness2-eval — Round-6 PR-4 Gate-B offline evaluation.
 *
 * Independent tool (no task/meta source imports). It consumes an applier
 * revision patch, runs C/R/I/T arms through an injected runner, applies the
 * pre-registered OEP/v1 rules, and writes a replayable `harness2-eval/v1`
 * report that the applier can enforce before writing a real profile.
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'

export const EVAL_SCHEMA = 'harness2-eval/v1'
export const PREREG_SCHEMA = 'harness2-prereg/v1'
export const TASKS_SCHEMA = 'harness2-holdout/v1'
export const ARMS = Object.freeze(['C', 'R', 'I', 'T'])
export const HOLDOUT_DOMAIN = 'eval-holdout'

export class EvalError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'EvalError'
    this.code = code
    this.details = details
  }
}

export function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
export function hashOf(value) { return `sha256:${sha256Hex(value)}` }

/** Canonical JSON for report hashing (stable key order). */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}
export function reportHash(report) {
  const { reportHash: _ignored, ...rest } = report
  return hashOf(stableStringify(rest))
}

export async function hashFile(file) {
  return hashOf(await readFile(file, 'utf8'))
}

export async function loadTasks(file) {
  const text = await readFile(file, 'utf8')
  let tasks
  try {
    tasks = text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    throw new EvalError('tasks-invalid', `cannot parse tasks: ${error.message}`)
  }
  if (tasks.length === 0) throw new EvalError('tasks-invalid', 'tasks file is empty')
  for (const task of tasks) {
    if (typeof task?.id !== 'string' || typeof task?.prompt !== 'string' || task?.taskDomain !== HOLDOUT_DOMAIN) {
      throw new EvalError('tasks-invalid', `task ${String(task?.id)} is not a valid eval-holdout task`)
    }
    if (task.checker === null || typeof task.checker !== 'object') throw new EvalError('tasks-invalid', `task ${task.id} has no checker`)
  }
  return { tasks, text }
}

export async function loadPrereg(file) {
  let prereg
  try { prereg = JSON.parse(await readFile(file, 'utf8')) } catch (error) {
    throw new EvalError('prereg-invalid', `cannot parse preregistration: ${error.message}`)
  }
  if (prereg?.schema !== PREREG_SCHEMA || prereg?.ruleVersion !== 'OEP/v1') {
    throw new EvalError('prereg-invalid', 'preregistration schema/ruleVersion must be harness2-prereg/v1 + OEP/v1')
  }
  for (const key of ['tasksHash', 'arms', 'n', 'seed', 'providerClass', 'rules']) {
    if (prereg[key] === undefined) throw new EvalError('prereg-invalid', `preregistration missing ${key}`)
  }
  return prereg
}

export function validatePrereg({ prereg, tasks, tasksHash, fold }) {
  if (prereg.tasksHash !== tasksHash) throw new EvalError('prereg-tasks-mismatch', 'preregistration tasksHash does not match tasks file')
  if (JSON.stringify(prereg.arms) !== JSON.stringify(ARMS)) throw new EvalError('prereg-arms-mismatch', 'arms must be C/R/I/T')
  if (prereg.providerClass !== 'fake-calibration' && prereg.providerClass !== 'real') {
    throw new EvalError('prereg-invalid', 'providerClass must be fake-calibration | real')
  }
  const selectedFold = fold ?? prereg.folds?.[0]
  if (!Array.isArray(prereg.folds) || !prereg.folds.includes(selectedFold)) {
    throw new EvalError('prereg-fold-mismatch', `fold ${String(selectedFold)} is not registered`)
  }
  const batch = tasks.tasks.filter((task) => task.fold === selectedFold)
  if (batch.length !== prereg.n || batch.length !== prereg.perFold) {
    throw new EvalError('prereg-tasks-mismatch', `fold ${selectedFold} has ${batch.length} tasks, prereg expects ${prereg.n}`)
  }
  return { fold: selectedFold, batch }
}

export function exactMcNemarOneSided(b, c) {
  const n = b + c
  if (n === 0) return 1
  let total = 0
  for (let k = b; k <= n; k += 1) {
    let term = 1
    for (let j = 0; j < k; j += 1) term = (term * (n - j)) / (j + 1)
    total += term
  }
  return total / 2 ** n
}

export function median(values) {
  const sorted = [...values].filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  return sorted[Math.floor(sorted.length / 2)]
}

function pairedCounts(perTask, arm) {
  let better = 0
  let worse = 0
  for (const task of perTask) {
    const c = task.arms.C.success === true
    const t = task.arms[arm].success === true
    if (t && !c) better += 1
    if (!t && c) worse += 1
  }
  return { better, worse }
}

function armAcceptance(perTask, prereg, arm) {
  const n = perTask.length
  const { better, worse } = pairedCounts(perTask, arm)
  const delta = (better - worse) / n
  const p = exactMcNemarOneSided(better, worse)
  const cFailures = perTask.map((task) => task.arms.C.toolFailures)
  const aFailures = perTask.map((task) => task.arms[arm].toolFailures)
  const cTokens = perTask.map((task) => task.arms.C.tokenCost)
  const aTokens = perTask.map((task) => task.arms[arm].tokenCost)
  const cMed = median(cFailures)
  const aMed = median(aFailures)
  const cToken = median(cTokens)
  const aToken = median(aTokens)
  return {
    better, worse, delta, p,
    toolFailuresTreat: aMed, toolFailuresControl: cMed,
    tokenCostTreat: aToken, tokenCostControl: cToken,
    checks: {
      effect: delta >= prereg.rules.minDelta,
      significance: p < prereg.rules.maxP,
      toolFailures: cMed === null || aMed === null ? false : aMed <= cMed + prereg.rules.toolFailureSlack,
      tokenCost: cToken === null || aToken === null ? false : aToken <= prereg.rules.tokenRatioMax * Math.max(cToken, 1),
    },
  }
}

function isArmDataComplete(perTask, prereg) {
  if (perTask.length !== prereg.n) return false
  for (const task of perTask) {
    for (const arm of ARMS) {
      const result = task?.arms?.[arm]
      if (result === null || typeof result !== 'object') return false
      if (typeof result.success !== 'boolean') return false
      for (const key of ['toolFailures', 'stepCount', 'tokenCost', 'durationMs']) {
        if (typeof result[key] !== 'number' || !Number.isFinite(result[key])) return false
      }
      for (const key of ['mountFailed', 'schemaFailed']) {
        if (typeof result[key] !== 'boolean') return false
      }
    }
  }
  return true
}

/**
 * Compute the pre-registered verdict from per-task C/R/I/T results.
 * A `null` revision is operationalized as the inert I arm (shape-matched,
 * semantically empty); the report records this explicitly.
 */
export function evaluateVerdict({ perTask, prereg }) {
  const n = perTask.length
  const required = ['C', 'R', 'I', 'T']
  for (const task of perTask) {
    for (const arm of required) {
      if (task.arms?.[arm] === undefined) throw new EvalError('missing-arm', `task ${task.taskId} is missing arm ${arm}`)
    }
  }
  const treatment = armAcceptance(perTask, prereg, 'T')
  const inert = armAcceptance(perTask, prereg, 'I')
  const mountSchemaFailures = perTask.reduce((sum, task) =>
    sum + required.filter((arm) => task.arms[arm].mountFailed === true || task.arms[arm].schemaFailed === true).length, 0)
  let driftDiff = 0
  for (const task of perTask) {
    if (task.arms.C.success !== task.arms.R.success) driftDiff += 1
  }
  const driftChecks = driftDiff <= prereg.rules.maxDriftDiff
  const dataComplete = isArmDataComplete(perTask, prereg)
  const inertAccepted = Object.values(inert.checks).every(Boolean)
  const inertControlRejected = dataComplete && !inertAccepted
  // I is a shape-matched inert/NULL proxy; it is not an independent N arm.
  const nullProxyRejected = dataComplete && !inertAccepted
  const accept = dataComplete && treatment.checks.effect
    && treatment.checks.significance
    && treatment.checks.toolFailures
    && treatment.checks.tokenCost
    && mountSchemaFailures === 0
    && driftChecks
    && inertControlRejected
    && nullProxyRejected
    && prereg.rules.inertMustBeRejected !== false
    && prereg.rules.nullRevisionMustBeRejected !== false
  const verdict = accept ? 'accept' : (dataComplete ? 'reject' : 'inconclusive')
  return {
    b: treatment.better, c: treatment.worse, N: n,
    delta: treatment.delta, p: treatment.p,
    secondary: {
      medianToolFailuresC: treatment.toolFailuresControl,
      medianToolFailuresT: treatment.toolFailuresTreat,
      medianTokenCostC: treatment.tokenCostControl,
      medianTokenCostT: treatment.tokenCostTreat,
    },
    drift: { diff: driftDiff, threshold: prereg.rules.maxDriftDiff, ok: driftChecks },
    inert: { accepted: inertAccepted, delta: inert.delta, p: inert.p },
    inertControlRejected,
    nullProxyRejected,
    mountSchemaFailures,
    verdict,
  }
}

export function buildReport({
  batchId, revisionId, profile, cycleId, contentHash, planToken,
  prereg, preregHash, tasksHash, perTask, fold,
  edit, source, sourceMissing, tokenCostSource,
  evaluatedAt = new Date().toISOString(),
}) {
  const stats = evaluateVerdict({ perTask, prereg })
  const report = {
    schema: EVAL_SCHEMA,
    batchId, revisionId, profile, cycleId, contentHash, planToken,
    preregHash, tasksHash, evaluatedAt,
    providerClass: prereg.providerClass,
    fold: fold ?? prereg.folds?.[0],
    arms: [...ARMS], perTask, ...stats,
    ...(edit === undefined ? {} : { edit }),
    ...(source === undefined ? {} : { source }),
    ...(sourceMissing === true ? { sourceMissing: true } : {}),
    ...(tokenCostSource === undefined ? {} : { tokenCostSource }),
  }
  report.reportHash = reportHash(report)
  return report
}

export const REPORT_KEYS = Object.freeze([
  'schema', 'batchId', 'revisionId', 'profile', 'cycleId', 'contentHash', 'planToken',
  'preregHash', 'tasksHash', 'evaluatedAt', 'providerClass', 'fold', 'arms', 'perTask',
  'b', 'c', 'N', 'delta', 'p', 'secondary', 'drift', 'inert', 'inertControlRejected',
  'nullProxyRejected', 'mountSchemaFailures', 'verdict', 'reportHash',
])
const ARM_RESULT_KEYS = ['success', 'toolFailures', 'stepCount', 'tokenCost', 'durationMs', 'mountFailed', 'schemaFailed']
const OPTIONAL_REPORT_KEYS = ['edit', 'source', 'sourceMissing', 'tokenCostSource']

export function validateReport(report, { prereg, tasksHash, preregHash } = {}) {
  const errors = []
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return ['report must be an object']
  const keys = Object.keys(report)
  const unexpected = keys.filter((key) => !REPORT_KEYS.includes(key) && !OPTIONAL_REPORT_KEYS.includes(key))
  const missing = REPORT_KEYS.filter((key) => !Object.hasOwn(report, key))
  if (missing.length > 0 || unexpected.length > 0) errors.push('report has an unexpected field set')
  if (report.edit !== undefined) {
    const edit = report.edit
    if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) errors.push('edit must be an object')
    else for (const key of ['candidateId', 'component', 'operation', 'contentHash']) {
      if (typeof edit[key] !== 'string' || edit[key].length === 0) errors.push(`edit.${key} is required`)
    }
  }
  if (report.sourceMissing !== undefined && typeof report.sourceMissing !== 'boolean') errors.push('sourceMissing must be boolean')
  if (report.source !== undefined) {
    const source = report.source
    if (source === null || typeof source !== 'object' || Array.isArray(source)) errors.push('source must be an object')
    else if (typeof source.failurePattern !== 'string' || source.failurePattern.length === 0) errors.push('source.failurePattern is required')
  }
  if (report.tokenCostSource !== undefined && report.tokenCostSource !== 'measured' && report.tokenCostSource !== 'estimated') {
    errors.push('tokenCostSource must be measured | estimated')
  }
  if (report.schema !== EVAL_SCHEMA) errors.push('schema must be harness2-eval/v1')
  if (report.providerClass !== 'fake-calibration' && report.providerClass !== 'real') {
    errors.push('providerClass must be fake-calibration | real')
  }
  if (!Array.isArray(report.perTask) || report.perTask.length === 0) errors.push('perTask must be a non-empty array')
  if (Array.isArray(report.perTask)) {
    for (const task of report.perTask) {
      if (task === null || typeof task !== 'object') { errors.push('perTask entry must be an object'); break }
      if (Object.keys(task).length !== 2 || task.taskId === undefined || task.arms === undefined) {
        errors.push('perTask entries must contain exactly taskId + arms'); break
      }
      if (task.arms === null || typeof task.arms !== 'object' || Object.keys(task.arms).length !== ARMS.length) {
        errors.push(`task ${task.taskId} must have exactly C/R/I/T arms`); break
      }
      for (const arm of ARMS) {
        const result = task.arms[arm]
        if (result === null || typeof result !== 'object' || Object.keys(result).length !== ARM_RESULT_KEYS.length) {
          errors.push(`task ${task.taskId} arm ${arm} has an unexpected field set`); break
        }
        for (const key of ARM_RESULT_KEYS) {
          if (!Object.hasOwn(result, key)) errors.push(`task ${task.taskId} arm ${arm} missing ${key}`)
        }
        if (typeof result.success !== 'boolean') errors.push(`task ${task.taskId} arm ${arm} success must be boolean`)
        for (const key of ['toolFailures', 'stepCount', 'tokenCost', 'durationMs']) {
          if (typeof result[key] !== 'number' || !Number.isFinite(result[key])) errors.push(`task ${task.taskId} arm ${arm} ${key} must be finite`)
        }
        for (const key of ['mountFailed', 'schemaFailed']) {
          if (typeof result[key] !== 'boolean') errors.push(`task ${task.taskId} arm ${arm} ${key} must be boolean`)
        }
      }
    }
  }
  if (prereg !== undefined && Array.isArray(report.perTask)) {
    if (report.providerClass !== prereg.providerClass) errors.push('report providerClass does not match preregistration')
    if (!Array.isArray(prereg.folds) || !prereg.folds.includes(report.fold)) errors.push('report fold is not registered')
    const foldSet = new Set(prereg.tasksHash === undefined ? [] : [])
    void foldSet
    let recomputed
    try { recomputed = evaluateVerdict({ perTask: report.perTask, prereg }) } catch (error) {
      errors.push(`cannot recompute statistics: ${error.message}`)
    }
    if (recomputed !== undefined) {
      for (const key of ['b', 'c', 'N', 'delta', 'p', 'secondary', 'drift', 'inert', 'inertControlRejected', 'nullProxyRejected', 'mountSchemaFailures', 'verdict']) {
        if (stableStringify(report[key]) !== stableStringify(recomputed[key])) {
          errors.push(`report ${key} does not match recomputed statistics`)
        }
      }
    }
  }
  if (tasksHash !== undefined && report.tasksHash !== tasksHash) errors.push('report tasksHash does not match tasks file')
  if (preregHash !== undefined && report.preregHash !== preregHash) errors.push('report preregHash does not match preregistration file')
  if (report.reportHash !== reportHash(report)) errors.push('reportHash does not match report content')
  return errors
}

/** Validate the exact fold task-id set (applier-side independent check). */
export function validateFoldTaskSet(report, prereg, tasks) {
  const fold = report.fold
  if (!Array.isArray(prereg.folds) || !prereg.folds.includes(fold)) return false
  const expected = new Set(tasks.tasks.filter((task) => task.fold === fold).map((task) => task.id))
  const actual = new Set(report.perTask.map((task) => task.taskId))
  if (expected.size !== actual.size) return false
  for (const id of expected) if (!actual.has(id)) return false
  return true
}

export async function replayReport({ reportFile, tasksFile, preregFile }) {
  const report = JSON.parse(await readFile(reportFile, 'utf8'))
  const preregRaw = await readFile(preregFile, 'utf8')
  const prereg = await loadPrereg(preregFile)
  const { tasks, text } = await loadTasks(tasksFile)
  const errors = validateReport(report, { prereg, tasksHash: hashOf(text), preregHash: hashOf(preregRaw) })
  if (errors.length > 0) throw new EvalError('report-invalid', errors.join('; '))
  return { ok: true, verdict: report.verdict, b: report.b, c: report.c, N: report.N, reportHash: report.reportHash, tasks: tasks.length }
}

/**
 * Build a shape-matched inert patch from a rendered revision patch by
 * replacing string config values with same-length neutral text. Numbers,
 * structure and row ids are unchanged; it carries no semantic edit.
 */
export function makeInertPatch(patchText) {
  let rows
  try { rows = YAML.parse(patchText, { logLevel: 'silent' }) } catch { return patchText }
  if (!Array.isArray(rows)) return patchText
  const neutral = 'neutral '
  const walk = (value) => {
    if (typeof value === 'string') return neutral.repeat(Math.ceil(value.length / neutral.length)).slice(0, value.length)
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]))
    }
    return value
  }
  return YAML.stringify(rows.map((row) => (row?.config === undefined ? row : { ...row, config: walk(row.config) })), { lineWidth: 0 })
}

/* ── runners ─────────────────────────────────────────────────────────────── */

export function fakeMatrixRunner(matrix) {
  return async ({ task, arm }) => {
    const value = matrix[`${task.id}:${arm}`] ?? { success: false }
    return {
      success: value.success === true,
      toolFailures: value.toolFailures ?? 0,
      stepCount: value.stepCount ?? 1,
      tokenCost: value.tokenCost ?? 1000,
      durationMs: value.durationMs ?? 10,
      mountFailed: value.mountFailed === true,
      schemaFailed: value.schemaFailed === true,
    }
  }
}

/**
 * Real headless runner (best-effort): copies the target profile into a temp
 * DSH_HOME, optionally writes the revision/inert patch, runs one headless
 * task, and evaluates a deterministic checker on exit/stdout. Token/step
 * metrics are estimated from output because the headless surface exposes no
 * token meter. Fake-provider runs are calibration only; production efficacy
 * needs a real-provider run.
 */
export async function realRunner(options) {
  const {
    profilePaths, copyProfile, patched, prompt, environment, timeoutMs = 180_000,
    runHeadless, checker, patchPath,
  } = options
  return async ({ task, arm }) => {
    const tempHome = await options.makeTempHome()
    try {
      await copyProfile(profilePaths.profileDir, path.join(tempHome, 'profiles', profilePaths.profile))
      const targetPatch = path.join(tempHome, 'profiles', profilePaths.profile, 'cordis.patch.yml')
      if (arm === 'T' || arm === 'I') {
        await writeFile(targetPatch, arm === 'T' ? patched : options.inertPatch, 'utf8')
      }
      const started = Date.now()
      const result = await runHeadless({ home: tempHome, profile: profilePaths.profile, prompt: task.prompt, timeoutMs })
      const stdout = result.stdout ?? ''
      const stderr = result.stderr ?? ''
      const successExit = (checker.successExitCodes ?? [0]).includes(result.code)
      const successMarker = typeof checker.successMarker !== 'string' || stdout.includes(checker.successMarker)
      const mountFailed = /skipping profile bundle|failed to parse (overlay|profile)|YAMLException/i.test(stderr)
      return {
        success: successExit && successMarker && !mountFailed,
        toolFailures: (stderr.match(/request-error|tool error|Error:/gi) ?? []).length,
        stepCount: 1,
        tokenCost: Math.ceil((stdout.length + stderr.length) / 4),
        durationMs: Date.now() - started,
        mountFailed,
        schemaFailed: false,
      }
    } finally {
      await options.removeTempHome(tempHome).catch(() => undefined)
    }
  }
}

/** Run the selected fold through C/R/I/T (order recorded in the report). */
export async function runBatch({
  revisionId, profile, cycleId, contentHash, planToken, prereg,
  batch, tasksHash, preregHash, runner, batchId, evaluatedAt,
  edit, source, sourceMissing, tokenCostSource,
}) {
  const order = ARMS
  const perTask = []
  const runs = []
  for (const task of batch) {
    const arms = {}
    for (const arm of order) {
      const result = await runner({ task, arm })
      arms[arm] = {
        success: result.success === true,
        toolFailures: Number(result.toolFailures ?? 0),
        stepCount: Number(result.stepCount ?? 0),
        tokenCost: Number(result.tokenCost ?? 0),
        durationMs: Number(result.durationMs ?? 0),
        mountFailed: result.mountFailed === true,
        schemaFailed: result.schemaFailed === true,
      }
      runs.push({ taskId: task.id, arm, ...arms[arm] })
    }
    perTask.push({ taskId: task.id, arms })
  }
  return {
    report: buildReport({
      batchId, revisionId, profile, cycleId, contentHash, planToken,
      prereg, preregHash, tasksHash, perTask, fold: batch[0]?.fold, evaluatedAt,
      edit, source, sourceMissing, tokenCostSource,
    }),
    runs,
    order,
  }
}
