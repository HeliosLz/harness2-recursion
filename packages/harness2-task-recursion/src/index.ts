/**
 * harness2-task-recursion — task-level recursive self-optimization (round 4).
 *
 * Round-3 contract revisions (frozen):
 *   - `TrialRecord` carries candidate metadata (component/operation/editContentHash)
 *     as REQUIRED fields, including `valid: false` trials;
 *   - `ComposeAppliedPayload.appliedEdits` mirrors `appliedCandidateIds` and is
 *     built from the in-memory candidate table (never re-hashed);
 *   - `ComposeRejectedPayload.rejectedCandidateIds` is required and non-empty;
 *   - `ProbeMetrics.tokenCostSource` is `'measured' | 'estimated'`; measured
 *     prefers the Propose usage chunk and the optional `tokenMeter` service;
 *   - ledger envelopes are `harness2-ledger/v3` (version/id/previousSnapshotRef/
 *     ledgerEntryId/event/payload/recordedAt); `readLedgerTail` accepts v2|v3
 *     and maps v2 in memory only;
 *   - round 4 adds the terminal `propose/failed` event (R4-1): it is mutually
 *     exclusive with probe/compose events for the same cycleId, is emitted only
 *     after a successful ledger append, and never fabricates rejected ids;
 *   - Harness² component names come from the shared `constants.ts` (byte-identical
 *     copy in both packages; no cross-package imports).
 *
 * @module harness2-task-recursion
 */

import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import Schema from '@deepseek-ai/schemastery'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

import {
  COMPONENT_NAMES,
  LEGACY_COMPONENT_MIGRATION,
  isComponentName,
} from './constants.ts'
import {
  ADMISSIBLE_OPERATIONS,
  FORBIDDEN_CONFIG_KEYS,
  PERSONA_PREFIX_SECTION,
  checkAdmissibility,
  isSimulableInProbe,
} from './admissibility.ts'
import type { Admissibility, PatchComponent, PatchOperation } from './admissibility.ts'
import {
  GATE_V4_RANK_WEIGHTS,
  GATE_V4_TOKEN_GUARD_RATIO,
  evaluateGateV4,
} from './gate-v4.ts'
import type { GateMetrics, GateV4Receipt } from './gate-v4.ts'

export { COMPONENT_NAMES, LEGACY_COMPONENT_MIGRATION, isComponentName }
export {
  ADMISSIBLE_OPERATIONS,
  FORBIDDEN_CONFIG_KEYS,
  PERSONA_PREFIX_SECTION,
  checkAdmissibility,
  isSimulableInProbe,
} from './admissibility.ts'
export type { Admissibility, PatchComponent, PatchOperation } from './admissibility.ts'
export {
  GATE_V4_RANK_WEIGHTS,
  GATE_V4_TOKEN_GUARD_RATIO,
  evaluateGateV4,
} from './gate-v4.ts'
export type { GateCandidateInput, GateMetrics, GateV4Receipt } from './gate-v4.ts'
export type { ComponentName } from './constants.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'harness2-task-recursion'

/** Static service dependencies (frozen since round 1). */
export const inject = ['tools', 'llm', 'agents']

/** Schemastery config schema; every default is inline and validated on load. */
export const Config = Schema.object({
  triggerThreshold: Schema.number().default(3),
  repeatedFailureWindow: Schema.number().default(3),
  cooldownMs: Schema.number().default(60000),
  ledgerPath: Schema.string().default('./harness2-ledger.jsonl'),
  maxCostPerCycle: Schema.number().default(50000),
  probeTimeoutMs: Schema.number().default(120000),
  replayScope: Schema.union([
    Schema.const('last-failed-step'),
    Schema.const('full-task'),
  ]).default('last-failed-step'),
  /** Round-6: v4 admission is the default; v3 exists only for archived replay. */
  gatePolicy: Schema.union([
    Schema.const('v4'),
    Schema.const('v3'),
  ]).default('v4'),
  /** Recovery-control replicates for Gate-v4; 2 is required by the design. */
  controlReplicates: Schema.number().default(2),
  /** How many admitted edits a single cycle may apply (1 keeps attribution atomic). */
  maxAppliedEdits: Schema.number().default(1),
  observeOnly: Schema.boolean().default(true),
  trajectoryWindow: Schema.number().default(5),
  taskDomain: Schema.string().default(''),
  proposeModel: Schema.string().default(''),
  metricWeights: Schema.object({
    completion: Schema.number().default(1),
    toolFailures: Schema.number().default(0.5),
    stepCount: Schema.number().default(0.1),
    tokenCost: Schema.number().default(0.0001),
  }).default({
    completion: 1,
    toolFailures: 0.5,
    stepCount: 0.1,
    tokenCost: 0.0001,
  }),
})

/** Resolved config type, identical to the schema output. */
export type Config = Schemastery.TypeT<typeof Config>

/* -------------------------------------------------------------------------- */
/* Frozen cross-plugin contract                                               */
/* -------------------------------------------------------------------------- */

/** Candidate type produced by Propose. */
export type CandidateType = 'invariant' | 'domain'

/** How `tokenCost` was obtained (round-3 Q4). */
export type TokenCostSource = 'measured' | 'estimated'

/** Metrics captured for the baseline and for every probe trial. */
export interface ProbeMetrics {
  readonly completion: boolean
  readonly toolFailures: number
  readonly stepCount: number
  readonly tokenCost: number
  readonly tokenCostSource: TokenCostSource
  readonly durationMs: number
}

/** One probed candidate; metadata is required for every trial (round-3 Q1). */
export interface TrialRecord {
  readonly candidateId: string
  readonly candidateType: CandidateType
  readonly component: string
  readonly operation: string
  readonly editContentHash: string
  readonly valid: boolean
  readonly metrics?: ProbeMetrics
  readonly error?: string
  /** Round-6: whether the edit was actually in effect for this trial. */
  readonly applicability?: 'applied' | 'unavailable'
}

/** Payload of `probe/completed`. */
export interface ProbeCompletedPayload {
  readonly taskId: string
  readonly baselineMetrics: ProbeMetrics
  readonly trials: readonly TrialRecord[]
  readonly evidenceSummary: string
  readonly cycleId: string
  /** Round-6: no-edit recovery-control metrics (Gate-v4 admission). */
  readonly controlMetrics?: readonly ProbeMetrics[]
}

/** Compose application path. */
export type ApplyMode = 'pre-step-patch' | 'next-task-ledger' | 'noop-todo'

/** One applied edit (round-3 R3-1). */
export interface AppliedEdit {
  readonly candidateId: string
  readonly contentHash: string
  readonly component: string
  readonly operation: string
}

/** Payload of `compose/applied`. */
export interface ComposeAppliedPayload {
  readonly taskId: string
  readonly cycleId: string
  readonly appliedCandidateIds: readonly string[]
  readonly appliedEdits: readonly AppliedEdit[]
  readonly appliedComponents: readonly string[]
  readonly previousSnapshotRef: string
  readonly ledgerEntryId: string
  readonly applyMode: ApplyMode
  /** Round-6 Gate-v4 receipt (optional; v3 records omit it). */
  readonly gate?: GateV4Receipt
}

/** Why a compose decision was rejected. */
export type ComposeRejectedReason =
  | 'low-evidence'
  | 'observe-only'
  | 'cost-limit'
  | 'compose-not-wired'
  | 'regression'

/** Payload of `compose/rejected`. */
export interface ComposeRejectedPayload {
  readonly taskId: string
  readonly cycleId: string
  readonly reason: ComposeRejectedReason
  readonly rejectedCandidateIds: readonly string[]
  readonly baselineMetrics: ProbeMetrics
  readonly trials: readonly TrialRecord[]
  /** Round-6 Gate-v4 receipt (optional; v3 records omit it). */
  readonly gate?: GateV4Receipt
}

/** Why the Propose stage produced no usable candidates (round 4). */
export type ProposeFailedReason =
  | 'llm-error'
  | 'schema-invalid'
  | 'hash-mismatch'
  | 'component-invalid'

/** Payload of `propose/failed`: a terminal state of one cycle (round 4 R4-1). */
export interface ProposeFailedPayload {
  readonly taskId: string
  readonly cycleId: string
  readonly reason: ProposeFailedReason
  /** Number of Propose attempts (frozen: 2, including the retry). */
  readonly attempts: number
  /** Human-readable last error, escaped and ≤300 characters. */
  readonly lastError?: string
  readonly baselineMetrics?: ProbeMetrics
  /** ISO 8601 timestamp; mirrors the ledger envelope's `recordedAt`. */
  readonly recordedAt: string
}

/** Propose output consumed by Probe and referenced by Compose. */
export interface HarnessCandidate {
  readonly candidateId: string
  readonly candidateType: CandidateType
  readonly edit: {
    readonly component: string
    readonly operation: string
    readonly content: string
    readonly contentHash: string
  }
}

/* ------------------------- priors query (read-only) ----------------------- */

/** Query constructed by Propose before asking the experience library. */
export interface PriorsQuery {
  readonly failureSignature: {
    readonly toolName?: string
    readonly errorCode?: string
    readonly messagePattern?: string
    readonly taskDomain?: string
  }
  readonly appliedComponents?: readonly string[]
  readonly limit?: number
}

/** One experience entry as returned by the meta plugin. */
export interface ExperienceEntry {
  readonly id: string
  readonly condition: {
    readonly failurePattern: string
    readonly taskDomain?: string
    readonly observedIn: readonly string[]
  }
  readonly edit: {
    readonly component: string
    readonly operation: string
    readonly contentHash: string
    readonly contentPreview: string
  }
  readonly outcome: {
    readonly metricDelta: Readonly<Record<string, number>>
    readonly trials: number
    readonly adoption: 'accepted' | 'rejected'
  }
  readonly confidence: number
}

/** Result of one experience query. */
export interface PriorsResult {
  readonly priors: readonly ExperienceEntry[]
  readonly totalMatched: number
}

/** Read-only facade provided by the meta plugin. */
export interface Harness2ExperienceFacade {
  readonly ready: boolean
  queryPriors(query: PriorsQuery): PriorsResult
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'probe/completed'(payload: ProbeCompletedPayload): void
    'compose/applied'(payload: ComposeAppliedPayload): void
    'compose/rejected'(payload: ComposeRejectedPayload): void
    /** Round-4 terminal state: Propose produced no validated candidates. */
    'propose/failed'(payload: ProposeFailedPayload): void
  }

  interface Context {
    harness2Experience?: Harness2ExperienceFacade
  }
}

/* -------------------------------------------------------------------------- */
/* Payload validation                                                         */
/* -------------------------------------------------------------------------- */

export const MAX_TRIALS = 2
export const MAX_EVIDENCE_SUMMARY = 500
export const MAX_TRIAL_ERROR = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value)
  if (keys.length < required.length) return false
  for (const key of required) if (!(key in value)) return false
  for (const key of keys) if (!required.includes(key) && !optional.includes(key)) return false
  return true
}

/** Validate a `sha256:<hex>` content hash. */
export function isSha256Hash(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}

/** Validate one `ProbeMetrics` value (round-3: tokenCostSource required). */
export function validateProbeMetrics(value: unknown): string[] {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'completion', 'toolFailures', 'stepCount', 'tokenCost', 'tokenCostSource', 'durationMs',
    ])
  ) {
    return ['metrics must have exactly completion/toolFailures/stepCount/tokenCost/tokenCostSource/durationMs']
  }
  const errors: string[] = []
  if (typeof value.completion !== 'boolean') errors.push('metrics.completion must be boolean')
  for (const key of ['toolFailures', 'stepCount', 'tokenCost', 'durationMs'] as const) {
    if (!isFiniteNumber(value[key]) || (value[key] as number) < 0) {
      errors.push(`metrics.${key} must be a non-negative finite number`)
    }
  }
  if (value.tokenCostSource !== 'measured' && value.tokenCostSource !== 'estimated') {
    errors.push('metrics.tokenCostSource must be measured | estimated')
  }
  return errors
}

/** Validate one `TrialRecord` value (round-3: metadata is required). */
export function validateTrialRecord(value: unknown): string[] {
  if (
    !isRecord(value)
    || !hasExactKeys(
      value,
      ['candidateId', 'candidateType', 'component', 'operation', 'editContentHash', 'valid'],
      ['metrics', 'error', 'applicability'],
    )
  ) {
    return ['trial must have exactly candidateId/candidateType/component/operation/editContentHash/valid (+ metrics/error/applicability)']
  }
  const errors: string[] = []
  if (typeof value.candidateId !== 'string' || value.candidateId.length === 0) {
    errors.push('trial.candidateId must be a non-empty string')
  }
  if (value.candidateType !== 'invariant' && value.candidateType !== 'domain') {
    errors.push('trial.candidateType must be invariant | domain')
  }
  if (!isComponentName(value.component)) errors.push('trial.component is not a frozen component name')
  if (typeof value.operation !== 'string' || value.operation.length === 0) {
    errors.push('trial.operation must be a non-empty string')
  }
  if (!isSha256Hash(value.editContentHash)) errors.push('trial.editContentHash must be sha256:<hex>')
  if (typeof value.valid !== 'boolean') errors.push('trial.valid must be boolean')
  if (value.applicability !== undefined
    && value.applicability !== 'applied'
    && value.applicability !== 'unavailable') {
    errors.push('trial.applicability must be applied | unavailable')
  }
  if (value.valid === true) {
    if (value.metrics === undefined) errors.push('valid trial requires metrics')
    else errors.push(...validateProbeMetrics(value.metrics))
    if (value.error !== undefined) errors.push('valid trial must not carry error')
  } else {
    if (value.metrics !== undefined) errors.push('invalid trial must not carry metrics')
    if (typeof value.error !== 'string' || value.error.length === 0) {
      errors.push('invalid trial requires a non-empty error')
    } else if (value.error.length > MAX_TRIAL_ERROR) {
      errors.push(`trial.error must be ≤ ${MAX_TRIAL_ERROR} characters`)
    }
  }
  return errors
}

/**
 * Q1: whether a trial carries the required candidate metadata.
 *
 * The plugin constructs trials from validated Propose candidates, so this is a
 * defensive check: when it ever fails, `probe/completed` is refused with
 * `onError('trial-metadata-incomplete')` instead of emitting a partial record.
 */
export function trialMetadataComplete(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.candidateId === 'string' && value.candidateId.length > 0
    && isComponentName(value.component)
    && typeof value.operation === 'string' && value.operation.length > 0
    && isSha256Hash(value.editContentHash)
}

/** Validate the optional Round-6 Gate-v4 receipt embedded in payloads. */
export function validateGateReceipt(value: unknown): string[] {
  if (!isRecord(value)) return ['gate must be an object']
  const errors: string[] = []
  if (value.version !== 'gate/v4') errors.push('gate.version must be gate/v4')
  if (value.policy !== 'v4') errors.push('gate.policy must be v4')
  if (typeof value.controlCount !== 'number' || value.controlCount < 0) errors.push('gate.controlCount must be ≥0')
  if (typeof value.stable !== 'boolean') errors.push('gate.stable must be boolean')
  if (!Array.isArray(value.candidates)) errors.push('gate.candidates must be an array')
  if (!Array.isArray(value.appliedCandidateIds)) errors.push('gate.appliedCandidateIds must be an array')
  if (!Array.isArray(value.rejectedCandidateIds)) errors.push('gate.rejectedCandidateIds must be an array')
  if (value.reason !== undefined && value.reason !== 'low-evidence' && value.reason !== 'regression') {
    errors.push('gate.reason must be low-evidence | regression when present')
  }
  return errors
}

/** Validate a payload against the frozen `probe/completed` schema. */
export function validateProbeCompletedPayload(value: unknown): string[] {
  if (
    !isRecord(value)
    || !hasExactKeys(
      value,
      ['taskId', 'baselineMetrics', 'trials', 'evidenceSummary', 'cycleId'],
      ['controlMetrics'],
    )
  ) {
    return ['probe/completed must have taskId/baselineMetrics/trials/evidenceSummary/cycleId (+ optional controlMetrics)']
  }
  const errors: string[] = []
  if (typeof value.taskId !== 'string' || value.taskId.length === 0) errors.push('taskId must be a non-empty string')
  if (typeof value.cycleId !== 'string' || value.cycleId.length === 0) errors.push('cycleId must be a non-empty string')
  errors.push(...validateProbeMetrics(value.baselineMetrics))
  if (!Array.isArray(value.trials) || value.trials.length < 1 || value.trials.length > MAX_TRIALS) {
    errors.push(`trials must contain 1..${MAX_TRIALS} records`)
  } else {
    for (const trial of value.trials) errors.push(...validateTrialRecord(trial))
  }
  if (typeof value.evidenceSummary !== 'string' || value.evidenceSummary.length === 0) {
    errors.push('evidenceSummary must be a non-empty string')
  } else if (value.evidenceSummary.length > MAX_EVIDENCE_SUMMARY) {
    errors.push(`evidenceSummary must be ≤ ${MAX_EVIDENCE_SUMMARY} characters`)
  }
  if (value.controlMetrics !== undefined) {
    if (!Array.isArray(value.controlMetrics) || value.controlMetrics.length > 4) {
      errors.push('controlMetrics must be an array of at most 4 metrics')
    } else {
      for (const metrics of value.controlMetrics) errors.push(...validateProbeMetrics(metrics))
    }
  }
  return errors
}

/** Validate one `AppliedEdit` value. */
export function validateAppliedEdit(value: unknown): string[] {
  if (!isRecord(value) || !hasExactKeys(value, ['candidateId', 'contentHash', 'component', 'operation'])) {
    return ['appliedEdit must have exactly candidateId/contentHash/component/operation']
  }
  const errors: string[] = []
  if (typeof value.candidateId !== 'string' || value.candidateId.length === 0) {
    errors.push('appliedEdit.candidateId must be a non-empty string')
  }
  if (!isSha256Hash(value.contentHash)) errors.push('appliedEdit.contentHash must be sha256:<hex>')
  if (!isComponentName(value.component)) errors.push('appliedEdit.component is not a frozen component name')
  if (typeof value.operation !== 'string' || value.operation.length === 0) {
    errors.push('appliedEdit.operation must be a non-empty string')
  }
  return errors
}

/** Validate a payload against the frozen `compose/applied` schema. */
export function validateComposeAppliedPayload(value: unknown): string[] {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'taskId', 'cycleId', 'appliedCandidateIds', 'appliedEdits',
      'appliedComponents', 'previousSnapshotRef', 'ledgerEntryId', 'applyMode',
    ], ['gate'])
  ) {
    return ['compose/applied has an unexpected field set']
  }
  const errors: string[] = []
  for (const key of ['taskId', 'cycleId', 'previousSnapshotRef', 'ledgerEntryId'] as const) {
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
      errors.push(`${key} must be a non-empty string`)
    }
  }
  const candidateIds = Array.isArray(value.appliedCandidateIds) ? value.appliedCandidateIds : []
  const edits = Array.isArray(value.appliedEdits) ? value.appliedEdits : []
  if (candidateIds.length === 0) errors.push('appliedCandidateIds must be a non-empty array')
  if (edits.length !== candidateIds.length) {
    errors.push('appliedEdits must correspond one-to-one with appliedCandidateIds')
  }
  for (const edit of edits) errors.push(...validateAppliedEdit(edit))
  if (edits.length === candidateIds.length) {
    const ids = new Set(candidateIds)
    for (const edit of edits) {
      if (isRecord(edit) && typeof edit.candidateId === 'string' && !ids.has(edit.candidateId)) {
        errors.push('appliedEdits candidateId set differs from appliedCandidateIds')
      }
    }
  }
  const components = Array.isArray(value.appliedComponents) ? value.appliedComponents : []
  if (components.length === 0) errors.push('appliedComponents must be a non-empty array')
  for (const component of components) {
    if (!isComponentName(component)) errors.push(`unknown component ${String(component)}`)
  }
  const derived = new Set(
    edits
      .filter(isRecord)
      .map((edit) => edit.component)
      .filter((component): component is string => typeof component === 'string'),
  )
  if (derived.size > 0) {
    const listed = new Set(components.filter((component): component is string => typeof component === 'string'))
    if (derived.size !== listed.size || [...derived].some((component) => !listed.has(component))) {
      errors.push('appliedComponents must equal the unique components of appliedEdits')
    }
  }
  if (value.applyMode !== 'pre-step-patch' && value.applyMode !== 'next-task-ledger' && value.applyMode !== 'noop-todo') {
    errors.push('applyMode must be pre-step-patch | next-task-ledger | noop-todo')
  }
  if (value.gate !== undefined) errors.push(...validateGateReceipt(value.gate))
  return errors
}

/** Validate a payload against the frozen `compose/rejected` schema. */
export function validateComposeRejectedPayload(value: unknown): string[] {
  if (
    !isRecord(value)
    || !hasExactKeys(
      value,
      ['taskId', 'cycleId', 'reason', 'rejectedCandidateIds', 'baselineMetrics', 'trials'],
      ['gate'],
    )
  ) {
    return ['compose/rejected must have exactly taskId/cycleId/reason/rejectedCandidateIds/baselineMetrics/trials (+ optional gate)']
  }
  const errors: string[] = []
  if (typeof value.taskId !== 'string' || value.taskId.length === 0) errors.push('taskId must be a non-empty string')
  if (typeof value.cycleId !== 'string' || value.cycleId.length === 0) errors.push('cycleId must be a non-empty string')
  const reasons = ['low-evidence', 'observe-only', 'cost-limit', 'compose-not-wired', 'regression']
  if (typeof value.reason !== 'string' || !reasons.includes(value.reason)) {
    errors.push('reason is not one of the frozen reasons')
  }
  errors.push(...validateProbeMetrics(value.baselineMetrics))
  const trials = Array.isArray(value.trials) ? value.trials : []
  for (const trial of trials) errors.push(...validateTrialRecord(trial))
  const trialIds = new Set(
    trials.filter(isRecord).map((trial) => trial.candidateId).filter((id): id is string => typeof id === 'string'),
  )
  const rejected = Array.isArray(value.rejectedCandidateIds) ? value.rejectedCandidateIds : []
  if (rejected.length === 0) errors.push('rejectedCandidateIds must be non-empty')
  for (const id of rejected) {
    if (typeof id !== 'string' || !trialIds.has(id)) {
      errors.push('every rejectedCandidateId must exist in the same payload trials')
      break
    }
  }
  if (value.gate !== undefined) errors.push(...validateGateReceipt(value.gate))
  return errors
}

/** Validate a payload against the frozen `propose/failed` schema (R4-1). */
export function validateProposeFailedPayload(value: unknown): string[] {
  if (
    !isRecord(value)
    || !hasExactKeys(
      value,
      ['taskId', 'cycleId', 'reason', 'attempts', 'recordedAt'],
      ['lastError', 'baselineMetrics'],
    )
  ) {
    return ['propose/failed must have exactly taskId/cycleId/reason/attempts/recordedAt (+ optional lastError/baselineMetrics)']
  }
  const errors: string[] = []
  if (typeof value.taskId !== 'string' || value.taskId.length === 0) errors.push('taskId must be a non-empty string')
  if (typeof value.cycleId !== 'string' || value.cycleId.length === 0) errors.push('cycleId must be a non-empty string')
  const reasons = ['llm-error', 'schema-invalid', 'hash-mismatch', 'component-invalid']
  if (typeof value.reason !== 'string' || !reasons.includes(value.reason)) {
    errors.push('reason is not one of the frozen propose-failure reasons')
  }
  if (value.attempts !== 2) errors.push('attempts must be 2 (frozen)')
  if (typeof value.recordedAt !== 'string' || value.recordedAt.length === 0) {
    errors.push('recordedAt must be a non-empty ISO string')
  }
  if (value.lastError !== undefined) {
    if (typeof value.lastError !== 'string') errors.push('lastError must be a string')
    else if (value.lastError.length > 300) errors.push('lastError must be ≤300 characters')
  }
  if (value.baselineMetrics !== undefined) errors.push(...validateProbeMetrics(value.baselineMetrics))
  return errors
}

/** Validate a payload and prove it is losslessly JSON-serializable. */
export function assertJsonSafePayload(
  validator: (value: unknown) => string[],
  payload: unknown,
): string[] {
  const errors = validator(payload)
  try {
    const encoded = JSON.stringify(payload)
    if (encoded === undefined) errors.push('payload is not JSON-serializable')
    else if (typeof payload === 'object' && payload !== null) {
      const decoded: unknown = JSON.parse(encoded)
      if (JSON.stringify(decoded) !== encoded) errors.push('payload is not losslessly JSON-serializable')
    }
  } catch (error) {
    errors.push(`payload is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`)
  }
  return errors
}

/* -------------------------------------------------------------------------- */
/* Storage paths and versioned ledger (v3, accepts v2)                        */
/* -------------------------------------------------------------------------- */

/** Ledger envelope version written by round 3. */
export const LEDGER_VERSION = 'harness2-ledger/v3'
/** Legacy envelope version accepted (read-only, mapped in memory). */
export const LEDGER_VERSION_V2 = 'harness2-ledger/v2'

/** One ledger record payload. */
export type LedgerPayload =
  | ProbeCompletedPayload
  | ComposeAppliedPayload
  | ComposeRejectedPayload
  | ProposeFailedPayload

/** Round-3 ledger envelope. */
export interface LedgerEnvelopeV3 {
  readonly version: typeof LEDGER_VERSION
  readonly id: string
  readonly previousSnapshotRef: string | null
  readonly ledgerEntryId: string
  readonly event:
    | 'propose/failed'
    | 'probe/completed'
    | 'compose/applied'
    | 'compose/rejected'
  readonly payload: LedgerPayload
  /** ISO 8601 timestamp. */
  readonly recordedAt: string
}

/** Append-only ledger handle. */
export interface Ledger {
  append(record: LedgerEnvelopeV3): Promise<void>
}

/** Result of reading the ledger tail. */
export interface LedgerTail {
  readonly found: boolean
  readonly version?: 'v2' | 'v3'
  readonly id?: string
  readonly payload?: LedgerPayload
  readonly mappedFromV2?: boolean
}

/** Resolve a configured storage path. */
export function resolveStoragePath(configuredPath: string): string {
  const value = configuredPath.trim()
  if (path.isAbsolute(value)) return value
  const home = process.env.DSH_HOME?.trim()
  const base = home !== undefined && home.length > 0 ? path.join(home, 'harness2') : process.cwd()
  return path.resolve(base, value.length > 0 ? value : 'harness2-ledger.jsonl')
}

/** Create a serialized append-only JSONL v3 ledger. */
export function createLedger(
  ledgerPath: string,
  options: { readonly onError?: (error: unknown) => void } = {},
): Ledger {
  const absolute = resolveStoragePath(ledgerPath)
  let tail: Promise<void> = Promise.resolve()
  return {
    append(record) {
      if (record.version !== LEDGER_VERSION) {
        throw new Error('refusing to write a non-v3 ledger envelope')
      }
      const task = tail.then(async () => {
        await mkdir(path.dirname(absolute), { recursive: true })
        await appendFile(absolute, `${JSON.stringify(record)}\n`, 'utf8')
      })
      tail = task.catch((error: unknown) => options.onError?.(error))
      return task
    },
  }
}

/** Add a conservative `tokenCostSource` to v2 metrics (in memory only). */
function withTokenCostSource(metrics: unknown): unknown {
  if (!isRecord(metrics)) return metrics
  return 'tokenCostSource' in metrics ? metrics : { ...metrics, tokenCostSource: 'estimated' }
}

/** Map one v2 record to the v3 memory shape (never written back). */
function mapV2Record(value: Record<string, unknown>): { id: string; payload: LedgerPayload } | undefined {
  if (typeof value.id !== 'string' || value.id.length === 0) return undefined
  if (!isRecord(value.payload)) return undefined
  const mapped: Record<string, unknown> = { ...value.payload }
  if (value.type === 'compose/applied') mapped.appliedEdits = []
  else if (value.type === 'compose/rejected') mapped.rejectedCandidateIds = []
  mapped.baselineMetrics = withTokenCostSource(mapped.baselineMetrics)
  if (Array.isArray(mapped.trials)) {
    mapped.trials = mapped.trials.map((trial) => {
      if (!isRecord(trial) || !isRecord(trial.metrics)) return trial
      return { ...trial, metrics: withTokenCostSource(trial.metrics) }
    })
  }
  return { id: value.id, payload: mapped as unknown as LedgerPayload }
}

/**
 * Read the most recent usable Harness revision record (round 4).
 *
 * `propose/failed` is a terminal diagnostic record and carries no revision, so
 * `next-task-ledger` detection skips it and keeps scanning backwards for the
 * latest `compose/applied` or `compose/rejected`.
 */
export async function readRevisionAnchor(ledgerPath: string): Promise<LedgerTail> {
  let text: string
  try {
    text = await readFile(resolveStoragePath(ledgerPath), 'utf8')
  } catch {
    return { found: false }
  }
  const lines = text.trim().split('\n').filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line === undefined) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(value)) continue
    if (value.version === LEDGER_VERSION) {
      if (value.event !== 'compose/applied' && value.event !== 'compose/rejected') continue
      if (typeof value.id !== 'string' || value.id.length === 0) continue
      if (!isRecord(value.payload)) continue
      return { found: true, version: 'v3', id: value.id, payload: value.payload as unknown as LedgerPayload }
    }
    if (value.schema === LEDGER_VERSION_V2) {
      if (value.type !== 'compose/applied' && value.type !== 'compose/rejected') continue
      const mapped = mapV2Record(value)
      if (mapped === undefined) continue
      return { found: true, version: 'v2', id: mapped.id, payload: mapped.payload, mappedFromV2: true }
    }
  }
  return { found: false }
}

/**
 * Read the last parseable ledger record without writing.
 *
 * Accepts v3 and v2; v2 is mapped in memory only (no migration write-back).
 */
export async function readLedgerTail(ledgerPath: string): Promise<LedgerTail> {
  let text: string
  try {
    text = await readFile(resolveStoragePath(ledgerPath), 'utf8')
  } catch {
    return { found: false }
  }
  const lines = text.trim().split('\n').filter(Boolean)
  const last = lines.at(-1)
  if (last === undefined) return { found: false }
  try {
    const value: unknown = JSON.parse(last)
    if (!isRecord(value)) return { found: false }
    if (value.version === LEDGER_VERSION) {
      if (typeof value.id !== 'string' || value.id.length === 0) return { found: false }
      if (!isRecord(value.payload)) return { found: false }
      return {
        found: true,
        version: 'v3',
        id: value.id,
        payload: value.payload as unknown as LedgerPayload,
      }
    }
    if (value.schema === LEDGER_VERSION_V2) {
      const mapped = mapV2Record(value)
      if (mapped === undefined) return { found: false }
      return { found: true, version: 'v2', id: mapped.id, payload: mapped.payload, mappedFromV2: true }
    }
    return { found: false }
  } catch {
    return { found: false }
  }
}

/* -------------------------------------------------------------------------- */
/* Failure tracking                                                           */
/* -------------------------------------------------------------------------- */

export interface FailureTrajectoryEntry {
  readonly source: 'tool-result' | 'request-error'
  readonly at: number
  readonly step: number
  readonly toolName?: string
  readonly errorCode?: string
  readonly message: string
}

export interface SessionFailureState {
  requestErrors: number
  toolFailureStreak: number
  failedTool: string | undefined
  firstFailureAt: number
  lastTriggerAt: number
  lastStep: number
  probeInFlight: boolean
  trajectory: FailureTrajectoryEntry[]
}

export function createFailureState(): SessionFailureState {
  return {
    requestErrors: 0,
    toolFailureStreak: 0,
    failedTool: undefined,
    firstFailureAt: 0,
    lastTriggerAt: 0,
    lastStep: 0,
    probeInFlight: false,
    trajectory: [],
  }
}

function pushTrajectory(state: SessionFailureState, entry: FailureTrajectoryEntry, window: number): void {
  state.trajectory.push(entry)
  const limit = Math.max(1, Math.floor(window))
  while (state.trajectory.length > limit) state.trajectory.shift()
}

export function noteRequestError(
  state: SessionFailureState,
  failure: { readonly at: number; readonly step: number; readonly message: string; readonly errorCode?: string },
  window = 5,
): void {
  state.requestErrors += 1
  if (state.firstFailureAt === 0) state.firstFailureAt = failure.at
  state.lastStep = Math.max(state.lastStep, failure.step)
  pushTrajectory(
    state,
    {
      source: 'request-error',
      at: failure.at,
      step: failure.step,
      message: failure.message,
      ...(failure.errorCode === undefined ? {} : { errorCode: failure.errorCode }),
    },
    window,
  )
}

export function noteToolResult(
  state: SessionFailureState,
  observation: {
    readonly toolName: string
    readonly failed: boolean
    readonly message: string
    readonly errorCode?: string
    readonly at: number
    readonly step: number
  },
  window = 5,
): void {
  if (!observation.failed) {
    state.toolFailureStreak = 0
    state.failedTool = undefined
    return
  }
  if (state.firstFailureAt === 0) state.firstFailureAt = observation.at
  if (state.failedTool === observation.toolName) state.toolFailureStreak += 1
  else {
    state.failedTool = observation.toolName
    state.toolFailureStreak = 1
  }
  state.lastStep = Math.max(state.lastStep, observation.step)
  pushTrajectory(
    state,
    {
      source: 'tool-result',
      at: observation.at,
      step: observation.step,
      toolName: observation.toolName,
      message: observation.message,
      ...(observation.errorCode === undefined ? {} : { errorCode: observation.errorCode }),
    },
    window,
  )
}

export type ProbeTrigger = 'request-error-threshold' | 'repeated-tool-failure'

export interface TriggerDecision {
  readonly trigger: ProbeTrigger
  readonly failures: number
}

export function selectTrigger(
  state: SessionFailureState,
  config: Config,
  now: number,
): TriggerDecision | undefined {
  if (state.probeInFlight) return undefined
  if (now - state.lastTriggerAt < config.cooldownMs) return undefined
  if (state.requestErrors >= config.triggerThreshold) {
    return { trigger: 'request-error-threshold', failures: state.requestErrors }
  }
  if (state.toolFailureStreak >= config.repeatedFailureWindow) {
    return { trigger: 'repeated-tool-failure', failures: state.toolFailureStreak }
  }
  return undefined
}

/* -------------------------------------------------------------------------- */
/* Metrics (measured-first, round-3 Q4)                                       */
/* -------------------------------------------------------------------------- */

export function errorCodeOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const info = record.info
  if (info !== null && typeof info === 'object') {
    const code = (info as Record<string, unknown>).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  if (typeof record.code === 'string' && record.code.length > 0) return record.code
  if (typeof record.name === 'string' && record.name.length > 0) return record.name
  return undefined
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Measure one session through the optional host tokenMeter service.
 *
 * The service is not in the static `inject` array (frozen since round 1); it is
 * read through `ctx.get` and degrades to `undefined` when absent.
 */
export function measureSessionTokens(ctx: Context, session: Session): number | undefined {
  try {
    const meter: TokenMeter | undefined = ctx.get('tokenMeter')
    if (meter === undefined) return undefined
    const measurement = meter.measure(session)
    return Number.isFinite(measurement.totalTokens) ? measurement.totalTokens : undefined
  } catch {
    return undefined
  }
}

/** Baseline metrics derived from the main agent's failure trajectory. */
export function baselineMetricsOf(
  ctx: Context,
  agent: Agent,
  state: SessionFailureState,
  trigger: ProbeTrigger,
  now: number,
): ProbeMetrics {
  const trajectoryText = state.trajectory.map((entry) => entry.message).join('\n')
  const measured = measureSessionTokens(ctx, agent.session)
  return {
    completion: false,
    toolFailures:
      trigger === 'repeated-tool-failure'
        ? Math.max(1, state.toolFailureStreak)
        : Math.max(1, state.requestErrors),
    stepCount: Math.max(0, state.lastStep),
    tokenCost: measured ?? estimateTokens(trajectoryText),
    tokenCostSource: measured === undefined ? 'estimated' : 'measured',
    durationMs: Math.max(0, now - (state.firstFailureAt === 0 ? now : state.firstFailureAt)),
  }
}

/** Signed per-metric delta; positive always means "better than baseline". */
export function metricDeltaOf(
  baseline: ProbeMetrics,
  trial: ProbeMetrics,
): Readonly<Record<string, number>> {
  return {
    completion: (trial.completion ? 1 : 0) - (baseline.completion ? 1 : 0),
    toolFailures: baseline.toolFailures - trial.toolFailures,
    stepCount: baseline.stepCount - trial.stepCount,
    tokenCost: baseline.tokenCost - trial.tokenCost,
  }
}

export function scoreTrial(
  baseline: ProbeMetrics,
  trial: ProbeMetrics,
  weights: Config['metricWeights'],
): number {
  const delta = metricDeltaOf(baseline, trial)
  return (
    weights.completion * (delta.completion ?? 0)
    + weights.toolFailures * (delta.toolFailures ?? 0)
    + weights.stepCount * (delta.stepCount ?? 0)
    + weights.tokenCost * (delta.tokenCost ?? 0)
  )
}

export function buildEvidenceSummary(state: SessionFailureState, trigger: ProbeTrigger): string {
  const latest = state.trajectory.at(-1)
  const raw = latest === undefined
    ? `trigger=${trigger}`
    : `tool=${latest.toolName ?? 'unknown'};code=${latest.errorCode ?? 'unknown'}; ${latest.message}`
  const escaped = raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/</g, '&lt;')
    .trim()
  return escaped.slice(0, MAX_EVIDENCE_SUMMARY)
}

export function buildPriorsQuery(
  state: SessionFailureState,
  config: Config,
  appliedComponents: readonly string[],
): PriorsQuery {
  const latest = state.trajectory.at(-1)
  const failureSignature = {
    ...(latest?.toolName === undefined ? {} : { toolName: latest.toolName }),
    ...(latest?.errorCode === undefined ? {} : { errorCode: latest.errorCode }),
    ...(latest?.message === undefined ? {} : { messagePattern: latest.message.slice(0, 80) }),
    ...(config.taskDomain.length === 0 ? {} : { taskDomain: config.taskDomain }),
  }
  return { failureSignature, appliedComponents }
}

/* -------------------------------------------------------------------------- */
/* Compose decision                                                           */
/* -------------------------------------------------------------------------- */

export type ComposeDecision =
  | {
      readonly kind: 'reject'
      readonly reason: ComposeRejectedReason
      /** Contract-level rejected set (payload builder intersects with trials). */
      readonly rejectedCandidateIds: readonly string[]
      readonly gate?: GateV4Receipt
    }
  | {
      readonly kind: 'apply'
      readonly appliedCandidateIds: readonly string[]
      readonly appliedComponents: readonly string[]
      readonly candidates: readonly HarnessCandidate[]
      readonly gate?: GateV4Receipt
    }

/** Deterministic compose gate over the frozen decision procedure. */
export function decideCompose(input: {
  readonly probe: ProbeCompletedPayload
  readonly candidates: readonly HarnessCandidate[]
  readonly cycleTokenCost: number
  readonly config: Config
}): ComposeDecision {
  if (input.config.gatePolicy === 'v3') return decideComposeV3(input)
  return decideComposeV4(input)
}

/** Round-6 Gate-v4 admission path (fail-closed; no silent v3 fallback). */
function decideComposeV4(input: {
  readonly probe: ProbeCompletedPayload
  readonly candidates: readonly HarnessCandidate[]
  readonly cycleTokenCost: number
  readonly config: Config
}): ComposeDecision {
  const trialIds = input.probe.trials.map((trial) => trial.candidateId)
  if (input.config.observeOnly) {
    return { kind: 'reject', reason: 'observe-only', rejectedCandidateIds: trialIds }
  }
  if (input.cycleTokenCost > input.config.maxCostPerCycle) {
    return { kind: 'reject', reason: 'cost-limit', rejectedCandidateIds: trialIds }
  }
  const trialById = new Map(input.probe.trials.map((trial) => [trial.candidateId, trial]))
  const gateInput = input.candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    component: candidate.edit.component,
    operation: candidate.edit.operation,
    content: candidate.edit.content,
    trial: trialById.get(candidate.candidateId) ?? { valid: false as const },
  }))
  const gate = evaluateGateV4({
    controls: (input.probe.controlMetrics ?? []) as readonly GateMetrics[],
    candidates: gateInput,
    maxAppliedEdits: Math.max(1, Math.min(2, Math.floor(input.config.maxAppliedEdits))),
  })
  if (gate.kind === 'reject') {
    const rejected = gate.rejectedCandidateIds.filter((id) => trialIds.includes(id))
    return {
      kind: 'reject',
      reason: gate.reason,
      rejectedCandidateIds: rejected.length > 0 ? rejected : trialIds,
      gate: gate.gate,
    }
  }
  const byId = new Map(input.candidates.map((candidate) => [candidate.candidateId, candidate]))
  const candidates = gate.appliedCandidateIds
    .map((candidateId) => byId.get(candidateId))
    .filter((candidate): candidate is HarnessCandidate => candidate !== undefined)
  return {
    kind: 'apply',
    appliedCandidateIds: candidates.map((candidate) => candidate.candidateId),
    appliedComponents: candidates.map((candidate) => candidate.edit.component),
    candidates,
    gate: gate.gate,
  }
}

/** Round-3/4/5 Gate-v3 procedure, kept only for archived replay. */
function decideComposeV3(input: {
  readonly probe: ProbeCompletedPayload
  readonly candidates: readonly HarnessCandidate[]
  readonly cycleTokenCost: number
  readonly config: Config
}): ComposeDecision {
  // R4-2: rejection ids are always drawn from trials (Propose candidates that
  // never entered Probe are not attributable and must not be listed).
  const trialIds = input.probe.trials.map((trial) => trial.candidateId)
  if (input.config.observeOnly) {
    return { kind: 'reject', reason: 'observe-only', rejectedCandidateIds: trialIds }
  }
  if (input.cycleTokenCost > input.config.maxCostPerCycle) {
    return { kind: 'reject', reason: 'cost-limit', rejectedCandidateIds: trialIds }
  }
  const validTrials = input.probe.trials.filter(
    (trial): trial is TrialRecord & { readonly metrics: ProbeMetrics } =>
      trial.valid && trial.metrics !== undefined,
  )
  if (validTrials.length === 0) {
    return {
      kind: 'reject',
      reason: 'low-evidence',
      rejectedCandidateIds: trialIds,
    }
  }
  const byId = new Map(input.candidates.map((candidate) => [candidate.candidateId, candidate]))
  const scored = validTrials.map((trial) => ({
    trial,
    candidate: byId.get(trial.candidateId),
    score: scoreTrial(input.probe.baselineMetrics, trial.metrics, input.config.metricWeights),
  }))
  const best = scored.reduce((left, right) => (right.score > left.score ? right : left))
  if (best.candidate === undefined || best.score <= 0) {
    return {
      kind: 'reject',
      reason: 'regression',
      rejectedCandidateIds: best.candidate === undefined
        ? input.probe.trials.map((trial) => trial.candidateId)
        : [best.candidate.candidateId],
    }
  }
  const applied = [best]
  if (scored.length === 2) {
    const other = scored.find((item) => item !== best)
    if (other !== undefined && other.candidate !== undefined && other.score > 0) {
      const components = new Set([best.candidate.edit.component, other.candidate.edit.component])
      if (components.size === 2) applied.push(other)
    }
  }
  return {
    kind: 'apply',
    appliedCandidateIds: applied.map((item) => item.candidate!.candidateId),
    appliedComponents: applied.map((item) => item.candidate!.edit.component),
    candidates: applied.map((item) => item.candidate!),
  }
}

/* -------------------------------------------------------------------------- */
/* Apply-mode detection and the pre-step applicator                           */
/* -------------------------------------------------------------------------- */

export async function detectApplyMode(ctx: Context, config: Config): Promise<ApplyMode> {
  try {
    const agents = ctx.agents as unknown as { current?: () => unknown }
    if (typeof agents.current === 'function') {
      const current = agents.current()
      if (current !== null && typeof current === 'object') {
        const patch = (current as { applyHarnessPatch?: unknown }).applyHarnessPatch
        if (typeof patch === 'function') return 'pre-step-patch'
      }
    }
  } catch {
    // Probe failures degrade; never throw out of detection.
  }
  const revision = await readRevisionAnchor(config.ledgerPath)
  if (revision.found) return 'next-task-ledger'
  // TODO(ROUND2_APPLY): dsh 0.2.1 exposes no runtime patch API (`applyHarnessPatch`)
  // and no readable compose revision exists yet; this is the honest noop degradation.
  return 'noop-todo'
}

/** Pending patch staged for the next `agent/pre-step`. */
export interface PendingPatch {
  readonly components: readonly string[]
  readonly edits: readonly HarnessCandidate['edit'][]
}

/** Apply the staged patch synchronously; never throws. */
export function applyPendingPatch(
  ctx: Context,
  pending: PendingPatch | undefined,
  onError: (message: string, error?: unknown) => void,
): boolean {
  if (pending === undefined) return false
  try {
    const agents = ctx.agents as unknown as {
      current?: () => { applyHarnessPatch?: (patch: PendingPatch) => void }
    }
    const current = typeof agents.current === 'function' ? agents.current() : undefined
    if (current === undefined || typeof current.applyHarnessPatch !== 'function') {
      onError('pre-step-patch-unavailable')
      return false
    }
    current.applyHarnessPatch(pending)
    return true
  } catch (error) {
    onError('pre-step-patch-failed', error)
    return false
  }
}

/* -------------------------------------------------------------------------- */
/* Propose stage                                                              */
/* -------------------------------------------------------------------------- */

export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

export function resolveModelRoute(ctx: Context, configuredModel: string): ModelRoute | undefined {
  const selection: AgentDefaultModelConfig | undefined = ctx.get('agentDefaultModel')
  const current = selection?.currentSelection()
  const configured = configuredModel.trim()
  if (configured.length === 0) {
    return current === undefined ? undefined : { provider: current.provider, model: current.model }
  }
  const separator = configured.indexOf('/')
  if (separator > 0 && separator < configured.length - 1) {
    return { provider: configured.slice(0, separator), model: configured.slice(separator + 1) }
  }
  return current === undefined ? undefined : { provider: current.provider, model: configured }
}

const PROPOSE_SYSTEM = `You are the Propose stage of a task-recursion system.
Given the recent failure trajectory, the current harness configuration snapshot,
and prior experience entries, propose exactly TWO candidate harness edits:
one with candidateType "invariant" and one with candidateType "domain".
Answer with STRICT JSON only, no markdown:
{"candidates":[{"candidateType":"invariant","edit":{"component":"<component>","operation":"<operation>","content":"<content>","contentHash":"sha256:<hex>"}},{"candidateType":"domain","edit":{...}}]}
Round-6 canonical operations (ONLY these are admitted):
- component "system-prompt", operation "set-persona-prefix" or "set-persona-suffix":
  content is a persona statement starting with "You are" / "The agent" / "This agent" / "Act as" (20-2000 chars).
- component "tool-guidance", operation "set-tool-order":
  content is a JSON array of registered tool names with exactly one "<unlisted-tools>" entry.
- component "plugins", operation "disable-row" or "enable-row":
  content is exactly one loader row id present in the snapshot.
- component "plugins", operation "set-harness2-config":
  content is JSON {"key":"<tunable key>","value":<number>} (never metricWeights, gatePolicy, paths or models).
Rules: content ≤4000 characters; no "do nothing"/"ignore the task"/"reply DONE"
style instructions; {{model}} and {{provider}} are the only variables. Do not
invent metrics. Do not assign confidence.`

/** SHA-256 hex digest of a string. */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Canonical content hash format: `sha256:<lowercase hex>`. */
export function contentHashOf(content: string): string {
  return `sha256:${sha256(content)}`
}

export class ProposalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProposalError'
  }
}

/** Parse and validate the Propose JSON into exactly two candidates. */
export function parseProposal(text: string): HarnessCandidate[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new ProposalError('proposal is not JSON')
  let value: unknown
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new ProposalError('proposal JSON does not parse')
  }
  if (!isRecord(value) || !Array.isArray(value.candidates) || value.candidates.length !== 2) {
    throw new ProposalError('proposal must contain exactly two candidates')
  }
  const candidates: HarnessCandidate[] = []
  const types = new Set<string>()
  for (const raw of value.candidates) {
    if (!isRecord(raw) || !isRecord(raw.edit)) throw new ProposalError('candidate shape is invalid')
    const candidateType = raw.candidateType
    if (candidateType !== 'invariant' && candidateType !== 'domain') {
      throw new ProposalError('candidateType must be invariant | domain')
    }
    if (types.has(candidateType)) throw new ProposalError('candidate types must be one each')
    types.add(candidateType)
    const component = raw.edit.component
    if (!isComponentName(component)) throw new ProposalError(`unknown component ${String(component)}`)
    const operation = raw.edit.operation
    if (typeof operation !== 'string' || operation.length === 0 || operation.length > 100) {
      throw new ProposalError('operation must be a 1..100 character string')
    }
    const content = raw.edit.content
    if (typeof content !== 'string' || content.length === 0 || content.length > 4000) {
      throw new ProposalError('content must be a 1..4000 character string')
    }
    const contentHash = raw.edit.contentHash
    if (contentHash !== contentHashOf(content)) {
      throw new ProposalError('contentHash must equal sha256(content) in sha256:<hex> form')
    }
    candidates.push({
      candidateId: `cand-${sha256(`${candidateType}:${component}:${content}`).slice(0, 16)}`,
      candidateType,
      edit: { component, operation, content, contentHash },
    })
  }
  return candidates
}

export function buildProposePrompt(input: {
  readonly taskId: string
  readonly trigger: ProbeTrigger
  readonly state: SessionFailureState
  readonly baseline: ProbeMetrics
  readonly config: Config
  readonly priors: readonly ExperienceEntry[]
  readonly harnessSnapshot: unknown
}): string {
  const trajectory = input.state.trajectory.map((entry) => ({
    source: entry.source,
    step: entry.step,
    toolName: entry.toolName,
    errorCode: entry.errorCode,
    message: entry.message.slice(0, 300),
  }))
  return JSON.stringify({
    taskId: input.taskId,
    trigger: input.trigger,
    replayScope: input.config.replayScope,
    baselineMetrics: input.baseline,
    failureTrajectory: trajectory,
    harnessSnapshot: input.harnessSnapshot,
    priorExperience: input.priors,
  })
}

export interface ProposalResult {
  readonly candidates: readonly HarnessCandidate[]
  readonly tokenCost: number
  readonly tokenCostSource: TokenCostSource
}

/* -------------------------------------------------------------------------- */
/* Probe stage                                                                */
/* -------------------------------------------------------------------------- */

export interface ProbeOutcome {
  readonly trials: readonly TrialRecord[]
  /** Round-6 recovery-control metrics (empty in gatePolicy v3). */
  readonly controlMetrics: readonly ProbeMetrics[]
  readonly tokenCost: number
}

/** Prompt for a no-edit recovery-control child (Gate-v4 admission). */
export function buildControlPrompt(input: {
  readonly taskId: string
  readonly cycleId: string
  readonly baseline: ProbeMetrics
  readonly replayScope: Config['replayScope']
  readonly trajectorySummary: string
}): string {
  return [
    'You are an ADVISORY replay subagent (control arm) for a task-recursion system.',
    'Your tools are NOT sandbox-restricted yet (TODO(ROUND2_SANDBOX)); do not',
    'modify the workspace, install packages, or run mutating commands.',
    `taskId: ${input.taskId}`,
    `cycleId: ${input.cycleId}`,
    `replayScope: ${input.replayScope}`,
    'NO candidate edit is applied in this arm. Replay the failed step as faithfully',
    'as possible with the unchanged harness, then finish.',
    'baseline metrics:',
    JSON.stringify(input.baseline),
    'failure summary:',
    input.trajectorySummary,
  ].join('\n')
}

export function buildProbePrompt(input: {
  readonly taskId: string
  readonly cycleId: string
  readonly candidate: HarnessCandidate
  readonly baseline: ProbeMetrics
  readonly replayScope: Config['replayScope']
  readonly trajectorySummary: string
}): string {
  return [
    'You are an ADVISORY replay subagent for a task-recursion system.',
    'Your tools are NOT sandbox-restricted yet (TODO(ROUND2_SANDBOX)); do not',
    'modify the workspace, install packages, or run mutating commands.',
    `taskId: ${input.taskId}`,
    `cycleId: ${input.cycleId}`,
    `replayScope: ${input.replayScope}`,
    `candidateId: ${input.candidate.candidateId} (${input.candidate.candidateType})`,
    `proposed component: ${input.candidate.edit.component}`,
    `proposed operation: ${input.candidate.edit.operation}`,
    'proposed edit:',
    input.candidate.edit.content,
    'baseline metrics:',
    JSON.stringify(input.baseline),
    'failure summary:',
    input.trajectorySummary,
    'Replay the failed step as faithfully as possible with this edit in mind,',
    'then finish. The harness measures behavior from your transcript.',
  ].join('\n')
}

/** Build trial metrics with a single, explicitly labelled token source. */
export function metricsFromTranscript(
  ctx: Context,
  agent: Agent,
  messages: readonly {
    readonly role: string
    readonly content: readonly { readonly type: string }[]
    readonly isError?: boolean
  }[],
  durationMs: number,
  promptText: string,
): ProbeMetrics {
  let toolFailures = 0
  let stepCount = 0
  let assistantMessages = 0
  let chars = estimateTokens(promptText) * 4
  for (const message of messages) {
    if (message.role === 'assistant') {
      stepCount += 1
      assistantMessages += 1
      for (const block of message.content) if (block.type === 'text') chars += 400
    }
    if (message.role === 'tool') {
      if (message.isError === true) toolFailures += 1
      for (const block of message.content) if (block.type === 'text') chars += 120
    }
  }
  const measured = measureSessionTokens(ctx, agent.session)
  return {
    // Round-6: a child that produced no assistant output did no observable work.
    // Admission is not certification, but it must not treat a dead child as a
    // successful trial.
    completion: assistantMessages > 0,
    toolFailures,
    stepCount,
    tokenCost: measured ?? Math.ceil(chars / 4),
    tokenCostSource: measured === undefined ? 'estimated' : 'measured',
    durationMs: Math.max(0, Math.round(durationMs)),
  }
}

function lastAssistantText(agent: Agent): string {
  const messages = agent.session.deriveMessages()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.role !== 'assistant') continue
    const parts: string[] = []
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text)
    }
    if (parts.length > 0) return parts.join('\n')
  }
  return ''
}

interface MessageShape {
  readonly id: MessageId
  readonly role: 'user'
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly source: { readonly kind: 'user' }
}

function childUserMessage(text: string): MessageShape {
  return {
    id: randomUUID() as unknown as MessageId,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

export async function waitForIdle(agent: Agent, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    const outcome = await Promise.race([agent.whenIdle().then(() => 'idle' as const), timedOut])
    if (outcome === 'timeout') {
      agent.cancel({ kind: 'hook', reason: 'harness2-probe-timeout' })
      await agent.whenIdle().catch(() => undefined)
      return false
    }
    return true
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/* -------------------------------------------------------------------------- */
/* Runtime                                                                    */
/* -------------------------------------------------------------------------- */

type PluginLogger = ReturnType<Context['logger']>

export interface TaskRuntime {
  readonly ctx: Context
  readonly config: Config
  readonly ledger: Ledger
  readonly states: WeakMap<Agent, SessionFailureState>
  readonly log: PluginLogger
  readonly pendingPatch: { value: PendingPatch | undefined }
  readonly lastLedgerId: { value: string | null }
  readonly appliedComponents: Set<string>
  readonly applyMode: Promise<ApplyMode>
  experience: Harness2ExperienceFacade | undefined
}

/** Report a structured plugin error (`onError(<code>)` in the log). */
function reportError(runtime: TaskRuntime, code: string, details?: unknown): void {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`
  runtime.log.warn(`harness2-task-recursion: onError(${code})${suffix}`)
}

function stateOf(runtime: TaskRuntime, agent: Agent): SessionFailureState {
  const existing = runtime.states.get(agent)
  if (existing !== undefined) return existing
  const created = createFailureState()
  runtime.states.set(agent, created)
  return created
}

function isProbeChildAgent(agent: Agent): boolean {
  return agent.session.header.origin === 'subagent'
}

async function createProbeChild(runtime: TaskRuntime, parent: Agent): Promise<AgentHandle> {
  const header = parent.session.header
  return runtime.ctx.agents.create({
    sessionId: randomUUID() as unknown as SessionId,
    parentAgent: parent,
    meta: {
      parentSession: header.id,
      isSeeded: false,
      origin: 'subagent',
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      delegationDepth: (header.delegationDepth ?? 0) + 1,
      ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
    },
    agentOptions: { ...parent.options },
    // TODO(ROUND2_SANDBOX): restrict the child's tools / sandbox here once the
    // dsh runtime exposes the tool-restriction API for child agents.
  })
}

async function runTrial(
  runtime: TaskRuntime,
  parent: Agent,
  input: {
    readonly taskId: string
    readonly cycleId: string
    readonly candidate: HarnessCandidate
    readonly baseline: ProbeMetrics
    readonly trajectorySummary: string
  },
): Promise<{ trial: TrialRecord; tokenCost: number }> {
  const baseTrial = {
    candidateId: input.candidate.candidateId,
    candidateType: input.candidate.candidateType,
    component: input.candidate.edit.component,
    operation: input.candidate.edit.operation,
    editContentHash: input.candidate.edit.contentHash,
  }
  const prompt = buildProbePrompt({
    taskId: input.taskId,
    cycleId: input.cycleId,
    candidate: input.candidate,
    baseline: input.baseline,
    replayScope: runtime.config.replayScope,
    trajectorySummary: input.trajectorySummary,
  })
  const v4 = runtime.config.gatePolicy === 'v4'
  const admissibility = checkAdmissibility(
    input.candidate.edit.component,
    input.candidate.edit.operation,
    input.candidate.edit.content,
  )
  // v4 fail-closed: only simulable persona edits may be measured inside the
  // advisory probe; everything else is queued for the offline applier later.
  if (v4 && (!admissibility.ok || !isSimulableInProbe(admissibility.spec!))) {
    return {
      trial: {
        ...baseTrial,
        applicability: 'unavailable',
        valid: false,
        error: 'edit-not-in-effect',
      },
      tokenCost: estimateTokens(prompt),
    }
  }

  let child: AgentHandle | undefined
  let disposeSection: (() => void) | undefined
  const startedAt = performance.now()
  try {
    child = await createProbeChild(runtime, parent)
    if (v4 && admissibility.ok) {
      const agentContext = (child.agent as unknown as {
        ctx?: { get?: (name: string) => unknown }
      }).ctx
      const systemPrompt = agentContext?.get?.('systemPrompt') as
        | { section?: (section: { name: string; order: number; text: string }) => unknown }
        | undefined
      if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
        return {
          trial: {
            ...baseTrial,
            applicability: 'unavailable',
            valid: false,
            error: 'edit-not-in-effect',
          },
          tokenCost: estimateTokens(prompt),
        }
      }
      const disposable = systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: 0,
        text: admissibility.spec!.content,
      })
      if (typeof disposable === 'function') disposeSection = disposable as () => void
    }
    child.agent.followup(childUserMessage(prompt))
    const idle = await waitForIdle(child.agent, runtime.config.probeTimeoutMs)
    const durationMs = performance.now() - startedAt
    if (!idle) {
      return {
        trial: {
          ...baseTrial,
          ...(v4 ? { applicability: 'applied' as const } : {}),
          valid: false,
          error: `timeout after ${runtime.config.probeTimeoutMs}ms`,
        },
        tokenCost: estimateTokens(prompt),
      }
    }
    const metrics = metricsFromTranscript(
      runtime.ctx,
      child.agent,
      child.agent.session.deriveMessages(),
      durationMs,
      prompt,
    )
    if (v4 && metrics.stepCount === 0) {
      return {
        trial: { ...baseTrial, applicability: 'applied', valid: false, error: 'empty-transcript' },
        tokenCost: metrics.tokenCost,
      }
    }
    const assistantText = lastAssistantText(child.agent)
    return {
      trial: {
        ...baseTrial,
        ...(v4 ? { applicability: 'applied' as const } : {}),
        valid: true,
        metrics,
      },
      tokenCost: metrics.tokenCost + estimateTokens(assistantText),
    }
  } catch (error) {
    return {
      trial: {
        ...baseTrial,
        ...(v4 ? { applicability: 'unavailable' as const } : {}),
        valid: false,
        error: (error instanceof Error ? error.message : String(error)).slice(0, MAX_TRIAL_ERROR),
      },
      tokenCost: estimateTokens(prompt),
    }
  } finally {
    if (disposeSection !== undefined) {
      try { disposeSection() } catch { /* effect disposal must not mask the trial */ }
    }
    if (child !== undefined) await child.dispose().catch(() => undefined)
  }
}

/** One no-edit recovery-control trial. */
async function runControlTrial(
  runtime: TaskRuntime,
  parent: Agent,
  input: {
    readonly taskId: string
    readonly cycleId: string
    readonly baseline: ProbeMetrics
    readonly trajectorySummary: string
  },
): Promise<{ metrics?: ProbeMetrics; tokenCost: number }> {
  const prompt = buildControlPrompt({
    taskId: input.taskId,
    cycleId: input.cycleId,
    baseline: input.baseline,
    replayScope: runtime.config.replayScope,
    trajectorySummary: input.trajectorySummary,
  })
  let child: AgentHandle | undefined
  const startedAt = performance.now()
  try {
    child = await createProbeChild(runtime, parent)
    child.agent.followup(childUserMessage(prompt))
    const idle = await waitForIdle(child.agent, runtime.config.probeTimeoutMs)
    const durationMs = performance.now() - startedAt
    if (!idle) return { tokenCost: estimateTokens(prompt) }
    const metrics = metricsFromTranscript(
      runtime.ctx,
      child.agent,
      child.agent.session.deriveMessages(),
      durationMs,
      prompt,
    )
    if (metrics.stepCount === 0 || !metrics.completion) {
      return { tokenCost: metrics.tokenCost }
    }
    return {
      metrics,
      tokenCost: metrics.tokenCost + estimateTokens(lastAssistantText(child.agent)),
    }
  } catch {
    return { tokenCost: estimateTokens(prompt) }
  } finally {
    if (child !== undefined) await child.dispose().catch(() => undefined)
  }
}

async function probeCandidates(
  runtime: TaskRuntime,
  parent: Agent,
  input: {
    readonly taskId: string
    readonly cycleId: string
    readonly candidates: readonly HarnessCandidate[]
    readonly baseline: ProbeMetrics
    readonly trajectorySummary: string
    readonly spentTokens: number
  },
): Promise<ProbeOutcome> {
  const trials: TrialRecord[] = []
  const controlMetrics: ProbeMetrics[] = []
  let tokenCost = 0
  const v4 = runtime.config.gatePolicy === 'v4'
  const controlReplicates = v4
    ? Math.max(2, Math.min(4, Math.floor(runtime.config.controlReplicates)))
    : 0

  const runControl = async (): Promise<void> => {
    const result = await runControlTrial(runtime, parent, input)
    tokenCost += result.tokenCost
    if (result.metrics !== undefined) controlMetrics.push(result.metrics)
  }

  // Design order: C1, T1, T2, C2. The first control is always attempted; the
  // gate fails closed if fewer than two valid controls exist.
  if (controlReplicates > 0) await runControl()

  for (const candidate of input.candidates) {
    // Always run the first trial so probe/completed stays schema-valid; the
    // compose gate then rejects on cost.
    if (trials.length > 0 && input.spentTokens + tokenCost >= runtime.config.maxCostPerCycle) break
    const result = await runTrial(runtime, parent, { ...input, candidate })
    trials.push(result.trial)
    tokenCost += result.tokenCost
  }

  for (let index = 1; index < controlReplicates; index += 1) {
    await runControl()
  }

  return { trials, controlMetrics, tokenCost }
}

/* -------------------------------------------------------------------------- */
/* LLM helpers                                                                */
/* -------------------------------------------------------------------------- */

interface LlmTextResult {
  readonly text: string
  readonly usageTokens?: number
}

async function collectLlmText(
  ctx: Context,
  route: ModelRoute,
  system: string,
  user: string,
  maxTokens: number,
  timeoutMs: number,
): Promise<LlmTextResult> {
  let text = ''
  let usageTokens: number | undefined
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    maxTokens,
    signal: AbortSignal.timeout(timeoutMs),
  })
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'usage') {
      const usage = chunk.usage
      const total = typeof usage.totalTokens === 'number'
        ? usage.totalTokens
        : usage.inputTokens + usage.outputTokens
      usageTokens = (usageTokens ?? 0) + total
    } else if (chunk.type === 'finish' && chunk.reason.kind === 'error') break
  }
  return { text, ...(usageTokens === undefined ? {} : { usageTokens }) }
}

async function proposeOnce(
  runtime: TaskRuntime,
  input: {
    readonly taskId: string
    readonly trigger: ProbeTrigger
    readonly state: SessionFailureState
    readonly baseline: ProbeMetrics
    readonly priors: readonly ExperienceEntry[]
  },
): Promise<ProposalResult> {
  const route = resolveModelRoute(runtime.ctx, runtime.config.proposeModel)
  if (route === undefined) throw new ProposalError('no proposal model route')
  const prompt = buildProposePrompt({
    taskId: input.taskId,
    trigger: input.trigger,
    state: input.state,
    baseline: input.baseline,
    config: runtime.config,
    priors: input.priors,
    harnessSnapshot: {
      components: COMPONENT_NAMES,
      replayScope: runtime.config.replayScope,
      proposeModel: runtime.config.proposeModel,
    },
  })
  const result = await collectLlmText(runtime.ctx, route, PROPOSE_SYSTEM, prompt, 4096, 120000)
  const candidates = parseProposal(result.text)
  const measured = result.usageTokens !== undefined
  return {
    candidates,
    tokenCost: result.usageTokens ?? estimateTokens(prompt + result.text),
    tokenCostSource: measured ? 'measured' : 'estimated',
  }
}

/* -------------------------------------------------------------------------- */
/* Ledger append + emit (v3)                                                  */
/* -------------------------------------------------------------------------- */

async function ledgerThenEmit<T>(
  runtime: TaskRuntime,
  event: LedgerEnvelopeV3['event'],
  buildPayload: (ids: {
    readonly id: string
    readonly previousSnapshotRef: string | null
    readonly recordedAt: string
  }) => T,
  validator: (value: unknown) => string[],
  emit: (payload: T) => void,
): Promise<boolean> {
  const id = `led-${randomUUID().slice(0, 8)}`
  const previousSnapshotRef = runtime.lastLedgerId.value
  const recordedAt = new Date().toISOString()
  const payload = buildPayload({ id, previousSnapshotRef, recordedAt })
  const errors = assertJsonSafePayload(validator, payload)
  if (errors.length > 0) {
    reportError(runtime, 'payload-schema-invalid', errors)
    return false
  }
  const envelope: LedgerEnvelopeV3 = {
    version: LEDGER_VERSION,
    id,
    previousSnapshotRef,
    ledgerEntryId: id,
    event,
    payload: payload as LedgerPayload,
    recordedAt,
  }
  try {
    await runtime.ledger.append(envelope)
  } catch (error) {
    reportError(runtime, 'ledger-append-failed', {
      event,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
  runtime.lastLedgerId.value = id
  emit(payload)
  return true
}

/* -------------------------------------------------------------------------- */
/* Cycle orchestration                                                        */
/* -------------------------------------------------------------------------- */

interface ProbeTarget {
  readonly agent: Agent
  readonly trigger: ProbeTrigger
  readonly taskId: string
  readonly baseline: ProbeMetrics
  readonly trajectorySummary: string
  readonly priors: readonly ExperienceEntry[]
}

function queryPriorsSafe(runtime: TaskRuntime, state: SessionFailureState): readonly ExperienceEntry[] {
  const facade = runtime.experience
  if (facade === undefined || facade.ready !== true) return []
  try {
    const query = buildPriorsQuery(state, runtime.config, [...runtime.appliedComponents])
    return facade.queryPriors(query).priors
  } catch (error) {
    reportError(runtime, 'priors-query-failed', { error: String(error) })
    return []
  }
}

function attachExperienceFacade(runtime: TaskRuntime): void {
  runtime.ctx.inject(['harness2Experience'], (scopedCtx) => {
    runtime.experience = scopedCtx.harness2Experience
    scopedCtx.effect(() => () => {
      runtime.experience = undefined
    })
  })
}

/** Build the applied payload's `appliedEdits` from the in-memory candidates. */
export function buildAppliedEdits(candidates: readonly HarnessCandidate[]): AppliedEdit[] {
  return candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    contentHash: candidate.edit.contentHash,
    component: candidate.edit.component,
    operation: candidate.edit.operation,
  }))
}

/** Classify one failed Propose attempt into the frozen reason union (R4-1). */
export function classifyProposalFailure(error: unknown): {
  readonly reason: ProposeFailedReason
  readonly message: string
} {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof ProposalError) {
    if (message.includes('unknown component')) return { reason: 'component-invalid', message }
    if (message.includes('contentHash')) return { reason: 'hash-mismatch', message }
    return { reason: 'schema-invalid', message }
  }
  return { reason: 'llm-error', message }
}

/** Sanitize the human-readable last Propose error (≤300, escaped, one line). */
export function sanitizeProposalError(message: string): string {
  return message
    .replace(/[\r\n]+/g, ' ')
    .replace(/</g, '&lt;')
    .trim()
    .slice(0, 300)
}

async function runComposeDecision(
  runtime: TaskRuntime,
  input: {
    readonly probe: ProbeCompletedPayload
    readonly candidates: readonly HarnessCandidate[]
    readonly cycleTokenCost: number
  },
): Promise<void> {
  const decision = decideCompose({
    probe: input.probe,
    candidates: input.candidates,
    cycleTokenCost: input.cycleTokenCost,
    config: runtime.config,
  })

  if (decision.kind === 'reject') {
    const rejectedIds = decision.rejectedCandidateIds
    if (rejectedIds.length === 0) {
      reportError(runtime, 'rejected-candidates-empty', { reason: decision.reason })
      return
    }
    await ledgerThenEmit(
      runtime,
      'compose/rejected',
      () => ({
        taskId: input.probe.taskId,
        cycleId: input.probe.cycleId,
        reason: decision.reason,
        rejectedCandidateIds: rejectedIds,
        baselineMetrics: input.probe.baselineMetrics,
        trials: input.probe.trials,
        ...(decision.gate === undefined ? {} : { gate: decision.gate }),
      }),
      validateComposeRejectedPayload,
      (payload) => runtime.ctx.emit('compose/rejected', payload),
    )
    return
  }

  const applyMode = await runtime.applyMode
  const appliedEdits = buildAppliedEdits(decision.candidates)
  const appliedComponents = decision.appliedComponents
  const applied = await ledgerThenEmit(
    runtime,
    'compose/applied',
    ({ id, previousSnapshotRef }) => ({
      taskId: input.probe.taskId,
      cycleId: input.probe.cycleId,
      appliedCandidateIds: decision.appliedCandidateIds,
      appliedEdits,
      appliedComponents,
      previousSnapshotRef: previousSnapshotRef ?? 'none',
      ledgerEntryId: id,
      applyMode,
      ...(decision.gate === undefined ? {} : { gate: decision.gate }),
    }),
    validateComposeAppliedPayload,
    (payload) => runtime.ctx.emit('compose/applied', payload),
  )
  if (!applied) return
  if (applyMode === 'pre-step-patch') {
    runtime.pendingPatch.value = {
      components: appliedComponents,
      edits: decision.candidates.map((candidate) => candidate.edit),
    }
  }
  for (const component of appliedComponents) runtime.appliedComponents.add(component)
}

async function runCycle(runtime: TaskRuntime, target: ProbeTarget): Promise<void> {
  const { ctx } = runtime
  const cycleId = randomUUID()
  const state = stateOf(runtime, target.agent)
  const baseline = target.baseline
  const trajectorySummary = target.trajectorySummary
  const priors = target.priors

  let candidates: readonly HarnessCandidate[] = []
  let spentTokens = 0
  try {
    let proposal: ProposalResult | undefined
    let lastFailure: { readonly reason: ProposeFailedReason; readonly message: string } | undefined
    let attempts = 0
    for (let attempt = 0; attempt < 2 && proposal === undefined; attempt += 1) {
      attempts += 1
      try {
        proposal = await proposeOnce(runtime, {
          taskId: target.taskId,
          trigger: target.trigger,
          state,
          baseline,
          priors,
        })
      } catch (error) {
        lastFailure = classifyProposalFailure(error)
        reportError(runtime, `propose-attempt-${attempt + 1}-failed`, {
          reason: lastFailure.reason,
          error: lastFailure.message,
        })
      }
    }
    if (proposal === undefined) {
      // R4-1: Propose is a terminal state of this cycle. No Probe/Compose events
      // and no empty-id compose/rejected are emitted for the same cycleId.
      const emitted = await ledgerThenEmit(
        runtime,
        'propose/failed',
        ({ recordedAt }) => ({
          taskId: target.taskId,
          cycleId,
          reason: lastFailure?.reason ?? 'llm-error',
          attempts,
          ...(lastFailure === undefined
            ? {}
            : { lastError: sanitizeProposalError(lastFailure.message) }),
          baselineMetrics: baseline,
          recordedAt,
        }),
        validateProposeFailedPayload,
        (payload) => ctx.emit('propose/failed', payload),
      )
      void emitted
      return
    }
    candidates = proposal.candidates
    spentTokens += proposal.tokenCost

    const outcome = await probeCandidates(runtime, target.agent, {
      taskId: target.taskId,
      cycleId,
      candidates,
      baseline,
      trajectorySummary,
      spentTokens,
    })
    spentTokens += outcome.tokenCost

    const probePayload: ProbeCompletedPayload = {
      taskId: target.taskId,
      baselineMetrics: baseline,
      trials: outcome.trials,
      evidenceSummary: trajectorySummary,
      cycleId,
      ...(outcome.controlMetrics.length > 0 ? { controlMetrics: outcome.controlMetrics } : {}),
    }
    // Q1: never emit a trial with incomplete candidate metadata.
    if (probePayload.trials.some((trial) => !trialMetadataComplete(trial))) {
      reportError(runtime, 'trial-metadata-incomplete', {
        cycleId,
        candidateIds: probePayload.trials.map((trial) => trial.candidateId),
      })
      return
    }
    const emitted = await ledgerThenEmit(
      runtime,
      'probe/completed',
      () => probePayload,
      validateProbeCompletedPayload,
      (payload) => ctx.emit('probe/completed', payload),
    )
    if (!emitted) return

    await runComposeDecision(runtime, {
      probe: probePayload,
      candidates,
      cycleTokenCost: spentTokens,
    })
  } catch (error) {
    reportError(runtime, 'cycle-failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    state.probeInFlight = false
  }
}

/** Schedule one cycle when a trigger is due; synchronous and non-blocking. */
export function scheduleProbeIfDue(
  runtime: TaskRuntime,
  agent: Agent,
  now = Date.now(),
): boolean {
  if (isProbeChildAgent(agent)) return false
  const state = stateOf(runtime, agent)
  const decision = selectTrigger(state, runtime.config, now)
  if (decision === undefined) return false
  const target: ProbeTarget = {
    agent,
    trigger: decision.trigger,
    taskId: String(agent.session.header.id),
    baseline: baselineMetricsOf(runtime.ctx, agent, state, decision.trigger, now),
    trajectorySummary: buildEvidenceSummary(state, decision.trigger),
    priors: queryPriorsSafe(runtime, state),
  }
  state.lastTriggerAt = now
  state.probeInFlight = true
  state.requestErrors = 0
  state.toolFailureStreak = 0
  state.failedTool = undefined
  state.firstFailureAt = 0
  void runCycle(runtime, target).catch((error: unknown) => {
    stateOf(runtime, agent).probeInFlight = false
    reportError(runtime, 'cycle-dispatch-failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  })
  return true
}

/* -------------------------------------------------------------------------- */
/* Plugin entry                                                               */
/* -------------------------------------------------------------------------- */

export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger(name)
  const runtime: TaskRuntime = {
    ctx,
    config,
    ledger: createLedger(config.ledgerPath, {
      onError: (error) => {
        log.warn(
          `harness2-task-recursion: onError(ledger-sink) ${error instanceof Error ? error.message : String(error)}`,
        )
      },
    }),
    states: new WeakMap(),
    log,
    pendingPatch: { value: undefined },
    lastLedgerId: { value: null },
    appliedComponents: new Set(),
    // Detected exactly once at activation and cached; never re-probed per step.
    applyMode: detectApplyMode(ctx, config).catch(() => 'noop-todo' as const),
    experience: undefined,
  }

  void readLedgerTail(config.ledgerPath)
    .then((tail) => {
      runtime.lastLedgerId.value = tail.id ?? null
    })
    .catch((error: unknown) => reportError(runtime, 'ledger-tail-failed', { error: String(error) }))
  void resolveModelRoute(ctx, config.proposeModel)

  attachExperienceFacade(runtime)

  ctx.on('tools/result', (exec, result) => {
    try {
      const agent = exec.agent
      if (agent === undefined || isProbeChildAgent(agent)) return
      const state = stateOf(runtime, agent)
      noteToolResult(
        state,
        {
          toolName: exec.name,
          failed: result.isError,
          message: result.isError ? result.error.message : '',
          errorCode: result.isError ? errorCodeOf(result.error) : undefined,
          at: Date.now(),
          step: state.lastStep,
        },
        config.trajectoryWindow,
      )
    } catch (error) {
      reportError(runtime, 'tools-result-observer-failed', { error: String(error) })
    }
  })

  ctx.on('agent/request-error', async (payload, next) => {
    try {
      if (!isProbeChildAgent(payload.agent)) {
        const state = stateOf(runtime, payload.agent)
        noteRequestError(
          state,
          {
            at: Date.now(),
            step: payload.step,
            message: payload.failure.message,
            errorCode: errorCodeOf(payload.failure),
          },
          config.trajectoryWindow,
        )
        scheduleProbeIfDue(runtime, payload.agent)
      }
    } catch (error) {
      reportError(runtime, 'request-error-observer-failed', { error: String(error) })
    }
    return next()
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const state = stateOf(runtime, payload.agent)
      state.lastStep = Math.max(state.lastStep, payload.step)
      if (!isProbeChildAgent(payload.agent)) {
        const pending = runtime.pendingPatch.value
        runtime.pendingPatch.value = undefined
        if (pending !== undefined) {
          applyPendingPatch(ctx, pending, (message, error) => {
            reportError(runtime, message, error)
          })
        }
        scheduleProbeIfDue(runtime, payload.agent)
      }
    } catch (error) {
      reportError(runtime, 'pre-step-failed', { error: String(error) })
    }
    return next()
  })
}
