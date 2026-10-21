/**
 * PR-5.1: independent verifier for `harness2-eval/v1` reports.
 *
 * The meta plugin must not trust report statistics just because their hash is
 * self-consistent. This module recomputes the OEP/v1 verdict from `perTask`
 * exactly as `tools/harness2-eval` does, using the frozen rule set below.
 * It is self-contained (no tools/ import) so the meta package stays publishable.
 */
import { createHash } from 'node:crypto'

export const OEP_V1_RULES = Object.freeze({
  minDelta: 0.15,
  maxP: 0.05,
  toolFailureSlack: 1,
  tokenRatioMax: 1.25,
  maxDriftDiff: 2,
  inertMustBeRejected: true,
  nullRevisionMustBeRejected: true,
})

export const EVAL_SCHEMA = 'harness2-eval/v1'
const ARMS = ['C', 'R', 'I', 'T'] as const
const ARM_RESULT_KEYS = ['success', 'toolFailures', 'stepCount', 'tokenCost', 'durationMs', 'mountFailed', 'schemaFailed'] as const

export interface VerifiedEvaluation {
  readonly b: number
  readonly c: number
  readonly N: number
  readonly delta: number
  readonly p: number
  readonly verdict: 'accept' | 'reject' | 'inconclusive'
  readonly inertControlRejected: boolean
  readonly nullProxyRejected: boolean
}

export interface VerificationReportResult {
  readonly errors: readonly string[]
  readonly stats?: VerifiedEvaluation
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

export function reportHash(report: Record<string, unknown>): string {
  const { reportHash: _ignored, ...rest } = report
  return `sha256:${createHash('sha256').update(stableStringify(rest), 'utf8').digest('hex')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function median(values: readonly number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  return sorted[Math.floor(sorted.length / 2)]!
}

function exactMcNemarOneSided(better: number, worse: number): number {
  const n = better + worse
  if (n === 0) return 1
  let total = 0
  let term = 1
  for (let i = 0; i <= n; i += 1) {
    if (i > 0) term = (term * (n - i + 1)) / i
    if (i >= better) total += term
  }
  return total / 2 ** n
}

function armChecks(perTask: readonly Record<string, unknown>[], arm: 'I' | 'T'): {
  readonly better: number
  readonly worse: number
  readonly delta: number
  readonly p: number
  readonly checks: Readonly<Record<string, boolean>>
} | undefined {
  let better = 0
  let worse = 0
  const controls: number[] = []
  const treats: number[] = []
  const controlFailures: number[] = []
  const treatFailures: number[] = []
  for (const task of perTask) {
    const arms = task.arms as Record<string, Record<string, unknown>>
    const c = arms.C!
    const t = arms[arm]!
    if (t.success === true && c.success !== true) better += 1
    if (t.success !== true && c.success === true) worse += 1
    if (isFiniteNumber(c.tokenCost) && isFiniteNumber(t.tokenCost)) {
      controls.push(c.tokenCost)
      treats.push(t.tokenCost)
    }
    if (isFiniteNumber(c.toolFailures) && isFiniteNumber(t.toolFailures)) {
      controlFailures.push(c.toolFailures)
      treatFailures.push(t.toolFailures)
    }
  }
  const n = perTask.length
  const delta = (better - worse) / n
  const p = exactMcNemarOneSided(better, worse)
  const controlMedian = median(controlFailures)
  const treatMedian = median(treatFailures)
  const controlTokens = median(controls)
  const treatTokens = median(treats)
  return {
    better,
    worse,
    delta,
    p,
    checks: {
      effect: delta >= OEP_V1_RULES.minDelta,
      significance: p < OEP_V1_RULES.maxP,
      toolFailures: controlMedian === null || treatMedian === null
        ? false
        : treatMedian <= controlMedian + OEP_V1_RULES.toolFailureSlack,
      tokenCost: controlTokens === null || treatTokens === null
        ? false
        : treatTokens <= OEP_V1_RULES.tokenRatioMax * Math.max(controlTokens, 1),
    },
  }
}

function validateArmResult(value: unknown, label: string): string[] {
  if (!isRecord(value)) return [`${label} must be an object`]
  const errors: string[] = []
  const keys = Object.keys(value)
  if (keys.length !== ARM_RESULT_KEYS.length || ARM_RESULT_KEYS.some((key) => !Object.hasOwn(value, key))) {
    errors.push(`${label} has an unexpected field set`)
  }
  if (typeof value.success !== 'boolean') errors.push(`${label}.success must be boolean`)
  for (const key of ['toolFailures', 'stepCount', 'tokenCost', 'durationMs']) {
    if (!isFiniteNumber(value[key]) || (value[key] as number) < 0) errors.push(`${label}.${key} must be a non-negative finite number`)
  }
  for (const key of ['mountFailed', 'schemaFailed']) {
    if (typeof value[key] !== 'boolean') errors.push(`${label}.${key} must be boolean`)
  }
  return errors
}

/**
 * Recompute the OEP/v1 report and check every top-level statistic.
 * Returns `errors` (empty = valid) and the independently recomputed stats.
 */
export function verifyEvaluationReport(report: unknown): VerificationReportResult {
  if (!isRecord(report)) return { errors: ['report must be an object'] }
  const errors: string[] = []
  if (report.schema !== EVAL_SCHEMA) errors.push('schema must be harness2-eval/v1')
  if (report.providerClass !== 'fake-calibration' && report.providerClass !== 'real') {
    errors.push('providerClass must be fake-calibration | real')
  }
  if (typeof report.reportHash !== 'string' || report.reportHash !== reportHash(report)) {
    errors.push('reportHash does not match report content')
  }
  if (report.verdict !== 'accept' && report.verdict !== 'reject' && report.verdict !== 'inconclusive') {
    errors.push('verdict must be accept | reject | inconclusive')
  }
  if (!Array.isArray(report.perTask) || report.perTask.length === 0) {
    return { errors: [...errors, 'perTask must be a non-empty array'] }
  }
  const perTask = report.perTask as unknown[]
  const taskIds = new Set<string>()
  for (const [index, task] of perTask.entries()) {
    if (!isRecord(task)) { errors.push(`perTask[${index}] must be an object`); break }
    if (typeof task.taskId !== 'string' || task.taskId.length === 0) errors.push(`perTask[${index}].taskId must be a non-empty string`)
    else if (taskIds.has(task.taskId)) errors.push(`perTask[${index}].taskId is duplicated`)
    else taskIds.add(task.taskId)
    if (!isRecord(task.arms) || Object.keys(task.arms).length !== ARMS.length) {
      errors.push(`perTask[${index}].arms must contain exactly C/R/I/T`)
      break
    }
    for (const arm of ARMS) errors.push(...validateArmResult(task.arms[arm], `perTask[${index}].arms.${arm}`))
  }
  if (errors.length > 0) return { errors }

  const rows = perTask as readonly Record<string, unknown>[]
  const treatment = armChecks(rows, 'T')!
  const inert = armChecks(rows, 'I')!
  const mountSchemaFailures = rows.reduce((sum, task) => {
    const arms = task.arms as Record<string, Record<string, unknown>>
    return sum + ARMS.filter((arm) => arms[arm]!.mountFailed === true || arms[arm]!.schemaFailed === true).length
  }, 0)
  const driftDiff = rows.filter((task) => {
    const arms = task.arms as Record<string, Record<string, unknown>>
    return arms.C!.success !== arms.R!.success
  }).length
  const inertControlRejected = !Object.values(inert.checks).every(Boolean)
  const nullProxyRejected = inertControlRejected
  const hasCompleteData = rows.length === (isFiniteNumber(report.N) ? report.N : -1)
  const accept = hasCompleteData
    && treatment.checks.effect
    && treatment.checks.significance
    && treatment.checks.toolFailures
    && treatment.checks.tokenCost
    && mountSchemaFailures === 0
    && driftDiff <= OEP_V1_RULES.maxDriftDiff
    && inertControlRejected
    && OEP_V1_RULES.inertMustBeRejected
    && OEP_V1_RULES.nullRevisionMustBeRejected
  const verdict = accept ? 'accept' : (hasCompleteData ? 'reject' : 'inconclusive')
  const stats: VerifiedEvaluation = {
    b: treatment.better,
    c: treatment.worse,
    N: rows.length,
    delta: treatment.delta,
    p: treatment.p,
    verdict,
    inertControlRejected,
    nullProxyRejected,
  }

  const close = (actual: unknown, expected: number, label: string): void => {
    if (!isFiniteNumber(actual) || Math.abs(actual - expected) > 1e-12) errors.push(`${label} does not match recomputed statistics`)
  }
  close(report.b, stats.b, 'b')
  close(report.c, stats.c, 'c')
  close(report.N, stats.N, 'N')
  close(report.delta, stats.delta, 'delta')
  close(report.p, stats.p, 'p')
  if (report.inertControlRejected !== stats.inertControlRejected) errors.push('inertControlRejected does not match recomputed statistics')
  if (report.nullProxyRejected !== stats.nullProxyRejected) errors.push('nullProxyRejected does not match recomputed statistics')
  if (report.mountSchemaFailures !== mountSchemaFailures) errors.push('mountSchemaFailures does not match recomputed statistics')
  if (report.verdict !== stats.verdict) errors.push('verdict does not match recomputed statistics')
  if (report.drift !== undefined) {
    const drift = report.drift
    if (!isRecord(drift) || drift.diff !== driftDiff || drift.threshold !== OEP_V1_RULES.maxDriftDiff || drift.ok !== (driftDiff <= OEP_V1_RULES.maxDriftDiff)) {
      errors.push('drift does not match recomputed statistics')
    }
  }
  if (report.inert !== undefined) {
    const inertReport = report.inert
    if (!isRecord(inertReport) || inertReport.accepted !== !inertControlRejected || inertReport.delta !== inert.delta || inertReport.p !== inert.p) {
      errors.push('inert does not match recomputed statistics')
    }
  }
  return { errors, stats }
}
