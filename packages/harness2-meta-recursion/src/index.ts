/**
 * harness2-meta-recursion — harnessing-level recursion (round 4).
 *
 * Round-3 revisions (frozen):
 *   - attribution `edit` fields come from task facts (`appliedEdits` / `trials`)
 *     and are NEVER taken from the reflection model; the reflection output must
 *     name a `candidateId` and match the source component/operation/contentHash
 *     exactly, otherwise the entry is rejected with
 *     `onError('reflection-edit-mismatch', …)`;
 *   - confidence uses the frozen v3 formula (source penalty when
 *     `tokenCostSource === 'estimated'`, `trials === 0 → 0`);
 *   - `trials === 0` entries are refused before any write;
 *   - `queryPriors` applies per-adoption thresholds
 *     (`minConfidenceToInject` for positive, `minNegativeConfidenceToInject`
 *     for negative; no cross-application);
 *   - legacy round-2 component names are migrated on load with a
 *     `migratedFrom` audit field; unknown component names are skipped with
 *     `onError('unknown-component')`;
 *   - the `workflow-control` fallback is removed entirely.
 *
 * @module harness2-meta-recursion
 */

import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import Schema from '@deepseek-ai/schemastery'

import type { Context } from '@deepseek-ai/cordis'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'

import {
  COMPONENT_NAMES,
  LEGACY_COMPONENT_MIGRATION,
  isComponentName,
} from './constants.ts'

export { COMPONENT_NAMES, LEGACY_COMPONENT_MIGRATION, isComponentName }
export type { ComponentName } from './constants.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'harness2-meta-recursion'

/** Static service dependency (frozen since round 1). */
export const inject = ['llm']

/** Schemastery config schema; every default is inline and validated on load. */
export const Config = Schema.object({
  experiencePath: Schema.string().default('./EXPERIENCE.md'),
  maxExperienceEntries: Schema.number().default(200),
  topKInjection: Schema.number().default(5),
  /** Injection threshold for positive entries only. */
  minConfidenceToInject: Schema.number().default(0.4),
  /** Injection threshold for negative entries only (round-3 Q6). */
  minNegativeConfidenceToInject: Schema.number().default(0.3),
  enableNegativeExperience: Schema.boolean().default(true),
  llmReflectionModel: Schema.string().default(''),
  /** PR-5: verified-evaluation index (empty derives <ledger dir>/eval/index.jsonl). */
  evaluationsPath: Schema.string().default(''),
  /** PR-5: ledger used for provenance (kept for compatibility/diagnostics). */
  ledgerPath: Schema.string().default('./harness2-ledger.jsonl'),
  /** PR-5: offline applier active state (empty derives <DSH_HOME>/apply/active.json). */
  applyStatePath: Schema.string().default(''),
  /** PR-5: legacy entries without `verification` are quarantined by default. */
  enableLegacyExperience: Schema.boolean().default(false),
})

/** Resolved config type, identical to the schema output. */
export type Config = Schemastery.TypeT<typeof Config>

/* -------------------------------------------------------------------------- */
/* Frozen cross-plugin contract                                               */
/* -------------------------------------------------------------------------- */

/** How `tokenCost` was obtained (round-3 Q4). */
export type TokenCostSource = 'measured' | 'estimated'

export interface ProbeMetrics {
  readonly completion: boolean
  readonly toolFailures: number
  readonly stepCount: number
  readonly tokenCost: number
  readonly tokenCostSource: TokenCostSource
  readonly durationMs: number
}

/** One probed candidate; candidate metadata is required on every trial. */
export interface TrialRecord {
  readonly candidateId: string
  readonly candidateType: 'invariant' | 'domain'
  readonly component: string
  readonly operation: string
  readonly editContentHash: string
  readonly valid: boolean
  readonly metrics?: ProbeMetrics
  readonly error?: string
  /** Round-6 optional: whether the edit was in effect for this trial. */
  readonly applicability?: 'applied' | 'unavailable'
}

export interface ProbeCompletedPayload {
  readonly taskId: string
  readonly baselineMetrics: ProbeMetrics
  readonly trials: readonly TrialRecord[]
  readonly evidenceSummary: string
  readonly cycleId: string
  /** Round-6 optional recovery-control metrics (meta does not consume them yet). */
  readonly controlMetrics?: readonly ProbeMetrics[]
  /** Round-6 per-candidate matched controls (meta does not consume them yet). */
  readonly controlAssignments?: readonly {
    readonly candidateId: string
    readonly metrics: readonly ProbeMetrics[]
  }[]
}

export type ApplyMode = 'pre-step-patch' | 'next-task-ledger' | 'noop-todo'

/** One applied edit (round-3 R3-1). */
export interface AppliedEdit {
  readonly candidateId: string
  readonly contentHash: string
  readonly component: string
  readonly operation: string
}

export interface ComposeAppliedPayload {
  readonly taskId: string
  readonly cycleId: string
  readonly appliedCandidateIds: readonly string[]
  readonly appliedEdits: readonly AppliedEdit[]
  readonly appliedComponents: readonly string[]
  readonly previousSnapshotRef: string
  readonly ledgerEntryId: string
  readonly applyMode: ApplyMode
  /** Round-6 optional Gate-v4 receipt (meta does not consume it in PR-1). */
  readonly gate?: Readonly<Record<string, unknown>>
}

export type ComposeRejectedReason =
  | 'low-evidence'
  | 'observe-only'
  | 'cost-limit'
  | 'compose-not-wired'
  | 'regression'

export interface ComposeRejectedPayload {
  readonly taskId: string
  readonly cycleId: string
  readonly reason: ComposeRejectedReason
  readonly rejectedCandidateIds: readonly string[]
  readonly baselineMetrics: ProbeMetrics
  readonly trials: readonly TrialRecord[]
  /** Round-6 optional Gate-v4 receipt (meta does not consume it in PR-1). */
  readonly gate?: Readonly<Record<string, unknown>>
}

/** Round-4 terminal state emitted by the task plugin (R4-1). */
export type ProposeFailedReason =
  | 'llm-error'
  | 'schema-invalid'
  | 'hash-mismatch'
  | 'component-invalid'

export interface ProposeFailedPayload {
  readonly taskId: string
  readonly cycleId: string
  readonly reason: ProposeFailedReason
  readonly attempts: number
  readonly lastError?: string
  readonly baselineMetrics?: ProbeMetrics
  readonly recordedAt: string
}

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

/**
 * One experience entry, field-for-field with `EXPERIENCE.md`.
 *
 * Round-3 additions:
 * - `outcome.tokenCostSource` is required so confidence can be re-derived on
 *   load with the Q4 penalty (`measured` vs `estimated`);
 * - `migratedFrom` is an optional audit field for legacy component names.
 */
export interface ExperienceVerification {
  readonly schema: 'harness2-verification/v1'
  readonly reportHash: string
  readonly batchId: string
  readonly revisionId: string
  readonly profile: string
  readonly providerClass: 'real'
  readonly verdict: 'accept' | 'reject'
  readonly b: number
  readonly c: number
  readonly N: number
  readonly delta: number
  readonly p: number
  readonly tokenCostSource: 'measured' | 'estimated'
  /** True when the original composed source could not be recovered. */
  readonly sourceMissing?: boolean
}

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
    readonly tokenCostSource: TokenCostSource
  }
  readonly confidence: number
  /** Present only when a legacy component name was migrated on load. */
  readonly migratedFrom?: string
  /** PR-5: only real-provider verified evaluations create/qualify entries. */
  readonly verification?: ExperienceVerification
}

export interface PriorsResult {
  readonly priors: readonly ExperienceEntry[]
  readonly totalMatched: number
}

export interface Harness2ExperienceFacade {
  readonly ready: boolean
  queryPriors(query: PriorsQuery): PriorsResult
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'probe/completed'(payload: ProbeCompletedPayload): void
    'compose/applied'(payload: ComposeAppliedPayload): void
    'compose/rejected'(payload: ComposeRejectedPayload): void
    'propose/failed'(payload: ProposeFailedPayload): void
  }

  interface Context {
    harness2Experience?: Harness2ExperienceFacade
  }
}

/** Only `regression` produces negative experience (frozen since round 2). */
export const NEGATIVE_EXPERIENCE_REASONS: readonly ComposeRejectedReason[] = [
  'regression',
]

/* -------------------------------------------------------------------------- */
/* Storage path                                                               */
/* -------------------------------------------------------------------------- */

export function resolveStoragePath(configuredPath: string): string {
  const value = configuredPath.trim()
  if (path.isAbsolute(value)) return value
  const home = process.env.DSH_HOME?.trim()
  const base = home !== undefined && home.length > 0 ? path.join(home, 'harness2') : process.cwd()
  return path.resolve(base, value.length > 0 ? value : 'EXPERIENCE.md')
}

export function resolveEvaluationsPath(configuredPath: string, ledgerPath: string): string {
  const value = configuredPath.trim()
  if (value.length > 0) return resolveStoragePath(value)
  return path.join(path.dirname(resolveStoragePath(ledgerPath)), 'eval', 'index.jsonl')
}

export function resolveApplyStatePath(configuredPath: string): string {
  const value = configuredPath.trim()
  if (value.length > 0) return resolveStoragePath(value)
  const home = process.env.DSH_HOME?.trim()
  return path.resolve(home !== undefined && home.length > 0 ? home : process.cwd(), 'apply', 'active.json')
}

/* -------------------------------------------------------------------------- */
/* Confidence (frozen v3 formula)                                             */
/* -------------------------------------------------------------------------- */

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * Frozen round-3 confidence formula:
 *
 * `clamp01(baseByAdoption × evidenceFactor × repeatFactor × sourcePenalty)`
 * - `trials === 0` → 0 (defensive; such entries are never written);
 * - base: accepted 0.6 / rejected 0.5;
 * - evidenceFactor: `0.5 + 0.5 * min(1, trials / 3)`;
 * - repeatFactor: `1 + 0.1 * min(4, samePatternCount)`;
 * - sourcePenalty: `estimated → 0.9`, `measured → 1`.
 */
export function scoreConfidence(
  trials: number,
  adoption: 'accepted' | 'rejected',
  tokenCostSource: TokenCostSource,
  samePatternCount: number,
): number {
  if (!Number.isFinite(trials) || trials <= 0) return 0
  const baseByAdoption = adoption === 'accepted' ? 0.6 : 0.5
  const evidenceFactor = 0.5 + 0.5 * Math.min(1, trials / 3)
  const repeatFactor = 1 + 0.1 * Math.min(4, Math.max(0, samePatternCount))
  const sourcePenalty = tokenCostSource === 'estimated' ? 0.9 : 1.0
  return round3(clamp01(baseByAdoption * evidenceFactor * repeatFactor * sourcePenalty))
}

/* -------------------------------------------------------------------------- */
/* Normalization, matching, migration                                         */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Lightweight report hash verification (full stats are rechecked by the eval/applier tools). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

function evaluationReportHash(report: Record<string, unknown>): string {
  const { reportHash: _ignored, ...rest } = report
  return `sha256:${createHash('sha256').update(stableStringify(rest), 'utf8').digest('hex')}`
}

/** Collapse control characters/whitespace and cap a failure pattern. */
export function normalizeFailurePattern(text: string): string {
  const collapsed = text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return collapsed.length === 0 ? 'unknown-failure' : collapsed
}

/** Whether a query signature matches one entry (any populated field hits). */
export function matchesSignature(
  entry: ExperienceEntry,
  signature: PriorsQuery['failureSignature'],
): boolean {
  let populated = 0
  let hit = false
  const toolName = signature.toolName?.trim()
  if (toolName !== undefined && toolName.length > 0) {
    populated += 1
    hit = hit || entry.condition.failurePattern.includes(toolName)
  }
  const errorCode = signature.errorCode?.trim()
  if (errorCode !== undefined && errorCode.length > 0) {
    populated += 1
    hit = hit || entry.condition.failurePattern.includes(errorCode)
  }
  const messagePattern = signature.messagePattern?.trim()
  if (messagePattern !== undefined && messagePattern.length > 0) {
    populated += 1
    hit = hit || entry.condition.failurePattern.includes(messagePattern)
  }
  const taskDomain = signature.taskDomain?.trim()
  if (taskDomain !== undefined && taskDomain.length > 0) {
    populated += 1
    hit = hit || entry.condition.taskDomain === taskDomain
  }
  return populated > 0 && hit
}

/**
 * Resolve a stored component name, migrating legacy round-2 names.
 *
 * @returns the frozen name plus the optional audit field, or `undefined` for an
 * unknown name (caller reports `onError('unknown-component')`).
 */
export function migrateComponentName(
  component: unknown,
  existingMigratedFrom?: unknown,
): { readonly component: string; readonly migratedFrom?: string } | undefined {
  const audit = typeof existingMigratedFrom === 'string' && existingMigratedFrom.length > 0
    ? existingMigratedFrom.slice(0, 80)
    : undefined
  if (isComponentName(component)) {
    return { component, ...(audit === undefined ? {} : { migratedFrom: audit }) }
  }
  if (typeof component === 'string' && component in LEGACY_COMPONENT_MIGRATION) {
    return {
      component: LEGACY_COMPONENT_MIGRATION[component]!,
      migratedFrom: audit ?? component,
    }
  }
  return undefined
}

/* -------------------------------------------------------------------------- */
/* Entry sanitization, serialization, eviction                                */
/* -------------------------------------------------------------------------- */

export const EXPERIENCE_MARKER = 'harness2-experience'
export const MAX_OBSERVED_IN = 5
const MAX_TEXT_LENGTH = 2000

function sanitizeText(value: unknown, fallback: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0) return fallback
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, maxLength)
}

function sanitizeMetricDelta(value: unknown): Record<string, number> {
  const result: Record<string, number> = {}
  if (!isRecord(value)) return result
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
    const safeKey = key.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40)
    if (safeKey.length === 0) continue
    result[safeKey] = Math.max(-1e9, Math.min(1e9, raw))
  }
  return result
}

/** One skipped entry plus its structured error code. */
export interface ExperienceSkip {
  readonly code: 'unknown-component' | 'invalid-entry'
  readonly details: Readonly<Record<string, unknown>>
}

/**
 * Validate and **re-derive** one persisted entry.
 *
 * A persisted file is untrusted: component names are migrated, ranges are
 * clamped, `observedIn` keeps the 5 most recent ids, and confidence is
 * recomputed with the frozen v3 formula.
 */
function sanitizeVerification(value: unknown): ExperienceVerification | undefined {
  if (!isRecord(value)) return undefined
  if (value.schema !== 'harness2-verification/v1') return undefined
  if (typeof value.reportHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.reportHash)) return undefined
  if (typeof value.batchId !== 'string' || value.batchId.length === 0) return undefined
  if (typeof value.revisionId !== 'string' || value.revisionId.length === 0) return undefined
  if (typeof value.profile !== 'string' || value.profile.length === 0) return undefined
  if (value.providerClass !== 'real') return undefined
  if (value.verdict !== 'accept' && value.verdict !== 'reject') return undefined
  const numeric: Record<string, number> = {}
  for (const key of ['b', 'c', 'N', 'delta', 'p']) {
    const item = value[key]
    if (typeof item !== 'number' || !Number.isFinite(item)) return undefined
    numeric[key] = item
  }
  const tokenCostSource = value.tokenCostSource === 'measured' || value.tokenCostSource === 'estimated'
    ? value.tokenCostSource : 'estimated'
  return {
    schema: 'harness2-verification/v1',
    reportHash: value.reportHash,
    batchId: value.batchId.slice(0, 120),
    revisionId: value.revisionId.slice(0, 120),
    profile: value.profile.slice(0, 120),
    providerClass: 'real',
    verdict: value.verdict,
    b: Math.max(0, Math.floor(numeric.b!)),
    c: Math.max(0, Math.floor(numeric.c!)),
    N: Math.max(0, Math.floor(numeric.N!)),
    delta: numeric.delta!,
    p: numeric.p!,
    tokenCostSource,
    ...(value.sourceMissing === true ? { sourceMissing: true } : {}),
  }
}

export function sanitizeExperienceEntry(
  value: unknown,
  samePatternCount = 0,
): { readonly entry?: ExperienceEntry; readonly skip?: ExperienceSkip } {
  if (!isRecord(value)) {
    return { skip: { code: 'invalid-entry', details: { reason: 'not-an-object' } } }
  }
  const condition = value.condition
  const edit = value.edit
  const outcome = value.outcome
  if (!isRecord(condition) || !isRecord(edit) || !isRecord(outcome)) {
    return { skip: { code: 'invalid-entry', details: { id: value.id, reason: 'missing-sections' } } }
  }
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 80) {
    return { skip: { code: 'invalid-entry', details: { id: value.id, reason: 'bad-id' } } }
  }
  if (typeof condition.failurePattern !== 'string' || condition.failurePattern.length === 0) {
    return { skip: { code: 'invalid-entry', details: { id: value.id, reason: 'bad-condition' } } }
  }
  const migrated = migrateComponentName(edit.component, value.migratedFrom)
  if (migrated === undefined) {
    return {
      skip: {
        code: 'unknown-component',
        details: { id: value.id, component: edit.component },
      },
    }
  }
  if (typeof edit.operation !== 'string' || edit.operation.length === 0) {
    return { skip: { code: 'invalid-entry', details: { id: value.id, reason: 'bad-operation' } } }
  }
  if (typeof edit.contentHash !== 'string' || edit.contentHash.length === 0) {
    return { skip: { code: 'invalid-entry', details: { id: value.id, reason: 'bad-hash' } } }
  }
  if (outcome.adoption !== 'accepted' && outcome.adoption !== 'rejected') {
    return { skip: { code: 'invalid-entry', details: { id: value.id, reason: 'bad-adoption' } } }
  }

  const observedRaw = Array.isArray(condition.observedIn) ? condition.observedIn : []
  const observedIn = observedRaw
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .map((item) => item.slice(0, 120))
    .slice(-MAX_OBSERVED_IN)

  const trialsRaw = typeof outcome.trials === 'number' && Number.isFinite(outcome.trials)
    ? Math.floor(outcome.trials)
    : 0
  const trials = Math.max(0, Math.min(10000, trialsRaw))

  const tokenCostSource: TokenCostSource =
    outcome.tokenCostSource === 'measured' || outcome.tokenCostSource === 'estimated'
      ? outcome.tokenCostSource
      : 'estimated' // legacy entries had no source: conservative penalty

  const taskDomain = typeof condition.taskDomain === 'string' && condition.taskDomain.length > 0
    ? condition.taskDomain.slice(0, 120)
    : undefined
  const failurePattern = normalizeFailurePattern(condition.failurePattern)

  return {
    entry: {
      id: value.id,
      condition: {
        failurePattern,
        ...(taskDomain === undefined ? {} : { taskDomain }),
        observedIn,
      },
      edit: {
        component: migrated.component,
        operation: sanitizeText(edit.operation, 'unknown-operation', 100),
        contentHash: sanitizeText(edit.contentHash, 'unknown-hash', 128),
        contentPreview: sanitizeText(edit.contentPreview, '', 200),
      },
      outcome: {
        metricDelta: sanitizeMetricDelta(outcome.metricDelta),
        trials,
        adoption: outcome.adoption,
        tokenCostSource,
      },
      confidence: scoreConfidence(trials, outcome.adoption, tokenCostSource, samePatternCount),
      ...(migrated.migratedFrom === undefined ? {} : { migratedFrom: migrated.migratedFrom }),
      ...(sanitizeVerification(value.verification) === undefined
        ? {}
        : { verification: sanitizeVerification(value.verification)! }),
    },
  }
}

/** Render free text for the human-readable half (escapes `<`, flattens lines). */
function renderHumanText(value: string, maxLength = 600): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/</g, '&lt;')
    .slice(0, maxLength)
}

function encodeEntry(entry: ExperienceEntry): string {
  const encoded = Buffer.from(JSON.stringify(entry), 'utf8').toString('base64')
  return `<!-- ${EXPERIENCE_MARKER}:${encoded} -->`
}

/** Render the complete `EXPERIENCE.md` document. */
export function serializeExperience(entries: readonly ExperienceEntry[]): string {
  const lines: string[] = [
    '# EXPERIENCE',
    '',
    '> Managed by harness2-meta-recursion. The HTML comments below are the',
    '> machine-readable form; do not edit them by hand.',
    '',
  ]
  for (const entry of entries) {
    lines.push(`## ${renderHumanText(entry.id, 80)} · confidence ${entry.confidence.toFixed(2)}`)
    lines.push('')
    lines.push(`- condition: ${renderHumanText(entry.condition.failurePattern, 220)}`)
    if (entry.condition.taskDomain !== undefined) {
      lines.push(`- taskDomain: ${renderHumanText(entry.condition.taskDomain, 120)}`)
    }
    lines.push(
      `- observedIn: ${entry.condition.observedIn.map((task) => renderHumanText(task, 120)).join(', ')}`,
    )
    lines.push(
      `- edit: ${renderHumanText(entry.edit.component, 60)} / ${renderHumanText(entry.edit.operation, 100)}`,
    )
    lines.push(`- contentHash: ${renderHumanText(entry.edit.contentHash, 128)}`)
    lines.push(`- preview: ${renderHumanText(entry.edit.contentPreview, 200)}`)
    lines.push(
      `- outcome: ${entry.outcome.adoption} · trials=${entry.outcome.trials} · tokenCostSource=${entry.outcome.tokenCostSource}`,
    )
    for (const [metric, delta] of Object.entries(entry.outcome.metricDelta)) {
      lines.push(`  - ${renderHumanText(metric, 40)}: ${delta}`)
    }
    if (entry.migratedFrom !== undefined) {
      lines.push(`- migratedFrom: ${renderHumanText(entry.migratedFrom, 80)}`)
    }
    lines.push('')
    lines.push(encodeEntry(entry))
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

/** Parse and sanitize an `EXPERIENCE.md` document. */
export function parseExperience(text: string): {
  readonly entries: ExperienceEntry[]
  readonly skipped: number
  readonly errors: readonly ExperienceSkip[]
} {
  const pattern = new RegExp(`<!--\\s*${EXPERIENCE_MARKER}:([A-Za-z0-9+/=]+)\\s*-->`, 'g')
  const entries: ExperienceEntry[] = []
  const errors: ExperienceSkip[] = []
  const history = new Map<string, number>()
  let skipped = 0
  for (const match of text.matchAll(pattern)) {
    const payload = match[1]
    if (payload === undefined) {
      skipped += 1
      continue
    }
    try {
      const decoded = Buffer.from(payload, 'base64').toString('utf8')
      const value: unknown = JSON.parse(decoded)
      const rawPattern =
        isRecord(value) && isRecord(value.condition) && typeof value.condition.failurePattern === 'string'
          ? normalizeFailurePattern(value.condition.failurePattern)
          : undefined
      const samePatternCount = rawPattern === undefined ? 0 : (history.get(rawPattern) ?? 0)
      const result = sanitizeExperienceEntry(value, samePatternCount)
      if (result.entry === undefined) {
        skipped += 1
        if (result.skip !== undefined) errors.push(result.skip)
        continue
      }
      entries.push(result.entry)
      history.set(result.entry.condition.failurePattern, (history.get(result.entry.condition.failurePattern) ?? 0) + 1)
    } catch {
      skipped += 1
    }
  }
  return { entries, skipped, errors }
}

/** Insertion-order registry for task ids. */
export type TaskOrder = ReadonlyMap<string, number>

/** Latest observed task's insertion order (lower = older). */
export function latestObservedOrder(entry: ExperienceEntry, taskOrder: TaskOrder): number {
  let latest = -1
  for (const taskId of entry.condition.observedIn) {
    const order = taskOrder.get(taskId)
    if (order !== undefined && order > latest) latest = order
  }
  return latest
}

/** Enforce `maxExperienceEntries` (confidence asc, then observed order asc). */
export function evictExperience(
  entries: readonly ExperienceEntry[],
  maxEntries: number,
  taskOrder: TaskOrder,
): ExperienceEntry[] {
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) return []
  const capacity = Math.floor(maxEntries)
  if (entries.length <= capacity) return [...entries]
  const ranked = entries
    .map((entry) => ({ entry, order: latestObservedOrder(entry, taskOrder) }))
    .sort(
      (left, right) =>
        left.entry.confidence - right.entry.confidence
        || left.order - right.order
        || left.entry.id.localeCompare(right.entry.id),
    )
  return ranked.slice(ranked.length - capacity).map((item) => item.entry)
}

/** Extract signed metric deltas (positive = better than baseline). */
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

/* -------------------------------------------------------------------------- */
/* Reflection                                                                 */
/* -------------------------------------------------------------------------- */

export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

export function resolveReflectionRoute(ctx: Context, config: Config): ModelRoute | undefined {
  const selection: AgentDefaultModelConfig | undefined = ctx.get('agentDefaultModel')
  const current = selection?.currentSelection()
  const configured = config.llmReflectionModel.trim()
  if (configured.length === 0) {
    return current === undefined ? undefined : { provider: current.provider, model: current.model }
  }
  const separator = configured.indexOf('/')
  if (separator > 0 && separator < configured.length - 1) {
    return { provider: configured.slice(0, separator), model: configured.slice(separator + 1) }
  }
  return current === undefined ? undefined : { provider: current.provider, model: configured }
}

const REFLECTION_SYSTEM = `You maintain a private engineering experience library.
You receive one structured probe/compose outcome. Answer with STRICT JSON only:
{"condition":{"failurePattern":"<normalized substring of evidenceSummary>","taskDomain":"<optional domain>"},
 "edit":{"candidateId":"<id copied from the source payload>","component":"<component copied from the source>","operation":"<operation copied from the source>","contentHash":"<sha256 copied from the source>"},
 "confidenceSeed":0.0}
Rules: copy edit fields exactly from the source payload; never invent metrics
or confidence; failurePattern must be grounded in evidenceSummary; no user text.
Answer JSON only.`

/** Reflection result (validated, untrusted). */
export interface ReflectionResult {
  readonly candidateId?: string
  readonly component?: string
  readonly operation?: string
  readonly contentHash?: string
  readonly failurePattern?: string
  readonly taskDomain?: string
}

/** Parse the reflection JSON; unknown/invalid fields are ignored. */
export function parseReflection(text: string, evidenceSummary: string): ReflectionResult {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return {}
  let value: unknown
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch {
    return {}
  }
  if (!isRecord(value)) return {}
  const result: {
    candidateId?: string
    component?: string
    operation?: string
    contentHash?: string
    failurePattern?: string
    taskDomain?: string
  } = {}
  const condition = isRecord(value.condition) ? value.condition : {}
  const edit = isRecord(value.edit) ? value.edit : {}
  if (typeof condition.failurePattern === 'string') {
    const candidate = normalizeFailurePattern(condition.failurePattern)
    if (normalizeFailurePattern(evidenceSummary).includes(candidate)) {
      result.failurePattern = candidate
    }
  }
  if (typeof condition.taskDomain === 'string' && condition.taskDomain.length > 0) {
    result.taskDomain = condition.taskDomain.slice(0, 120)
  }
  if (typeof edit.candidateId === 'string' && edit.candidateId.length > 0) {
    result.candidateId = edit.candidateId.slice(0, 120)
  }
  if (isComponentName(edit.component)) result.component = edit.component
  if (typeof edit.operation === 'string' && edit.operation.length > 0) {
    result.operation = edit.operation.slice(0, 100)
  }
  if (typeof edit.contentHash === 'string' && edit.contentHash.length > 0) {
    result.contentHash = edit.contentHash.slice(0, 128)
  }
  return result
}

/* -------------------------------------------------------------------------- */
/* Experience service                                                         */
/* -------------------------------------------------------------------------- */

export interface ExperienceLogger {
  info(message: string): void
  warn(message: string): void
  debug(message: string): void
}

/** Structured plugin error sink (`onError(code, details)`). */
export type ExperienceErrorReporter = (code: string, details?: unknown) => void

export interface ExperienceServiceOptions {
  readonly experiencePath: string
  readonly maxExperienceEntries: number
  readonly topKInjection: number
  readonly minConfidenceToInject: number
  readonly minNegativeConfidenceToInject: number
  readonly enableNegativeExperience: boolean
  readonly enableLegacyExperience?: boolean
  readonly ledgerPath?: string
  readonly evaluationsPath: string
  readonly applyStatePath: string
  readonly reflect?: (
    probe: ProbeCompletedPayload | undefined,
    event: ComposeAppliedPayload | ComposeRejectedPayload,
  ) => Promise<ReflectionResult | undefined>
  readonly log?: ExperienceLogger
  readonly onError?: ExperienceErrorReporter
}

interface PendingEvidence {
  readonly probe: ProbeCompletedPayload
}

/** Experience library plus the frozen read-only query facade. */
export class Harness2ExperienceService {
  readonly settled: Promise<void>

  private readonly experiencePath: string
  private readonly maxExperienceEntries: number
  private readonly topKInjection: number
  private readonly minConfidenceToInject: number
  private readonly minNegativeConfidenceToInject: number
  private readonly enableNegativeExperience: boolean
  private readonly enableLegacyExperience: boolean
  private readonly evaluationsPath: string
  private readonly applyStatePath: string
  private readonly seedAppliedComponents = new Set<string>()
  private readonly evictedRevisions = new Set<string>()
  private readonly reflect:
    | ((
        probe: ProbeCompletedPayload | undefined,
        event: ComposeAppliedPayload | ComposeRejectedPayload,
      ) => Promise<ReflectionResult | undefined>)
    | undefined
  private readonly log: ExperienceLogger | undefined
  private readonly onError: ExperienceErrorReporter

  private entriesInternal: ExperienceEntry[] = []
  private readonly pending = new Map<string, PendingEvidence>()
  private readonly taskOrder = new Map<string, number>()
  private taskSequence = 0
  private persistTail: Promise<void> = Promise.resolve()
  private isReady = false

  constructor(options: ExperienceServiceOptions) {
    this.experiencePath = resolveStoragePath(options.experiencePath)
    this.maxExperienceEntries = options.maxExperienceEntries
    this.topKInjection = options.topKInjection
    this.minConfidenceToInject = options.minConfidenceToInject
    this.minNegativeConfidenceToInject = options.minNegativeConfidenceToInject
    this.enableNegativeExperience = options.enableNegativeExperience
    this.enableLegacyExperience = options.enableLegacyExperience === true
    this.evaluationsPath = resolveEvaluationsPath(options.evaluationsPath, options.ledgerPath ?? './harness2-ledger.jsonl')
    this.applyStatePath = resolveApplyStatePath(options.applyStatePath)
    this.reflect = options.reflect
    this.log = options.log
    this.onError = options.onError ?? ((code, details) => {
      this.log?.warn(`${name}: onError(${code}) ${details === undefined ? '' : JSON.stringify(details)}`)
    })
    this.settled = this.load()
  }

  get ready(): boolean {
    return this.isReady
  }

  entries(): readonly ExperienceEntry[] {
    return this.entriesInternal.map((entry) => freezeEntry(entry))
  }

  noteProbe(payload: ProbeCompletedPayload): void {
    this.pending.set(payload.cycleId, { probe: payload })
    while (this.pending.size > 200) {
      const oldest = this.pending.keys().next().value
      if (oldest === undefined) break
      this.pending.delete(oldest)
    }
    this.orderOf(payload.taskId)
  }

  /** Record a positive entry for `compose/applied` (only positive path). */
  async recordApplied(payload: ComposeAppliedPayload): Promise<ExperienceEntry | undefined> {
    // PR-5: compose decisions are diagnostic only; evidence comes exclusively
    // from real-provider verified evaluations.
    this.onError('gate-decision-not-evidence', { cycleId: payload.cycleId })
    return undefined
  }

  private async recordAppliedLegacyRemoved(payload: ComposeAppliedPayload): Promise<ExperienceEntry | undefined> {
    await this.settled
    const pending = this.pending.get(payload.cycleId)?.probe
    if (payload.appliedEdits.length === 0) {
      this.onError('applied-edits-empty', { cycleId: payload.cycleId })
      return undefined
    }
    const reflection = await this.reflectSafely(pending, payload)
    const candidateId = reflection?.candidateId ?? payload.appliedEdits[0]!.candidateId
    const source = payload.appliedEdits.find((edit) => edit.candidateId === candidateId)
    if (source === undefined) {
      this.onError('reflection-edit-mismatch', {
        candidateId,
        expected: payload.appliedEdits.map((edit) => edit.candidateId),
        actual: candidateId,
      })
      return undefined
    }
    if (reflection !== undefined && !this.reflectionMatchesSource(reflection, source)) {
      this.onError('reflection-edit-mismatch', {
        candidateId,
        expected: { component: source.component, operation: source.operation, contentHash: source.contentHash },
        actual: {
          component: reflection.component,
          operation: reflection.operation,
          contentHash: reflection.contentHash,
        },
      })
      return undefined
    }
    const trial = pending?.trials.find(
      (item) => item.valid && item.metrics !== undefined && item.candidateId === candidateId,
    )
    if (trial === undefined || trial.metrics === undefined) {
      this.onError('metric-trial-missing', { cycleId: payload.cycleId, candidateId })
      return undefined
    }
    const validTrials = pending?.trials.filter((item) => item.valid).length ?? 0
    if (validTrials === 0) {
      this.onError('no-evidence', { cycleId: payload.cycleId })
      return undefined
    }
    const entry = this.upsert({
      failurePattern: this.conditionPattern(reflection, pending),
      ...(reflection?.taskDomain === undefined ? {} : { taskDomain: reflection.taskDomain }),
      observedIn: [payload.taskId],
      edit: {
        component: source.component,
        operation: source.operation,
        contentHash: source.contentHash,
        contentPreview: this.contentPreview(reflection, pending),
      },
      metricDelta: metricDeltaOf(pending!.baselineMetrics, trial.metrics),
      trials: validTrials,
      adoption: 'accepted',
      tokenCostSource: trial.metrics.tokenCostSource,
    })
    await this.persist()
    return entry
  }

  /**
   * Record negative experience for `compose/rejected(regression)`.
   *
   * One entry per rejected candidate id; candidate metadata always comes from
   * the trial facts, never from the reflection model.
   */
  async recordRejected(payload: ComposeRejectedPayload): Promise<ExperienceEntry[]> {
    // PR-5: compose decisions are diagnostic only.
    this.onError('gate-decision-not-evidence', { cycleId: payload.cycleId })
    return []
  }

  private async recordRejectedLegacyRemoved(payload: ComposeRejectedPayload): Promise<ExperienceEntry[]> {
    if (!this.enableNegativeExperience) return []
    if (!NEGATIVE_EXPERIENCE_REASONS.includes(payload.reason)) return []
    await this.settled
    const pending = this.pending.get(payload.cycleId)?.probe
    const reflection = await this.reflectSafely(pending, payload)
    if (
      reflection?.candidateId !== undefined
      && !payload.rejectedCandidateIds.includes(reflection.candidateId)
    ) {
      this.onError('reflection-edit-mismatch', {
        candidateId: reflection.candidateId,
        expected: payload.rejectedCandidateIds,
        actual: reflection.candidateId,
      })
      return []
    }
    const validTrials = pending?.trials.filter((item) => item.valid).length ?? 0
    const written: ExperienceEntry[] = []
    for (const candidateId of payload.rejectedCandidateIds) {
      const trial = payload.trials.find((item) => item.candidateId === candidateId)
        ?? pending?.trials.find((item) => item.candidateId === candidateId)
      if (trial === undefined) {
        this.onError('trial-locate-failed', { cycleId: payload.cycleId, candidateId })
        continue
      }
      if (reflection !== undefined && reflection.candidateId === candidateId) {
        const source = {
          component: trial.component,
          operation: trial.operation,
          contentHash: trial.editContentHash,
        }
        if (!this.reflectionMatchesSource(reflection, source)) {
          this.onError('reflection-edit-mismatch', {
            candidateId,
            expected: source,
            actual: {
              component: reflection.component,
              operation: reflection.operation,
              contentHash: reflection.contentHash,
            },
          })
          continue
        }
      }
      if (trial.metrics === undefined || validTrials === 0) {
        this.onError('no-evidence', { cycleId: payload.cycleId, candidateId })
        continue
      }
      const entry = this.upsert({
        failurePattern: this.conditionPattern(
          reflection?.candidateId === candidateId ? reflection : undefined,
          pending,
        ),
        ...(reflection?.candidateId === candidateId && reflection.taskDomain !== undefined
          ? { taskDomain: reflection.taskDomain }
          : {}),
        observedIn: [payload.taskId],
        edit: {
          component: trial.component,
          operation: trial.operation,
          contentHash: trial.editContentHash,
          contentPreview: this.contentPreview(
            reflection?.candidateId === candidateId ? reflection : undefined,
            pending,
          ),
        },
        metricDelta: metricDeltaOf(payload.baselineMetrics, trial.metrics),
        trials: validTrials,
        adoption: 'rejected',
        tokenCostSource: trial.metrics.tokenCostSource,
      })
      if (entry !== undefined) written.push(entry)
    }
    await this.persist()
    return written
  }

  /** Frozen synchronous read-only query (per-adoption thresholds, Q6). */
  queryPriors = (query: PriorsQuery): PriorsResult => {
    if (!this.isReady) return { priors: [], totalMatched: 0 }
    const signature = query?.failureSignature
    if (signature === undefined || !isRecord(signature)) return { priors: [], totalMatched: 0 }
    const populated = [
      signature.toolName,
      signature.errorCode,
      signature.messagePattern,
      signature.taskDomain,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    if (populated.length === 0) return { priors: [], totalMatched: 0 }

    const applied = new Set([
      ...this.seedAppliedComponents,
      ...(query.appliedComponents ?? []).filter((item): item is string => typeof item === 'string'),
    ])
    const requestedLimit = typeof query.limit === 'number' && Number.isFinite(query.limit)
      ? Math.floor(query.limit)
      : this.topKInjection
    const limit = Math.max(0, Math.min(requestedLimit, this.topKInjection, this.maxExperienceEntries))

    const matched = this.entriesInternal
      .filter((entry) => entry.condition.taskDomain !== 'eval-holdout')
      .filter((entry) => entry.verification !== undefined || this.enableLegacyExperience)
      .filter((entry) => entry.verification === undefined || !this.evictedRevisions.has(entry.verification.revisionId))
      .filter((entry) =>
        entry.outcome.adoption === 'accepted'
          ? entry.confidence >= this.minConfidenceToInject
          : entry.confidence >= this.minNegativeConfidenceToInject)
      .filter((entry) => !applied.has(entry.edit.component))
      .filter((entry) => matchesSignature(entry, signature))
      .sort((left, right) =>
        right.confidence - left.confidence
        || latestObservedOrder(right, this.taskOrder) - latestObservedOrder(left, this.taskOrder)
        || left.id.localeCompare(right.id))

    return {
      priors: matched.slice(0, limit).map((entry) => freezeEntry(entry)),
      totalMatched: matched.length,
    }
  }

  async flush(): Promise<void> {
    await this.settled
    await this.persistTail
  }

  /** Run the optional reflection hook without ever throwing. */
  private async reflectSafely(
    probe: ProbeCompletedPayload | undefined,
    event: ComposeAppliedPayload | ComposeRejectedPayload,
  ): Promise<ReflectionResult | undefined> {
    if (this.reflect === undefined) return undefined
    try {
      return await this.reflect(probe, event)
    } catch (error) {
      this.onError('reflection-failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  /** Strictly compare reflection edit facts with the source facts. */
  private reflectionMatchesSource(
    reflection: ReflectionResult,
    source: { readonly component: string; readonly operation: string; readonly contentHash: string },
  ): boolean {
    return reflection.component === source.component
      && reflection.operation === source.operation
      && reflection.contentHash === source.contentHash
  }

  /**
   * Condition pattern: grounded reflection value, else evidence fallback.
   *
   * Reflection callbacks are untrusted too (not only the LLM text path), so the
   * suggested pattern must be a substring of the normalized evidence summary.
   */
  private conditionPattern(
    reflection: ReflectionResult | undefined,
    probe: ProbeCompletedPayload | undefined,
  ): string {
    const fallback = normalizeFailurePattern(probe?.evidenceSummary ?? 'unknown-failure')
    if (reflection?.failurePattern === undefined) return fallback
    const reflected = normalizeFailurePattern(reflection.failurePattern)
    return fallback.includes(reflected) ? reflected : fallback
  }

  /** Human preview: deterministic evidence excerpt (never reflection text). */
  private contentPreview(
    reflection: ReflectionResult | undefined,
    probe: ProbeCompletedPayload | undefined,
  ): string {
    const fallback = normalizeFailurePattern(probe?.evidenceSummary ?? 'unknown-failure')
    void reflection
    return fallback.slice(0, 200)
  }

  private orderOf(taskId: string): number {
    const existing = this.taskOrder.get(taskId)
    if (existing !== undefined) return existing
    const order = this.taskSequence
    this.taskSequence += 1
    this.taskOrder.set(taskId, order)
    return order
  }

  /** Insert or merge one entry, then enforce capacity. */
  private upsert(input: {
    readonly failurePattern: string
    readonly taskDomain?: string
    readonly observedIn: readonly string[]
    readonly edit: {
      readonly component: string
      readonly operation: string
      readonly contentHash: string
      readonly contentPreview: string
    }
    readonly metricDelta: Readonly<Record<string, number>>
    readonly trials: number
    readonly adoption: 'accepted' | 'rejected'
    readonly tokenCostSource: TokenCostSource
    readonly verification?: ExperienceVerification
  }): ExperienceEntry | undefined {
    if (input.verification !== undefined) {
      const duplicate = this.entriesInternal.some(
        (entry) => entry.verification?.reportHash === input.verification!.reportHash,
      )
      if (duplicate) return this.entriesInternal.find(
        (entry) => entry.verification?.reportHash === input.verification!.reportHash,
      )
    }
    if (input.trials <= 0) {
      // Q5: no-evidence entries are refused before any write.
      this.onError('no-evidence', { reason: 'trials-zero' })
      return undefined
    }
    const identity = (entry: ExperienceEntry): boolean =>
      entry.condition.failurePattern === input.failurePattern
      && entry.edit.component === input.edit.component
      && entry.edit.operation === input.edit.operation

    const existingIndex = this.entriesInternal.findIndex(identity)
    const historyCount = this.entriesInternal.filter(
      (candidate) =>
        candidate.condition.failurePattern === input.failurePattern
        && (existingIndex < 0 || candidate.id !== this.entriesInternal[existingIndex]!.id),
    ).length
    const confidence = scoreConfidence(
      input.trials,
      input.adoption,
      input.tokenCostSource,
      historyCount,
    )
    let entry: ExperienceEntry
    if (existingIndex >= 0) {
      const existing = this.entriesInternal[existingIndex]!
      entry = {
        id: existing.id,
        condition: {
          failurePattern: input.failurePattern,
          ...(input.taskDomain === undefined && existing.condition.taskDomain === undefined
            ? {}
            : { taskDomain: input.taskDomain ?? existing.condition.taskDomain }),
          observedIn: mergeObserved(existing.condition.observedIn, input.observedIn),
        },
        edit: { ...input.edit },
        outcome: {
          metricDelta: input.metricDelta,
          trials: input.trials,
          adoption: input.adoption,
          tokenCostSource: input.tokenCostSource,
        },
        confidence,
        ...(existing.migratedFrom === undefined ? {} : { migratedFrom: existing.migratedFrom }),
        ...(input.verification === undefined ? {} : { verification: input.verification }),
      }
      this.entriesInternal = this.entriesInternal.map((candidate, index) =>
        (index === existingIndex ? entry : candidate))
    } else {
      entry = {
        id: `exp-${createHash('sha256')
          .update(`${input.failurePattern}|${input.edit.component}|${input.edit.operation}`, 'utf8')
          .digest('hex')
          .slice(0, 16)}`,
        condition: {
          failurePattern: input.failurePattern,
          ...(input.taskDomain === undefined ? {} : { taskDomain: input.taskDomain }),
          observedIn: input.observedIn.slice(-MAX_OBSERVED_IN),
        },
        edit: { ...input.edit },
        outcome: {
          metricDelta: input.metricDelta,
          trials: input.trials,
          adoption: input.adoption,
          tokenCostSource: input.tokenCostSource,
        },
        confidence,
        ...(input.verification === undefined ? {} : { verification: input.verification }),
      }
      this.entriesInternal = [...this.entriesInternal, entry]
    }
    for (const taskId of entry.condition.observedIn) this.orderOf(taskId)
    this.entriesInternal = evictExperience(
      this.entriesInternal,
      this.maxExperienceEntries,
      this.taskOrder,
    )
    return this.entriesInternal.find((candidate) => candidate.id === entry.id)
  }

  /** Load the experience library once; always settles `ready`. */
  private async load(): Promise<void> {
    try {
      let text = ''
      try {
        text = await readFile(this.experiencePath, 'utf8')
      } catch (error) {
        if (!isMissingFile(error)) {
          this.onError('experience-read-failed', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
        // PR-5: a missing EXPERIENCE.md must not skip verified-evaluation ingest.
      }
      let parsed: {
        readonly entries: ExperienceEntry[]
        readonly skipped: number
        readonly errors: readonly ExperienceSkip[]
      }
      try {
        parsed = parseExperience(text)
      } catch (error) {
        this.onError('experience-parse-failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        await this.quarantine('unreadable')
        return
      }
      const markerOccurrences = text.split(EXPERIENCE_MARKER).length - 1
      if (text.trim().length > 0 && (markerOccurrences === 0 || markerOccurrences > parsed.entries.length)) {
        await this.quarantine(markerOccurrences === 0 ? 'foreign' : 'corrupt')
      }
      if (parsed.skipped > 0) {
        this.log?.warn(`${name}: skipped ${parsed.skipped} invalid experience entries`)
      }
      for (const skip of parsed.errors) this.onError(skip.code, skip.details)
      for (const entry of parsed.entries) {
        for (const taskId of entry.condition.observedIn) this.orderOf(taskId)
      }
      this.entriesInternal = evictExperience(parsed.entries, this.maxExperienceEntries, this.taskOrder)
      if (this.entriesInternal.length !== parsed.entries.length) {
        await this.persist().catch((error: unknown) => {
          this.onError('experience-rewrite-failed', {
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }
      await this.loadApplyState()
      await this.ingestEvaluations()
    } finally {
      this.isReady = true
    }
  }

  /** PR-5: seed applied components and collect rolled-back revisions. */
  private async loadApplyState(): Promise<void> {
    try {
      const text = await readFile(this.applyStatePath, 'utf8')
      const active: unknown = JSON.parse(text)
      if (isRecord(active)) {
        if (active.status === 'rolled-back') {
          if (typeof active.revisionId === 'string') this.evictedRevisions.add(active.revisionId)
          if (Array.isArray(active.contentHashes)) {
            for (const hash of active.contentHashes) {
              if (typeof hash === 'string') this.evictedRevisions.add(`content:${hash}`)
            }
          }
        } else if (Array.isArray(active.appliedComponents)) {
          for (const component of active.appliedComponents) {
            if (typeof component === 'string') this.seedAppliedComponents.add(component)
          }
        }
      }
      const journalPath = path.join(path.dirname(this.applyStatePath), 'journal.jsonl')
      const journal = await readFile(journalPath, 'utf8').catch(() => '')
      for (const line of journal.split('\n')) {
        if (line.trim().length === 0) continue
        try {
          const record: unknown = JSON.parse(line)
          if (isRecord(record) && record.kind === 'rolled-back' && typeof record.revisionId === 'string') {
            this.evictedRevisions.add(record.revisionId)
          }
        } catch { /* ignore malformed journal lines */ }
      }
    } catch (error) {
      if (!isMissingFile(error)) this.onError('apply-state-read-failed', { error: describeError(error) })
    }
  }

  /**
   * PR-5: ingest real-provider verified evaluations from the eval index.
   * The index points at reports; providerClass must be real, reportHash must
   * verify, and provenance must be present. fake/inconclusive/hash-mismatch are
   * diagnostic only and never write experience.
   */
  private async ingestEvaluations(): Promise<void> {
    let text: string
    try { text = await readFile(this.evaluationsPath, 'utf8') } catch (error) {
      if (!isMissingFile(error)) this.onError('evaluation-index-read-failed', { error: describeError(error) })
      return
    }
    let wrote = false
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      let indexed: unknown
      try { indexed = JSON.parse(line) } catch { continue }
      if (!isRecord(indexed) || indexed.schema !== 'harness2-eval-index/v1') continue
      const batchId = typeof indexed.batchId === 'string' ? indexed.batchId : undefined
      if (batchId === undefined) continue
      if (indexed.providerClass !== 'real') { this.onError('verification-provider-invalid', { batchId }); continue }
      if (indexed.verdict !== 'accept' && indexed.verdict !== 'reject') { this.onError('verification-report-invalid', { batchId }); continue }
      const reportPath = typeof indexed.reportPath === 'string'
        ? path.resolve(path.dirname(this.evaluationsPath), indexed.reportPath)
        : undefined
      if (reportPath === undefined) { this.onError('verification-report-invalid', { batchId }); continue }
      let report: unknown
      try { report = JSON.parse(await readFile(reportPath, 'utf8')) } catch (error) {
        this.onError('verification-report-invalid', { batchId, error: describeError(error) })
        continue
      }
      if (!isRecord(report) || report.schema !== 'harness2-eval/v1') { this.onError('verification-report-invalid', { batchId }); continue }
      if (report.providerClass !== 'real') { this.onError('verification-provider-invalid', { batchId }); continue }
      const verdict = report.verdict
      if (verdict !== 'accept' && verdict !== 'reject') { this.onError('verification-report-invalid', { batchId }); continue }
      if (verdict !== indexed.verdict) { this.onError('verification-report-invalid', { batchId }); continue }
      if (typeof report.reportHash !== 'string' || report.reportHash !== indexed.reportHash || report.reportHash !== evaluationReportHash(report)) {
        this.onError('verification-hash-mismatch', { batchId }); continue
      }
      const source = isRecord(report.source) ? report.source : undefined
      if (report.sourceMissing === true || source === undefined || typeof source.failurePattern !== 'string') {
        this.onError('verification-source-missing', { batchId }); continue
      }
      if (source.taskDomain === 'eval-holdout') { this.onError('verification-eval-holdout', { batchId }); continue }
      const edit = isRecord(report.edit) ? report.edit : undefined
      if (edit === undefined || typeof edit.component !== 'string' || typeof edit.operation !== 'string'
        || typeof edit.contentHash !== 'string') { this.onError('verification-report-invalid', { batchId }); continue }
      const b = typeof report.b === 'number' ? report.b : 0
      const c = typeof report.c === 'number' ? report.c : 0
      const N = typeof report.N === 'number' ? report.N : 0
      if (N <= 0) { this.onError('verification-report-invalid', { batchId }); continue }
      const verification: ExperienceVerification = {
        schema: 'harness2-verification/v1',
        reportHash: report.reportHash,
        batchId,
        revisionId: typeof report.revisionId === 'string' ? report.revisionId : '',
        profile: typeof report.profile === 'string' ? report.profile : '',
        providerClass: 'real',
        verdict,
        b, c, N,
        delta: (b - c) / N,
        p: typeof report.p === 'number' ? report.p : 1,
        tokenCostSource: report.tokenCostSource === 'measured' ? 'measured' : 'estimated',
      }
      const entry = this.upsert({
        failurePattern: normalizeFailurePattern(source.failurePattern),
        ...(typeof source.taskDomain === 'string' && source.taskDomain.length > 0 ? { taskDomain: source.taskDomain.slice(0, 120) } : {}),
        observedIn: [`eval:${batchId}`],
        edit: {
          component: edit.component,
          operation: edit.operation,
          contentHash: edit.contentHash,
          contentPreview: normalizeFailurePattern(source.failurePattern).slice(0, 200),
        },
        metricDelta: { successRateDelta: verification.delta, completion: verification.delta },
        trials: N,
        adoption: verdict === 'accept' ? 'accepted' : 'rejected',
        tokenCostSource: verification.tokenCostSource,
        verification,
      })
      if (entry === undefined) this.onError('verification-ingest-failed', { batchId })
      else wrote = true
    }
    if (wrote) await this.persist()
  }

  private async quarantine(reason: 'corrupt' | 'foreign' | 'unreadable'): Promise<void> {
    const backupPath = `${this.experiencePath}.backup`
    try {
      await copyFile(this.experiencePath, backupPath)
      this.log?.warn(`${name}: existing experience file looked ${reason}; preserved it at ${backupPath}`)
    } catch (error) {
      this.onError('experience-backup-failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private persist(): Promise<void> {
    const snapshot = this.entriesInternal.map((entry) => freezeEntry(entry))
    const task = this.persistTail.then(async () => {
      const directory = path.dirname(this.experiencePath)
      await mkdir(directory, { recursive: true })
      const temporary = `${this.experiencePath}.tmp-${randomUUID()}`
      await writeFile(temporary, serializeExperience(snapshot), 'utf8')
      await rename(temporary, this.experiencePath)
    })
    this.persistTail = task.catch(() => undefined)
    return task
  }
}

function freezeEntry(entry: ExperienceEntry): ExperienceEntry {
  return Object.freeze({
    id: entry.id,
    condition: Object.freeze({
      failurePattern: entry.condition.failurePattern,
      ...(entry.condition.taskDomain === undefined ? {} : { taskDomain: entry.condition.taskDomain }),
      observedIn: Object.freeze([...entry.condition.observedIn]) as readonly string[],
    }),
    edit: Object.freeze({ ...entry.edit }),
    outcome: Object.freeze({
      metricDelta: Object.freeze({ ...entry.outcome.metricDelta }),
      trials: entry.outcome.trials,
      adoption: entry.outcome.adoption,
      tokenCostSource: entry.outcome.tokenCostSource,
    }),
    confidence: entry.confidence,
    ...(entry.migratedFrom === undefined ? {} : { migratedFrom: entry.migratedFrom }),
    ...(entry.verification === undefined ? {} : { verification: Object.freeze({ ...entry.verification }) }),
  })
}

/** Keep the 5 most recent observed task ids, preserving newest-last order. */
function mergeObserved(existing: readonly string[], incoming: readonly string[]): readonly string[] {
  const merged = [...existing]
  for (const taskId of incoming) {
    const index = merged.indexOf(taskId)
    if (index >= 0) merged.splice(index, 1)
    merged.push(taskId)
  }
  return merged.slice(-MAX_OBSERVED_IN)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null
    && typeof error === 'object'
    && 'code' in error
    && (error as { readonly code?: unknown }).code === 'ENOENT'
  )
}

/* -------------------------------------------------------------------------- */
/* Reflection call                                                            */
/* -------------------------------------------------------------------------- */

async function reflectExperience(
  ctx: Context,
  config: Config,
  probe: ProbeCompletedPayload | undefined,
  event: ComposeAppliedPayload | ComposeRejectedPayload,
): Promise<ReflectionResult | undefined> {
  const route = resolveReflectionRoute(ctx, config)
  if (route === undefined) return undefined
  const evidenceSummary = probe?.evidenceSummary ?? ''
  const facts = {
    outcome: 'appliedCandidateIds' in event ? 'accepted' : 'rejected',
    taskId: event.taskId,
    cycleId: event.cycleId,
    evidenceSummary,
    baselineMetrics: probe?.baselineMetrics,
    trials: probe?.trials,
    appliedEdits: 'appliedEdits' in event ? event.appliedEdits : undefined,
    appliedComponents: 'appliedComponents' in event ? event.appliedComponents : undefined,
    rejectedCandidateIds: 'rejectedCandidateIds' in event ? event.rejectedCandidateIds : undefined,
    rejectionReason: 'reason' in event ? event.reason : undefined,
    components: COMPONENT_NAMES,
  }
  let text = ''
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    system: REFLECTION_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(facts) }] }],
    maxTokens: 1024,
    signal: AbortSignal.timeout(60_000),
  })
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish' && chunk.reason.kind === 'error') break
  }
  return parseReflection(text, evidenceSummary)
}

/* -------------------------------------------------------------------------- */
/* Plugin entry                                                               */
/* -------------------------------------------------------------------------- */

const FORBIDDEN_RAW_EVENT_PREFIXES = [
  'agent/',
  'tools/',
  'llm/',
  'session/',
  'subagent/',
] as const

export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger(name)
  const onError: ExperienceErrorReporter = (code, details) => {
    log.warn(`${name}: onError(${code}) ${details === undefined ? '' : JSON.stringify(details)}`)
  }
  const service = new Harness2ExperienceService({
    experiencePath: config.experiencePath,
    maxExperienceEntries: config.maxExperienceEntries,
    topKInjection: config.topKInjection,
    minConfidenceToInject: config.minConfidenceToInject,
    minNegativeConfidenceToInject: config.minNegativeConfidenceToInject,
    enableNegativeExperience: config.enableNegativeExperience,
    enableLegacyExperience: config.enableLegacyExperience,
    evaluationsPath: config.evaluationsPath,
    ledgerPath: config.ledgerPath,
    applyStatePath: config.applyStatePath,
    log,
    onError,
    reflect: (probe, event) => reflectExperience(ctx, config, probe, event),
  })

  const facade: Harness2ExperienceFacade = Object.freeze({
    get ready(): boolean {
      return service.ready
    },
    queryPriors: (query: PriorsQuery): PriorsResult => service.queryPriors(query),
  })
  ctx.provide('harness2Experience', facade)

  void service.settled.catch((error: unknown) => {
    onError('experience-load-failed', { error: describeError(error) })
  })

  ctx.on('probe/completed', (payload) => {
    try {
      service.noteProbe(payload)
    } catch (error) {
      onError('probe-intake-failed', { error: describeError(error) })
    }
  })

  ctx.on('compose/applied', (payload) => {
    void service.recordApplied(payload).catch((error: unknown) => {
      onError('applied-write-failed', { error: describeError(error) })
    })
  })

  ctx.on('compose/rejected', (payload) => {
    if (!config.enableNegativeExperience) return
    if (!NEGATIVE_EXPERIENCE_REASONS.includes(payload.reason)) return
    void service.recordRejected(payload).catch((error: unknown) => {
      onError('rejected-write-failed', { error: describeError(error) })
    })
  })

  // R4-1: `propose/failed` is diagnostic only. No candidate exists, so there is
  // no edit to attribute and no experience entry may be distilled. It never
  // touches the experience library, counts, or the confidence formula.
  ctx.on('propose/failed', (payload) => {
    log.info(
      `${name}: propose/failed task=${payload.taskId} cycle=${payload.cycleId} reason=${payload.reason} attempts=${payload.attempts}`,
    )
  })
}

/** Static self-description of the subscription contract. */
export const LISTENED_EVENTS = [
  'probe/completed',
  'compose/applied',
  'compose/rejected',
  'propose/failed',
] as const

export { FORBIDDEN_RAW_EVENT_PREFIXES }
