/**
 * PR-2: content-addressed edit-body sidecar.
 *
 * `compose/applied.appliedEdits` keeps only metadata (frozen contract). PR-3's
 * offline applier needs the exact Propose text, so bodies live here:
 * `<editsDir>/<sha256 hex>.json`, written before Probe and never inside the
 * ledger or EXPERIENCE.md.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'

import { isComponentName } from './constants.ts'

export const EDIT_BODY_SCHEMA = 'harness2-edit/v1'
export const DEFAULT_EDITS_DIR = 'edits'
export const MAX_EDIT_CONTENT = 4000
export const DEFAULT_EDIT_BODY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type RendererKind =
  | 'persona-prefix'
  | 'persona-suffix'
  | 'tool-order'
  | 'row-enabled'
  | 'harness2-config'
  | 'unrenderable'

export interface EditRenderer {
  readonly kind: RendererKind
  readonly hints: Readonly<Record<string, string>>
}

export interface EditBody {
  readonly schema: typeof EDIT_BODY_SCHEMA
  readonly contentHash: string
  readonly candidateId: string
  readonly candidateType: 'invariant' | 'domain'
  readonly component: string
  readonly operation: string
  readonly content: string
  readonly renderer: EditRenderer
  readonly taskId: string
  readonly cycleId: string
  readonly createdAt: string
}

export type EditBodyErrorCode =
  | 'legacy-no-body'
  | 'invalid-body'
  | 'hash-mismatch'
  | 'read-failed'
  | 'write-failed'
  | 'exists-different'

export interface EditBodyResult {
  readonly ok: boolean
  readonly body?: EditBody
  readonly code?: EditBodyErrorCode
  readonly error?: string
  readonly path?: string
  readonly written?: boolean
}

const RENDERER_KINDS: readonly RendererKind[] = [
  'persona-prefix', 'persona-suffix', 'tool-order', 'row-enabled', 'harness2-config', 'unrenderable',
]

const HINT_KEYS: Readonly<Record<RendererKind, readonly string[]>> = Object.freeze({
  'persona-prefix': [],
  'persona-suffix': [],
  'tool-order': [],
  'row-enabled': ['rowId'],
  'harness2-config': [],
  unrenderable: [],
})

/** Deterministic renderer kind for a component/operation pair. */
export function rendererKindFor(component: string, operation: string): RendererKind {
  if (component === 'system-prompt' && operation === 'set-persona-prefix') return 'persona-prefix'
  if (component === 'system-prompt' && operation === 'set-persona-suffix') return 'persona-suffix'
  if (component === 'tool-guidance' && operation === 'set-tool-order') return 'tool-order'
  if (component === 'plugins' && (operation === 'disable-row' || operation === 'enable-row')) return 'row-enabled'
  if (component === 'plugins' && operation === 'set-harness2-config') return 'harness2-config'
  return 'unrenderable'
}

/** Resolve an absolute path with the same rules as the plugin's ledgerPath. */
function resolveBasePath(value: string): string {
  if (path.isAbsolute(value)) return value
  const home = process.env.DSH_HOME?.trim()
  const base = home !== undefined && home.length > 0 ? path.join(home, 'harness2') : process.cwd()
  return path.resolve(base, value)
}

/**
 * `editsDir` config: non-empty is resolved like ledgerPath; empty derives
 * `<dirname(resolved ledgerPath)>/edits`.
 */
export function resolveEditsDir(editsDir: string, ledgerPath: string): string {
  const configured = editsDir.trim()
  if (configured.length > 0) return resolveBasePath(configured)
  const ledger = resolveBasePath(ledgerPath)
  return path.join(path.dirname(ledger), DEFAULT_EDITS_DIR)
}

function hashHex(contentHash: string): string | undefined {
  const match = /^sha256:([0-9a-f]{64})$/.exec(contentHash)
  return match?.[1]
}

/** Content-addressed file path; only the validated hex digest is used. */
export function editBodyPath(editsDir: string, contentHash: string): string {
  const hex = hashHex(contentHash)
  if (hex === undefined) throw new Error('edit body path requires sha256:<64 lowercase hex>')
  return path.join(editsDir, `${hex}.json`)
}

function sanitizeHints(
  kind: RendererKind,
  raw: unknown,
): { hints: Record<string, string>; ignored: string[] } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { hints: {}, ignored: [] }
  const allowed = HINT_KEYS[kind]
  const hints: Record<string, string> = {}
  const ignored: string[] = []
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.includes(key)) { ignored.push(key); continue }
    if (typeof value !== 'string') { ignored.push(key); continue }
    hints[key] = value.slice(0, 200)
  }
  return { hints, ignored }
}

/** Validate and normalize an `harness2-edit/v1` body. */
export function validateEditBody(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ['edit body must be an object']
  const record = value as Record<string, unknown>
  const required = [
    'schema', 'contentHash', 'candidateId', 'candidateType', 'component', 'operation',
    'content', 'renderer', 'taskId', 'cycleId', 'createdAt',
  ]
  const keys = Object.keys(record)
  if (keys.length !== required.length || required.some((key) => !Object.hasOwn(record, key))) {
    return ['edit body has an unexpected field set']
  }
  const errors: string[] = []
  if (record.schema !== EDIT_BODY_SCHEMA) errors.push('schema must be harness2-edit/v1')
  if (typeof record.contentHash !== 'string' || hashHex(record.contentHash) === undefined) {
    errors.push('contentHash must be sha256:<64 lowercase hex>')
  }
  if (typeof record.candidateId !== 'string' || record.candidateId.length === 0) errors.push('candidateId is required')
  if (record.candidateType !== 'invariant' && record.candidateType !== 'domain') errors.push('candidateType must be invariant | domain')
  if (!isComponentName(record.component)) errors.push('component is not a frozen component name')
  if (typeof record.operation !== 'string' || record.operation.length === 0) errors.push('operation is required')
  if (typeof record.content !== 'string' || record.content.length === 0 || record.content.length > MAX_EDIT_CONTENT) {
    errors.push(`content must be 1..${MAX_EDIT_CONTENT} characters`)
  }
  const renderer = record.renderer
  if (renderer === null || typeof renderer !== 'object' || Array.isArray(renderer)) {
    errors.push('renderer must be an object')
  } else {
    const rendererRecord = renderer as Record<string, unknown>
    if (!RENDERER_KINDS.includes(rendererRecord.kind as RendererKind)) errors.push('renderer.kind is not a known renderer')
    if (rendererRecord.hints === null || typeof rendererRecord.hints !== 'object' || Array.isArray(rendererRecord.hints)) {
      errors.push('renderer.hints must be an object')
    }
  }
  if (typeof record.taskId !== 'string' || record.taskId.length === 0) errors.push('taskId is required')
  if (typeof record.cycleId !== 'string' || record.cycleId.length === 0) errors.push('cycleId is required')
  if (typeof record.createdAt !== 'string' || record.createdAt.length === 0) errors.push('createdAt is required')
  if (errors.length === 0 && typeof record.content === 'string' && typeof record.contentHash === 'string') {
    const actual = `sha256:${createHash('sha256').update(record.content, 'utf8').digest('hex')}`
    if (actual !== record.contentHash) errors.push('contentHash does not equal sha256(content)')
  }
  return errors
}

function normalizeBody(
  body: EditBody,
  onError?: (code: string, details?: unknown) => void,
): EditBody {
  const kind = rendererKindFor(body.component, body.operation)
  const sanitized = sanitizeHints(kind, body.renderer.hints)
  if (sanitized.ignored.length > 0) {
    onError?.('renderer-hint-ignored', { kind, ignored: sanitized.ignored })
  }
  return {
    ...body,
    renderer: { kind, hints: sanitized.hints },
  }
}

function serializeBody(body: EditBody): string {
  return `${JSON.stringify(body, null, 2)}\n`
}

async function atomicWrite(file: string, text: string): Promise<void> {
  const directory = path.dirname(file)
  await mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `.tmp-${randomUUID()}`)
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, file)
  const dirHandle = await open(directory, 'r')
  try {
    await dirHandle.sync()
  } finally {
    await dirHandle.close()
  }
}

/**
 * Write one content-addressed body.
 *
 * Idempotent for the same content hash + content; a different existing file is
 * refused. The caller maps failures to `edit-store-write-failed`.
 */
export async function writeEditBody(
  body: EditBody,
  options: {
    readonly editsDir: string
    readonly onError?: (code: string, details?: unknown) => void
  },
): Promise<EditBodyResult> {
  const errors = validateEditBody(body)
  if (errors.length > 0) {
    return { ok: false, code: 'invalid-body', error: errors.join('; ') }
  }
  const normalized = normalizeBody(body, options.onError)
  const file = editBodyPath(options.editsDir, normalized.contentHash)
  const text = serializeBody(normalized)
  try {
    try {
      await stat(file)
      const existing = await readFile(file, 'utf8')
      const parsed: unknown = JSON.parse(existing)
      if (validateEditBody(parsed).length === 0
        && (parsed as EditBody).contentHash === normalized.contentHash
        && (parsed as EditBody).content === normalized.content) {
        return { ok: true, body: parsed as EditBody, path: file, written: false }
      }
      return { ok: false, code: 'exists-different', error: 'existing body differs', path: file }
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || (error as { code?: string }).code !== 'ENOENT') {
        throw error
      }
    }
    await atomicWrite(file, text)
    return { ok: true, body: normalized, path: file, written: true }
  } catch (error) {
    return {
      ok: false,
      code: 'write-failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Read + verify one body. Missing files are `legacy-no-body` (not an error). */
export async function readEditBody(
  editsDir: string,
  contentHash: string,
  options: { readonly onError?: (code: string, details?: unknown) => void } = {},
): Promise<EditBodyResult> {
  let file: string
  try {
    file = editBodyPath(editsDir, contentHash)
  } catch (error) {
    return { ok: false, code: 'invalid-body', error: error instanceof Error ? error.message : String(error) }
  }
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    const missing = typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
    return missing
      ? { ok: false, code: 'legacy-no-body', path: file }
      : { ok: false, code: 'read-failed', path: file, error: error instanceof Error ? error.message : String(error) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, code: 'invalid-body', path: file, error: error instanceof Error ? error.message : String(error) }
  }
  const errors = validateEditBody(parsed)
  if (errors.length > 0) {
    if (errors.some((error) => error.includes('contentHash does not equal'))) {
      options.onError?.('edit-body-hash-mismatch', {
        expected: contentHash,
        actual: (parsed as { contentHash?: unknown } | null)?.contentHash ?? null,
        path: file,
      })
      return { ok: false, code: 'hash-mismatch', path: file, error: errors.join('; ') }
    }
    return { ok: false, code: 'invalid-body', path: file, error: errors.join('; ') }
  }
  const body = parsed as EditBody
  if (body.contentHash !== contentHash) {
    options.onError?.('edit-body-hash-mismatch', { expected: contentHash, actual: body.contentHash, path: file })
    return { ok: false, code: 'hash-mismatch', path: file, error: 'contentHash mismatch' }
  }
  return { ok: true, body: normalizeBody(body, options.onError), path: file }
}

/** Verify bodies for the edits about to be applied. */
export async function verifyEditBodies(
  editsDir: string,
  candidates: readonly {
    readonly candidateId: string
    readonly edit: { readonly contentHash: string }
  }[],
  options: { readonly onError?: (code: string, details?: unknown) => void } = {},
): Promise<{ readonly ok: boolean; readonly missing: readonly string[]; readonly mismatched: readonly string[] }> {
  const missing: string[] = []
  const mismatched: string[] = []
  for (const candidate of candidates) {
    const result = await readEditBody(editsDir, candidate.edit.contentHash, options)
    if (!result.ok) {
      if (result.code === 'legacy-no-body') missing.push(candidate.edit.contentHash)
      else mismatched.push(candidate.edit.contentHash)
    }
  }
  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched }
}

export interface EditBodyGcOptions {
  readonly editsDir: string
  readonly ledgerPath: string
  readonly maxAgeMs?: number
  readonly now?: number
  readonly onError?: (code: string, details?: unknown) => void
}

export interface EditBodyGcStats {
  readonly ledgerMissing: boolean
  readonly scanned: number
  readonly deleted: number
  readonly kept: number
  readonly referenced: number
  readonly errors: number
}

function contentHashesInLedger(text: string): Set<string> {
  const hashes = new Set<string>()
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record === null || typeof record !== 'object') continue
    const typed = record as { event?: unknown; payload?: { appliedEdits?: unknown } }
    if (typed.event !== 'compose/applied') continue
    const edits = typed.payload?.appliedEdits
    if (!Array.isArray(edits)) continue
    for (const edit of edits) {
      if (edit !== null && typeof edit === 'object') {
        const hash = (edit as { contentHash?: unknown }).contentHash
        if (typeof hash === 'string' && hashHex(hash) !== undefined) hashes.add(hash)
      }
    }
  }
  return hashes
}

/**
 * Delete old, unreferenced bodies. Errors never throw; they are reported and
 * counted. A missing ledger skips deletion (safer than treating all as orphans).
 */
export async function gcEditBodies(options: EditBodyGcOptions): Promise<EditBodyGcStats> {
  const stats = { ledgerMissing: false, scanned: 0, deleted: 0, kept: 0, referenced: 0, errors: 0 }
  const onError = (code: string, details?: unknown): void => {
    stats.errors += 1
    options.onError?.(code, details)
  }
  let referenced = new Set<string>()
  try {
    const ledger = await readFile(options.ledgerPath, 'utf8')
    referenced = contentHashesInLedger(ledger)
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT') {
      return { ...stats, ledgerMissing: true }
    }
    onError('edit-store-gc-failed', { stage: 'ledger', error: error instanceof Error ? error.message : String(error) })
    return stats
  }
  let entries: string[]
  try {
    entries = await readdir(options.editsDir)
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT') return stats
    onError('edit-store-gc-failed', { stage: 'readdir', error: error instanceof Error ? error.message : String(error) })
    return stats
  }
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_EDIT_BODY_MAX_AGE_MS
  for (const entry of entries) {
    const match = /^([0-9a-f]{64})\.json$/.exec(entry)
    if (match === null) continue
    stats.scanned += 1
    const contentHash = `sha256:${match[1]}`
    if (referenced.has(contentHash)) {
      stats.referenced += 1
      stats.kept += 1
      continue
    }
    try {
      const info = await stat(path.join(options.editsDir, entry))
      if (now - info.mtimeMs < maxAgeMs) {
        stats.kept += 1
        continue
      }
      await rm(path.join(options.editsDir, entry))
      stats.deleted += 1
    } catch (error) {
      onError('edit-store-gc-failed', { stage: 'entry', entry, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return stats
}
