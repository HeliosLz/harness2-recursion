/**
 * Round-6 PR-1: Gate-v4 admission.
 *
 * Admission is deterministic and happens after Probe. It answers only:
 * "may this edit be materialized as a profile patch, given recovery-control
 * evidence and an admissibility check?" It is NOT certification: the edit's
 * real effect is measured offline (Gate-B, later PR).
 *
 * Design: docs/round-6-design.md §1.5. This module is pure and testable; the
 * plugin supplies candidates, trials and the two recovery-control metrics.
 */
import { checkAdmissibility, isSimulableInProbe } from './admissibility.ts'

export interface GateMetrics {
  readonly completion: boolean
  readonly toolFailures: number
  readonly stepCount: number
  readonly tokenCost: number
  readonly tokenCostSource: 'measured' | 'estimated'
  readonly durationMs: number
}

export interface GateCandidateInput {
  readonly candidateId: string
  /** False = candidate never entered Probe; it must not appear in the receipt. */
  readonly probed?: boolean
  readonly component: string
  readonly operation: string
  readonly content: string
  readonly trial: {
    readonly valid: boolean
    readonly metrics?: GateMetrics
    readonly applicability?: 'applied' | 'unavailable'
  }
}

export interface GateCandidateReceipt {
  readonly candidateId: string
  readonly admissible: boolean
  readonly admissibilityCode: string
  readonly applicable: boolean
  /** Raw improvement-oriented deltas vs the control mean (completion/toolFailures/stepCount). */
  readonly delta: Readonly<Record<'completion' | 'toolFailures' | 'stepCount', number>>
  readonly deadbanded: Readonly<Record<'completion' | 'toolFailures' | 'stepCount', number>>
  readonly rank: number
  readonly tokenGuard: boolean
  readonly regressed: boolean
  readonly admitted: boolean
}

export interface GateV4Receipt {
  readonly version: 'gate/v4'
  readonly policy: 'v4'
  readonly controlCount: number
  readonly stable: boolean
  readonly rankWeights: Readonly<Record<'completion' | 'toolFailures' | 'stepCount', number>>
  readonly tokenGuardRatio: number
  readonly candidates: readonly GateCandidateReceipt[]
  readonly appliedCandidateIds: readonly string[]
  readonly rejectedCandidateIds: readonly string[]
  readonly reason?: 'low-evidence' | 'regression'
}

export interface GateV4Apply {
  readonly kind: 'apply'
  readonly appliedCandidateIds: readonly string[]
  readonly appliedComponents: readonly string[]
  readonly gate: GateV4Receipt
}

export interface GateV4Reject {
  readonly kind: 'reject'
  readonly reason: 'low-evidence' | 'regression'
  readonly rejectedCandidateIds: readonly string[]
  readonly gate: GateV4Receipt
}

export type GateV4Decision = GateV4Apply | GateV4Reject

/** Admission ranking excludes token cost (raw units); token is a guard only. */
export const GATE_V4_RANK_WEIGHTS = Object.freeze({
  completion: 1,
  toolFailures: 0.5,
  stepCount: 0.1,
})

export const GATE_V4_TOKEN_GUARD_RATIO = 1.25
const KAPPA = Object.freeze({ completion: 0, toolFailures: 1, stepCount: 1 })

type NumericKey = 'completion' | 'toolFailures' | 'stepCount'

function meanControl(controls: readonly GateMetrics[]): GateMetrics {
  const first = controls[0]!
  const count = controls.length
  return {
    completion: first.completion,
    toolFailures: controls.reduce((sum, control) => sum + control.toolFailures, 0) / count,
    stepCount: controls.reduce((sum, control) => sum + control.stepCount, 0) / count,
    tokenCost: controls.reduce((sum, control) => sum + control.tokenCost, 0) / count,
    tokenCostSource: first.tokenCostSource,
    durationMs: first.durationMs,
  }
}

function controlNoise(controls: readonly GateMetrics[]): Record<NumericKey, number> {
  const [first, second] = controls
  const spread = (pick: (metrics: GateMetrics) => number): number =>
    second === undefined ? 0 : Math.abs(pick(first!) - pick(second))
  return {
    completion: 0,
    toolFailures: Math.max(KAPPA.toolFailures, spread((metrics) => metrics.toolFailures)),
    stepCount: Math.max(KAPPA.stepCount, spread((metrics) => metrics.stepCount)),
  }
}

function stableControls(controls: readonly GateMetrics[]): boolean {
  const [first, second] = controls
  if (first === undefined || second === undefined) return false
  if (first.completion !== second.completion) return false
  return Math.abs(first.toolFailures - second.toolFailures) <= KAPPA.toolFailures
    && Math.abs(first.stepCount - second.stepCount) <= KAPPA.stepCount
}

/**
 * Evaluate Gate-v4 admission.
 *
 * Fail-closed: fewer than two control metrics, unstable controls, or a v3 payload
 * with no control metrics yields `low-evidence` — never a silent legacy fallback.
 */
export function evaluateGateV4(input: {
  readonly controls: readonly GateMetrics[]
  readonly candidates: readonly GateCandidateInput[]
  readonly maxAppliedEdits?: number
}): GateV4Decision {
  const controls = input.controls.filter((metrics) => metrics !== undefined)
  // PR-1.1: exactly two controls are required. A 3rd/4th replicate would change
  // the mean without a matching stability check, so it is fail-closed instead.
  const controlsValid = controls.length === 2
  const stable = controlsValid && stableControls(controls)
  const controlBar = controlsValid ? meanControl(controls) : undefined
  const noise = controlsValid ? controlNoise(controls) : { completion: 0, toolFailures: 1, stepCount: 1 }

  // Receipts cover only candidates that actually reached Probe. Unprobed
  // candidates never get fabricated neutral deltas.
  const probedCandidates = input.candidates.filter((candidate) => candidate.probed !== false)
  const receipts: GateCandidateReceipt[] = probedCandidates.map((candidate) => {
    const admissibility = checkAdmissibility(candidate.component, candidate.operation, candidate.content)
    const trial = candidate.trial
    const applicable = trial.valid === true
      && trial.metrics !== undefined
      // Missing applicability is fail-closed: the gate must know the edit was in effect.
      && trial.applicability === 'applied'
    const zero = { completion: 0, toolFailures: 0, stepCount: 0 } as const
    if (!admissibility.ok || !applicable || controlBar === undefined || trial.metrics === undefined) {
      return {
        candidateId: candidate.candidateId,
        admissible: admissibility.ok,
        admissibilityCode: admissibility.code,
        applicable,
        delta: zero,
        deadbanded: zero,
        rank: 0,
        tokenGuard: false,
        regressed: false,
        admitted: false,
      }
    }
    const metrics = trial.metrics
    const delta = {
      completion: (metrics.completion ? 1 : 0) - (controlBar.completion ? 1 : 0),
      toolFailures: controlBar.toolFailures - metrics.toolFailures,
      stepCount: controlBar.stepCount - metrics.stepCount,
    }
    const deadbanded = {
      completion: Math.abs(delta.completion) > noise.completion ? delta.completion : 0,
      toolFailures: Math.abs(delta.toolFailures) > noise.toolFailures ? delta.toolFailures : 0,
      stepCount: Math.abs(delta.stepCount) > noise.stepCount ? delta.stepCount : 0,
    }
    const rank = GATE_V4_RANK_WEIGHTS.completion * deadbanded.completion
      + GATE_V4_RANK_WEIGHTS.toolFailures * deadbanded.toolFailures
      + GATE_V4_RANK_WEIGHTS.stepCount * deadbanded.stepCount
    const tokenGuard = metrics.tokenCost > GATE_V4_TOKEN_GUARD_RATIO * Math.max(controlBar.tokenCost, 1)
    const regressed = tokenGuard
      || delta.completion < -noise.completion
      || delta.toolFailures < -noise.toolFailures
      || delta.stepCount < -noise.stepCount
    return {
      candidateId: candidate.candidateId,
      admissible: true,
      admissibilityCode: admissibility.code,
      applicable: true,
      delta,
      deadbanded,
      rank,
      tokenGuard,
      regressed,
      admitted: stable && !regressed,
    }
  })

  const baseReceipt = {
    version: 'gate/v4' as const,
    policy: 'v4' as const,
    controlCount: controls.length,
    stable,
    rankWeights: GATE_V4_RANK_WEIGHTS,
    tokenGuardRatio: GATE_V4_TOKEN_GUARD_RATIO,
    candidates: receipts,
  }

  const admitted = receipts.filter((receipt) => receipt.admitted)
  const ranked = admitted
    .slice()
    .sort((left, right) => right.rank - left.rank || left.candidateId.localeCompare(right.candidateId))
  const componentOf = (candidateId: string): string =>
    probedCandidates.find((candidate) => candidate.candidateId === candidateId)?.component ?? ''
  const appliedCandidateIds: string[] = []
  for (const receipt of ranked) {
    if (appliedCandidateIds.length >= Math.max(1, Math.min(2, input.maxAppliedEdits ?? 1))) break
    if (appliedCandidateIds.length === 1
      && componentOf(appliedCandidateIds[0]!) === componentOf(receipt.candidateId)) {
      continue // PR-1.1 v3 parity: a second edit must target a different component.
    }
    appliedCandidateIds.push(receipt.candidateId)
  }

  const rejectedCandidateIds = receipts
    .filter((receipt) => !appliedCandidateIds.includes(receipt.candidateId))
    .map((receipt) => receipt.candidateId)

  if (!controlsValid || !stable || controlBar === undefined) {
    return {
      kind: 'reject',
      reason: 'low-evidence',
      rejectedCandidateIds: rejectedCandidateIds.length > 0
        ? rejectedCandidateIds
        : receipts.map((receipt) => receipt.candidateId),
      gate: { ...baseReceipt, appliedCandidateIds: [], rejectedCandidateIds, reason: 'low-evidence' },
    }
  }
  if (appliedCandidateIds.length === 0) {
    const anyInadmissible = receipts.some((receipt) => !receipt.admissible)
    const anyRegression = receipts.some((receipt) => receipt.regressed)
    const reason = anyInadmissible || anyRegression ? 'regression' : 'low-evidence'
    return {
      kind: 'reject',
      reason,
      rejectedCandidateIds: rejectedCandidateIds.length > 0
        ? rejectedCandidateIds
        : receipts.map((receipt) => receipt.candidateId),
      gate: { ...baseReceipt, appliedCandidateIds: [], rejectedCandidateIds, reason },
    }
  }

  return {
    kind: 'apply',
    appliedCandidateIds,
    appliedComponents: appliedCandidateIds.map((candidateId) => componentOf(candidateId)),
    gate: { ...baseReceipt, appliedCandidateIds, rejectedCandidateIds },
  }
}

/** Whether a candidate edit can be exercised inside the advisory probe at all. */
export { isSimulableInProbe }
