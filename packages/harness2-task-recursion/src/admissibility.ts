/**
 * Round-6 PR-1: deterministic admissibility predicate for candidate edits.
 *
 * This is NOT fitness: it only decides whether an edit may be materialized into
 * a profile patch later. Certification happens offline (Gate-B). The predicate
 * is pure (no I/O, no LLM) so it is cheap, replayable and unit-testable.
 */

export type PatchComponent = 'system-prompt' | 'tool-guidance' | 'plugins'

export type PatchOperation =
  | 'set-persona-prefix'
  | 'set-persona-suffix'
  | 'set-tool-order'
  | 'disable-row'
  | 'enable-row'
  | 'set-harness2-config'

export type AdmissibilityCode =
  | 'ok'
  | 'component-not-renderable'
  | 'operation-not-allowlisted'
  | 'empty-content'
  | 'content-too-long'
  | 'denied-phrase'
  | 'unresolved-variable'
  | 'not-a-persona-statement'
  | 'invalid-tool-order'
  | 'unknown-row'
  | 'config-key-not-allowed'
  | 'config-value-not-allowed'

export interface Admissibility {
  readonly ok: boolean
  readonly code: AdmissibilityCode
  readonly spec?: {
    readonly component: PatchComponent
    readonly operation: PatchOperation
    readonly content: string
  }
}

/** The only component/operation pairs PR-6 knows how to render offline. */
export const ADMISSIBLE_OPERATIONS: Readonly<
  Record<PatchComponent, readonly PatchOperation[]>
> = Object.freeze({
  'system-prompt': ['set-persona-prefix', 'set-persona-suffix'],
  'tool-guidance': ['set-tool-order'],
  plugins: ['disable-row', 'enable-row', 'set-harness2-config'],
})

const DENY_PHRASES: readonly RegExp[] = [
  /\bdo nothing\b/i,
  /\bkeep (the )?harness (exactly )?as it is\b/i,
  /\bignore (the |all )?(task|previous|above|instructions?)\b/i,
  /\breply (only )?(with )?done\b/i,
  /\boutput only\b/i,
  /\bdo not (answer|respond|perform)\b/i,
]

const PERSONA_SHAPE = /^(You are|The agent|This agent|Act as)\b[\s\S]{20,2000}$/

/** Rows a candidate must never enable/disable (self-modifying or evidence paths). */
const FORBIDDEN_ROWS: readonly RegExp[] = [
  /^hmr$/,
  /^plugin-manager$/,
  /^harness2-/,
  /^system-prompt$/,
  /^tools$/,
  /^llm$/,
  /^llm-retry$/,
  /^session$/,
  /^agent-loop$/,
  /^agent$/,
  /^config-editor$/,
  /^settings$/,
  /^authorization$/,
  /^credentials$/,
]

/** `plugins/set-harness2-config` keys a candidate may tune (never the judge). */
export const TUNABLE_HARNESS2_KEYS: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  triggerThreshold: [1, 20],
  repeatedFailureWindow: [1, 20],
  cooldownMs: [0, 600_000],
  trajectoryWindow: [1, 20],
})

export const FORBIDDEN_CONFIG_KEYS: readonly string[] = Object.freeze([
  'metricWeights',
  'gatePolicy',
  'observeOnly',
  'ledgerPath',
  'experiencePath',
  'proposeModel',
  'llmReflectionModel',
  'bodyStorePath',
  'applyStatePath',
  'minConfidenceToInject',
  'minNegativeConfidenceToInject',
])

function fail(code: AdmissibilityCode): Admissibility {
  return { ok: false, code }
}

function normalize(text: string): string {
  return text.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim()
}

function checkVariables(content: string): AdmissibilityCode | undefined {
  const vars = [...content.matchAll(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g)].map((match) => match[1])
  for (const variable of vars) {
    if (variable !== 'model' && variable !== 'provider') return 'unresolved-variable'
  }
  return undefined
}

function checkRowId(content: string): AdmissibilityCode | undefined {
  // Validate the RAW content: a row id with spaces/zero-width characters must
  // fail here, not later in the PR-3 renderer.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(content)) return 'unknown-row'
  if (FORBIDDEN_ROWS.some((pattern) => pattern.test(content))) return 'unknown-row'
  return undefined
}

function checkToolOrder(content: string): AdmissibilityCode | undefined {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return 'invalid-tool-order'
  }
  if (!Array.isArray(value) || value.length > 64) return 'invalid-tool-order'
  const names = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  if (names.length !== value.length) return 'invalid-tool-order'
  if (new Set(names).size !== names.length) return 'invalid-tool-order'
  if (names.some((name) => name !== '<unlisted-tools>' && !/^[A-Za-z0-9_.:-]+$/.test(name))) {
    return 'invalid-tool-order'
  }
  if (names.filter((name) => name === '<unlisted-tools>').length !== 1) return 'invalid-tool-order'
  return undefined
}

function checkHarness2Config(content: string): AdmissibilityCode | undefined {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return 'config-value-not-allowed'
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'config-value-not-allowed'
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 2 || !('key' in record) || !('value' in record)) return 'config-value-not-allowed'
  const key = record.key
  if (typeof key !== 'string' || FORBIDDEN_CONFIG_KEYS.includes(key)) return 'config-key-not-allowed'
  // Object.hasOwn: never consult the prototype chain (__proto__/constructor/...).
  if (!Object.hasOwn(TUNABLE_HARNESS2_KEYS, key)) return 'config-key-not-allowed'
  const range = TUNABLE_HARNESS2_KEYS[key]
  if (!Array.isArray(range)) return 'config-key-not-allowed'
  const candidate = record.value
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return 'config-value-not-allowed'
  if (candidate < range[0] || candidate > range[1]) return 'config-value-not-allowed'
  return undefined
}

/**
 * Pure admissibility check.
 *
 * @returns `{ok:true, spec}` or `{ok:false, code}`; never throws.
 */
export function checkAdmissibility(
  component: unknown,
  operation: unknown,
  content: unknown,
): Admissibility {
  if (typeof component !== 'string' || !Object.hasOwn(ADMISSIBLE_OPERATIONS, component)) {
    return fail('component-not-renderable')
  }
  const patchComponent = component as PatchComponent
  const allowedOperations = ADMISSIBLE_OPERATIONS[patchComponent]
  if (!Array.isArray(allowedOperations) || typeof operation !== 'string'
    || !allowedOperations.includes(operation as PatchOperation)) {
    return fail('operation-not-allowlisted')
  }
  const patchOperation = operation as PatchOperation
  if (typeof content !== 'string' || content.trim().length === 0) return fail('empty-content')
  if (content.length > 4000) return fail('content-too-long')
  const normalized = normalize(content)
  if (DENY_PHRASES.some((pattern) => pattern.test(normalized))) return fail('denied-phrase')
  const badVariable = checkVariables(normalized)
  if (badVariable !== undefined) return fail(badVariable)

  if (patchComponent === 'system-prompt') {
    if (!PERSONA_SHAPE.test(normalized)) return fail('not-a-persona-statement')
  } else if (patchComponent === 'tool-guidance') {
    const code = checkToolOrder(content)
    if (code !== undefined) return fail(code)
  } else if (patchOperation === 'disable-row' || patchOperation === 'enable-row') {
    const code = checkRowId(content)
    if (code !== undefined) return fail(code)
  } else {
    const code = checkHarness2Config(content)
    if (code !== undefined) return fail(code)
  }

  return {
    ok: true,
    code: 'ok',
    spec: { component: patchComponent, operation: patchOperation, content },
  }
}

/** Whether the in-probe persona mechanism can carry this edit (prefix only). */
export function isSimulableInProbe(spec: { readonly component: string; readonly operation: string }): boolean {
  return spec.component === 'system-prompt' && spec.operation === 'set-persona-prefix'
}

/** System-prompt section name reserved for the persona prefix. */
export const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'
