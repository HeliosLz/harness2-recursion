/**
 * harness2-apply — Round-6 PR-3 offline profile-patch applier.
 *
 * Standalone tool: does NOT import task/meta plugin source. It consumes the
 * frozen ledger v3 + `harness2-edit/v1` sidecars and writes only a managed
 * block in one non-desktop profile's `cordis.patch.yml`.
 */
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import {
  appendFile, copyFile, mkdir, open, readFile, readdir, readlink, rename, rm,
  stat, symlink, writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import YAML from 'yaml'

export const APPLY_SCHEMA = 'harness2-apply/v1'
export const EDIT_SCHEMA = 'harness2-edit/v1'
export const LEDGER_VERSION = 'harness2-ledger/v3'
export const MAX_EDIT_CONTENT = 4000
export const DESKTOP_PROFILE = 'desktop'
export const MANAGED_START = '# >>> harness2:managed'
export const MANAGED_END = '# <<< harness2:managed'

const CANDIDATE_ID_RE = /^cand-[0-9a-f]{16}$/
const SHA_RE = /^sha256:[0-9a-f]{64}$/
const PROFILE_RE = /^[A-Za-z0-9._-]+$/

export class ApplyError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'ApplyError'
    this.code = code
    this.details = details
  }
}

export function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
export function hashOf(value) { return `sha256:${sha256Hex(value)}` }

export function resolveDshHome(homeOverride) {
  return path.resolve(homeOverride ?? process.env.DSH_HOME ?? path.join(homedir(), '.dsh'))
}

export function assertProfileName(profile) {
  if (typeof profile !== 'string' || !PROFILE_RE.test(profile)) {
    throw new ApplyError('invalid-profile', `invalid profile name: ${String(profile)}`)
  }
  if (profile === DESKTOP_PROFILE) {
    throw new ApplyError('desktop-profile-refused', 'the desktop profile is managed by the app; refusing to write it')
  }
  return profile
}

export function profilePaths(dshHome, profile) {
  assertProfileName(profile)
  const profileDir = path.join(dshHome, 'profiles', profile)
  return {
    dshHome,
    profile,
    profileDir,
    patchPath: path.join(profileDir, 'cordis.patch.yml'),
    packagePath: path.join(profileDir, 'package.json'),
  }
}

export async function fileHash(file) {
  return hashOf(await readFile(file, 'utf8'))
}

export async function atomicWrite(file, text, mode = 0o600) {
  const directory = path.dirname(file)
  await mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `.tmp-${randomUUID()}`)
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, file)
  const dirHandle = await open(directory, 'r')
  try { await dirHandle.sync() } finally { await dirHandle.close() }
}

export async function readTextOrNull(file) {
  try { return await readFile(file, 'utf8') } catch { return null }
}

export async function withFileLock(lockPath, fn) {
  await mkdir(path.dirname(lockPath), { recursive: true })
  let handle
  try {
    handle = await open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
  } catch (error) {
    if (error && error.code === 'EEXIST') throw new ApplyError('apply-locked', `lock exists: ${lockPath}`)
    throw error
  }
  try {
    await handle.writeFile(`${process.pid}\n`, 'utf8')
    return await fn()
  } finally {
    await handle.close().catch(() => undefined)
    await rm(lockPath, { force: true }).catch(() => undefined)
  }
}

export function runDsh(cliPath, args, options = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: options.dshHome, ...(options.env ?? {}) },
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    status: result.status,
    signal: result.signal,
    timedOut: result.error?.code === 'ETIMEDOUT',
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/* ── edit bodies ─────────────────────────────────────────────────────────── */

export function deriveCandidateId(candidateType, component, content) {
  return `cand-${sha256Hex(`${candidateType}:${component}:${content}`).slice(0, 16)}`
}

export function rendererKindFor(component, operation) {
  if (component === 'system-prompt' && operation === 'set-persona-prefix') return 'persona-prefix'
  if (component === 'system-prompt' && operation === 'set-persona-suffix') return 'persona-suffix'
  if (component === 'tool-guidance' && operation === 'set-tool-order') return 'tool-order'
  if (component === 'plugins' && (operation === 'disable-row' || operation === 'enable-row')) return 'row-enabled'
  if (component === 'plugins' && operation === 'set-harness2-config') return 'harness2-config'
  return 'unrenderable'
}

export function validateEditBody(value) {
  const errors = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ['body must be an object']
  const required = ['schema', 'contentHash', 'candidateId', 'candidateType', 'component', 'operation', 'content', 'renderer', 'taskId', 'cycleId', 'createdAt']
  if (Object.keys(value).length !== required.length || required.some((key) => !Object.hasOwn(value, key))) {
    return ['body has an unexpected field set']
  }
  if (value.schema !== EDIT_SCHEMA) errors.push('schema must be harness2-edit/v1')
  if (typeof value.contentHash !== 'string' || !SHA_RE.test(value.contentHash)) errors.push('contentHash must be sha256:<64 hex>')
  if (typeof value.candidateId !== 'string' || !CANDIDATE_ID_RE.test(value.candidateId)) errors.push('candidateId must be cand-<16 hex>')
  if (value.candidateType !== 'invariant' && value.candidateType !== 'domain') errors.push('candidateType must be invariant | domain')
  if (typeof value.component !== 'string' || value.component.length === 0) errors.push('component is required')
  if (typeof value.operation !== 'string' || value.operation.length === 0) errors.push('operation is required')
  if (typeof value.content !== 'string' || value.content.length === 0 || value.content.length > MAX_EDIT_CONTENT) errors.push('content must be 1..4000 chars')
  if (value.renderer === null || typeof value.renderer !== 'object' || Array.isArray(value.renderer)) errors.push('renderer must be an object')
  if (typeof value.taskId !== 'string' || value.taskId.length === 0) errors.push('taskId is required')
  if (typeof value.cycleId !== 'string' || value.cycleId.length === 0) errors.push('cycleId is required')
  if (typeof value.createdAt !== 'string' || value.createdAt.length === 0) errors.push('createdAt is required')
  if (errors.length === 0) {
    if (hashOf(value.content) !== value.contentHash) errors.push('contentHash does not equal sha256(content)')
    if (value.candidateId !== deriveCandidateId(value.candidateType, value.component, value.content)) {
      errors.push('candidateId does not match the derived candidate id')
    }
  }
  return errors
}

export async function readBody(editsDir, contentHash) {
  if (typeof contentHash !== 'string' || !SHA_RE.test(contentHash)) {
    return { ok: false, code: 'invalid-hash', error: 'edit contentHash is not sha256:<64 hex>' }
  }
  const file = path.join(editsDir, `${contentHash.slice(7)}.json`)
  let text
  try { text = await readFile(file, 'utf8') } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: false, code: 'legacy-no-body', path: file }
    return { ok: false, code: 'read-failed', error: String(error), path: file }
  }
  let body
  try { body = JSON.parse(text) } catch (error) { return { ok: false, code: 'invalid-body', error: String(error), path: file } }
  const errors = validateEditBody(body)
  if (errors.length > 0) return { ok: false, code: 'invalid-body', error: errors.join('; '), path: file }
  if (body.contentHash !== contentHash) return { ok: false, code: 'hash-mismatch', error: 'body hash differs from applied edit', path: file }
  return { ok: true, body, path: file }
}

/* ── ledger ──────────────────────────────────────────────────────────────── */

export async function readAppliedRecord(ledgerPath, cycleId) {
  let text
  try { text = await readFile(ledgerPath, 'utf8') } catch (error) {
    throw new ApplyError('ledger-unreadable', `cannot read ledger: ${ledgerPath}`, String(error))
  }
  let selected
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record?.version !== LEDGER_VERSION || record?.event !== 'compose/applied') continue
    if (cycleId !== undefined && record?.payload?.cycleId !== cycleId) continue
    selected = record
  }
  if (selected === undefined) throw new ApplyError('applied-record-missing', 'no compose/applied record found for the requested cycle')
  const edits = selected.payload?.appliedEdits
  if (!Array.isArray(edits) || edits.length === 0) throw new ApplyError('applied-edits-missing', 'compose/applied record has no appliedEdits')
  return selected
}

/* ── dump rows ───────────────────────────────────────────────────────────── */

export function parseDumpRows(dumpText) {
  let parsed
  try { parsed = YAML.parse(dumpText, { logLevel: 'silent' }) } catch (error) {
    throw new ApplyError('dump-parse-failed', `cannot parse --dump-config output: ${error.message}`)
  }
  if (!Array.isArray(parsed)) throw new ApplyError('dump-shape-invalid', '--dump-config did not produce a YAML sequence')
  const rows = new Map()
  for (const row of parsed) {
    if (row !== null && typeof row === 'object' && typeof row.id === 'string') rows.set(row.id, row)
  }
  return rows
}

export function assertDumpHealthy(dumpText) {
  if (dumpText.includes('skipping profile bundle')) {
    throw new ApplyError('preflight-skipped-bundle', 'composed profile skipped a bundle; refusing to apply')
  }
}

/* ── renderer ────────────────────────────────────────────────────────────── */

const TUNABLE_KEYS = new Set(['triggerThreshold', 'repeatedFailureWindow', 'cooldownMs', 'trajectoryWindow'])
const FORBIDDEN_CONFIG_KEYS = new Set(['metricWeights', 'gatePolicy', 'observeOnly', 'ledgerPath', 'experiencePath', 'proposeModel', 'llmReflectionModel', 'editsDir', 'maxAppliedEdits', 'controlReplicates', 'probeTimeoutMs', 'maxCostPerCycle'])
const FORBIDDEN_ROWS = [/^hmr$/, /^plugin-manager$/, /^harness2-/, /^system-prompt$/, /^tools$/, /^llm$/, /^session$/, /^agent-loop$/]

function rowForEdit(edit, body, rows) {
  const kind = rendererKindFor(edit.component, edit.operation)
  if (kind === 'unrenderable') throw new ApplyError('unrenderable', `no PR-3 renderer for ${edit.component}/${edit.operation}`)
  if (kind === 'persona-prefix' || kind === 'persona-suffix') {
    const row = rows.get('system-prompt')
    if (row === undefined) throw new ApplyError('row-missing', 'system-prompt row is absent from the composed dump')
    const config = { ...(row.config ?? {}) }
    config[kind === 'persona-prefix' ? 'personaPrefix' : 'personaSuffix'] = body.content
    return { kind, rowId: 'system-prompt', row, config, smokeRequired: kind === 'persona-suffix' }
  }
  if (kind === 'tool-order') {
    let order
    try { order = JSON.parse(body.content) } catch { throw new ApplyError('tool-order-invalid', 'toolOrder body is not valid JSON') }
    if (!Array.isArray(order) || order.some((item) => typeof item !== 'string') || !order.includes('<unlisted-tools>')) {
      throw new ApplyError('tool-order-invalid', 'toolOrder must be a JSON array containing <unlisted-tools>')
    }
    const row = rows.get('system-prompt')
    if (row === undefined) throw new ApplyError('row-missing', 'system-prompt row is absent from the composed dump')
    return { kind, rowId: 'system-prompt', row, config: { ...(row.config ?? {}), toolOrder: order }, smokeRequired: true }
  }
  if (kind === 'row-enabled') {
    const rowId = body.content.trim()
    if (!/^[a-z0-9][a-z0-9-]*$/.test(rowId) || FORBIDDEN_ROWS.some((pattern) => pattern.test(rowId))) {
      throw new ApplyError('row-not-allowed', `row ${rowId} may not be toggled by the applier`)
    }
    const row = rows.get(rowId)
    if (row === undefined) throw new ApplyError('row-missing', `row ${rowId} is absent from the composed dump`)
    const disabled = edit.operation === 'disable-row'
    return { kind, rowId, row, disabled, smokeRequired: false }
  }
  // harness2-config: content is {"key":..., "value":...}; target the task row.
  let spec
  try { spec = JSON.parse(body.content) } catch { throw new ApplyError('config-invalid', 'harness2 config body is not valid JSON') }
  if (spec === null || typeof spec !== 'object' || typeof spec.key !== 'string') throw new ApplyError('config-invalid', 'config body must be {"key","value"}')
  if (FORBIDDEN_CONFIG_KEYS.has(spec.key) || !TUNABLE_KEYS.has(spec.key)) throw new ApplyError('config-key-not-allowed', `config key ${spec.key} may not be tuned`)
  const rowId = 'harness2-task-recursion'
  const row = rows.get(rowId)
  if (row === undefined) throw new ApplyError('row-missing', `${rowId} row is absent from the composed dump`)
  return { kind, rowId, row, config: { ...(row.config ?? {}), [spec.key]: spec.value }, smokeRequired: false }
}

function mergeEntries(entries) {
  const merged = new Map()
  for (const entry of entries) {
    const existing = merged.get(entry.rowId)
    if (existing === undefined) { merged.set(entry.rowId, { ...entry }); continue }
    if (existing.config !== undefined && entry.config !== undefined) {
      for (const [key, value] of Object.entries(entry.config)) {
        if (existing.config[key] !== undefined && existing.config[key] !== value) {
          throw new ApplyError('conflicting-edits', `two applied edits conflict on ${entry.rowId}.${key}`)
        }
        existing.config[key] = value
      }
      existing.smokeRequired = existing.smokeRequired || entry.smokeRequired
    } else if (existing.disabled !== undefined && entry.disabled !== undefined) {
      if (existing.disabled !== entry.disabled) throw new ApplyError('conflicting-edits', `conflicting row toggle for ${entry.rowId}`)
    } else {
      throw new ApplyError('conflicting-edits', `cannot mix config and disabled edits for ${entry.rowId}`)
    }
  }
  return [...merged.values()]
}

function rowsToPatch(entries) {
  return entries.map((entry) => {
    const row = { id: entry.rowId }
    if (typeof entry.row?.name === 'string') row.name = entry.row.name
    if (entry.disabled !== undefined) row.disabled = entry.disabled
    else row.config = entry.config
    return row
  })
}

export function applyManagedBlock(patchText, revId, renderDigest, entries) {
  const yamlRows = YAML.stringify(rowsToPatch(entries), { lineWidth: 0 })
  const block = `${MANAGED_START} rev ${revId} ${renderDigest}\n${yamlRows}${MANAGED_END}\n`
  const startPattern = /^# >>> harness2:managed[^\n]*\n/m
  const startMatch = startPattern.exec(patchText)
  let next
  let outside
  if (startMatch === null) {
    const trimmed = patchText.trim()
    const emptySequence = /^(?:[ \t]*\r?\n)*[ \t]*\[\][ \t]*(?:\r?\n)?$/.test(patchText)
    if (trimmed.length === 0 || emptySequence) {
      next = block
      outside = ''
    } else {
      // A profile patch may be comments followed by the empty flow sequence
      // `[]`. Replace that token in place so comments survive and the result is
      // still a single YAML sequence.
      const emptyMatch = /^([ \t]*)\[\][ \t]*(\r?\n)?/m.exec(patchText)
      if (emptyMatch !== null) {
        const start = emptyMatch.index
        const end = start + emptyMatch[0].length
        next = `${patchText.slice(0, start)}${block}${patchText.slice(end)}`
        outside = `${patchText.slice(0, start)}${patchText.slice(end)}`
      } else {
        const separator = patchText.endsWith('\n') ? '' : '\n'
        next = `${patchText}${separator}${block}`
        outside = patchText
      }
    }
  } else {
    const endPattern = /^# <<< harness2:managed[^\n]*\n?/m
    const afterStart = startMatch.index + startMatch[0].length
    const endMatch = endPattern.exec(patchText.slice(afterStart))
    if (endMatch === null) throw new ApplyError('managed-block-unbalanced', 'managed block has a start marker but no end marker')
    const endIndex = afterStart + endMatch.index + endMatch[0].length
    outside = `${patchText.slice(0, startMatch.index)}${patchText.slice(endIndex)}`
    next = `${patchText.slice(0, startMatch.index)}${block}${patchText.slice(endIndex)}`
  }
  // Round-trip guard: outside bytes are preserved and re-parse as an array.
  let parsed
  try { parsed = YAML.parse(next, { logLevel: 'silent' }) } catch (error) {
    throw new ApplyError('patch-not-round-trippable', `rendered patch does not parse: ${error.message}`)
  }
  if (!Array.isArray(parsed)) throw new ApplyError('patch-not-round-trippable', 'rendered patch is not a YAML sequence')
  const outsideTrimmed = outside.trim()
  if (outsideTrimmed.length > 0 && outsideTrimmed !== '[]') {
    try { YAML.parse(outside, { logLevel: 'silent' }) } catch (error) {
      throw new ApplyError('patch-not-round-trippable', `outside managed block is not YAML: ${error.message}`)
    }
  }
  return next
}

/* ── revision storage ────────────────────────────────────────────────────── */

export function applierRoot(editsDir) {
  return path.join(path.dirname(editsDir), 'apply')
}

export async function revisionDir(editsDir, revId) {
  if (!/^rev-[0-9a-f]{12}$/.test(revId)) throw new ApplyError('invalid-revision', `invalid revision id: ${revId}`)
  return path.join(applierRoot(editsDir), 'revisions', revId)
}

export async function loadRevision(editsDir, revId) {
  const dir = await revisionDir(editsDir, revId)
  const manifestText = await readTextOrNull(path.join(dir, 'manifest.json'))
  if (manifestText === null) throw new ApplyError('revision-missing', `revision ${revId} does not exist under ${dir}`)
  return { dir, manifest: JSON.parse(manifestText) }
}

export async function writeRevisionFiles(dir, { manifest, patch, plan }) {
  await mkdir(path.join(dir, 'backup'), { recursive: true })
  await atomicWrite(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await atomicWrite(path.join(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`)
  await atomicWrite(path.join(dir, 'patch.yml'), patch)
}

export async function appendJournal(dshHome, entry) {
  const dir = path.join(dshHome, 'apply')
  await mkdir(dir, { recursive: true })
  await appendFile(path.join(dir, 'journal.jsonl'), `${JSON.stringify({ schema: APPLY_SCHEMA, ...entry })}\n`, 'utf8')
}

/* ── plan ────────────────────────────────────────────────────────────────── */

export async function planRevision(options) {
  const {
    dshHome, profile, ledgerPath, editsDir: configuredEditsDir, cycleId,
    cliPath, allowBodyMetadataMismatch = false,
  } = options
  const paths = profilePaths(dshHome, profile)
  await stat(paths.profileDir).catch(() => { throw new ApplyError('profile-missing', `profile directory missing: ${paths.profileDir}`) })
  const editsDir = path.resolve(configuredEditsDir ?? path.join(path.dirname(ledgerPath), 'edits'))
  const record = await readAppliedRecord(ledgerPath, cycleId)
  const appliedEdits = record.payload.appliedEdits
  const bodies = []
  const metadataMismatch = []
  for (const edit of appliedEdits) {
    const bodyResult = await readBody(editsDir, edit.contentHash)
    if (!bodyResult.ok) {
      throw new ApplyError('edit-body-missing', `cannot plan: body ${edit.contentHash} is ${bodyResult.code}`, bodyResult)
    }
    const body = bodyResult.body
    if (body.candidateId !== edit.candidateId || body.component !== edit.component || body.operation !== edit.operation) {
      metadataMismatch.push({ contentHash: edit.contentHash })
    }
    bodies.push(body)
  }
  if (metadataMismatch.length > 0 && !allowBodyMetadataMismatch) {
    throw new ApplyError('body-metadata-mismatch', 'edit body metadata differs from appliedEdits; refusing to plan', { metadataMismatch })
  }
  const dump = runDsh(cliPath, ['--profile', profile, '--dump-config'], { dshHome })
  if (dump.status !== 0) throw new ApplyError('dump-failed', `--dump-config failed: ${dump.stderr.trim()}`)
  assertDumpHealthy(dump.stdout)
  const rows = parseDumpRows(dump.stdout)
  const entries = mergeEntries(bodies.map((body, index) => rowForEdit(appliedEdits[index], body, rows)))
  const patchBefore = (await readTextOrNull(paths.patchPath)) ?? '[]\n'
  const revId = `rev-${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const renderDigest = hashOf(`${record.id}\n${JSON.stringify(bodies.map((body) => body.contentHash))}\n${JSON.stringify(rowsToPatch(entries))}`)
  const patchAfter = applyManagedBlock(patchBefore, revId, renderDigest, entries)
  const basePatchHash = hashOf(patchBefore)
  const renderedPatchHash = hashOf(patchAfter)
  const planToken = hashOf(JSON.stringify({
    revId, basePatchHash, renderedPatchHash, ledgerId: record.id,
    contentHashes: bodies.map((body) => body.contentHash), metadataMismatch,
  }))
  const smokeRequired = entries.some((entry) => entry.smokeRequired)
  const manifest = {
    schema: APPLY_SCHEMA, kind: 'manifest', revId, profile,
    ledgerPath, ledgerId: record.id, cycleId: record.payload.cycleId,
    appliedEdits, contentHashes: bodies.map((body) => body.contentHash),
    renderer: entries.map((entry) => ({ kind: entry.kind, rowId: entry.rowId })),
    basePatchHash, renderedPatchHash, renderDigest, planToken,
    metadataMismatch, metadataMismatchAllowed: allowBodyMetadataMismatch,
    smokeRequired, evaluation: 'not-run', createdAt: new Date().toISOString(),
  }
  const plan = {
    schema: APPLY_SCHEMA, revId, profile, patchBefore, patchAfter,
    entries: entries.map((entry) => ({
      kind: entry.kind, rowId: entry.rowId,
      ...(entry.disabled === undefined ? {} : { disabled: entry.disabled }),
      ...(entry.config === undefined ? {} : { config: entry.config }),
    })),
  }
  const dir = await revisionDir(editsDir, revId)
  await writeRevisionFiles(dir, { manifest, patch: patchAfter, plan })
  await rememberRevision(dshHome, { revId, editsDir, profile, ledgerPath })
  return { revId, dir, manifest, entries, smokeRequired }
}

/* ── preflight / verify helpers ──────────────────────────────────────────── */

export async function copyProfileResolvedLinks(source, destination) {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isSymbolicLink()) {
      const target = await readlink(from)
      const absolute = path.isAbsolute(target) ? target : path.resolve(source, target)
      await symlink(absolute, to)
    } else if (entry.isDirectory()) {
      await copyProfileResolvedLinks(from, to)
    } else {
      await copyFile(from, to)
    }
  }
}

function assertRenderedValues(dumpText, entries) {
  const rows = parseDumpRows(dumpText)
  for (const entry of entries) {
    const row = rows.get(entry.rowId)
    if (row === undefined) throw new ApplyError('preflight-value-missing', `row ${entry.rowId} missing after patch`)
    if (entry.disabled !== undefined) {
      if (row.disabled !== entry.disabled) throw new ApplyError('preflight-value-mismatch', `row ${entry.rowId} disabled is not ${entry.disabled}`)
      continue
    }
    const config = row.config ?? {}
    for (const [key, value] of Object.entries(entry.config)) {
      if (JSON.stringify(config[key]) !== JSON.stringify(value)) {
        throw new ApplyError('preflight-value-mismatch', `row ${entry.rowId}.${key} not applied`)
      }
    }
  }
}

function runSmoke(smokeCmd, { dshHome, profile }) {
  if (typeof smokeCmd !== 'string' || smokeCmd.trim().length === 0) {
    throw new ApplyError('smoke-required', 'this revision requires --smoke-cmd (toolOrder / persona suffix)')
  }
  const result = spawnSync(smokeCmd, {
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: dshHome, HARNESS2_PROFILE: profile },
    timeout: 120_000,
  })
  if (result.status !== 0) throw new ApplyError('smoke-failed', `smoke command failed (${result.status}): ${(result.stderr ?? '').trim()}`)
}

async function dumpForProfile({ dshHome, profile, cliPath }) {
  const dump = runDsh(cliPath, ['--profile', profile, '--dump-config'], { dshHome })
  if (dump.status !== 0) throw new ApplyError('dump-failed', `--dump-config failed: ${dump.stderr.trim()}`)
  assertDumpHealthy(dump.stdout)
  return dump.stdout
}

export async function preflightRevision(options) {
  const { dshHome, editsDir, revId, cliPath, smokeCmd } = options
  const { dir, manifest } = await loadRevision(editsDir, revId)
  if (manifest.metadataMismatch.length > 0 && !manifest.metadataMismatchAllowed) {
    throw new ApplyError('body-metadata-mismatch', 'revision has unapproved metadata mismatch')
  }
  const patch = await readFile(path.join(dir, 'patch.yml'), 'utf8')
  const tempHome = path.join(applierRoot(editsDir), 'preflight', `${revId}-${randomUUID().slice(0, 8)}`)
  const paths = profilePaths(dshHome, manifest.profile)
  const tempProfileDir = path.join(tempHome, 'profiles', manifest.profile)
  try {
    await copyProfileResolvedLinks(paths.profileDir, tempProfileDir)
    await writeFile(path.join(tempProfileDir, 'cordis.patch.yml'), patch, 'utf8')
    const dumpText = await dumpForProfile({ dshHome: tempHome, profile: manifest.profile, cliPath })
    // Entries are re-derived from the manifest renderer + patch is the plan output;
    // use plan.json for the expected values.
    const plan = JSON.parse(await readFile(path.join(dir, 'plan.json'), 'utf8'))
    const entries = plan.entries.map((entry) => ({
      rowId: entry.rowId,
      ...(entry.disabled === undefined ? {} : { disabled: entry.disabled }),
      ...(entry.config === undefined ? {} : { config: entry.config }),
    }))
    assertRenderedValues(dumpText, entries)
    if (manifest.smokeRequired) runSmoke(smokeCmd, { dshHome: tempHome, profile: manifest.profile })
    const result = {
      schema: APPLY_SCHEMA, revId, ok: true, renderedPatchHash: manifest.renderedPatchHash,
      basePatchHash: manifest.basePatchHash, checkedAt: new Date().toISOString(),
      dumpHasSkippingBundle: false, smokeRequired: manifest.smokeRequired,
    }
    await atomicWrite(path.join(dir, 'preflight.json'), `${JSON.stringify(result, null, 2)}\n`)
    return result
  } finally {
    await rm(tempHome, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function verifyRevision(options) {
  const { dshHome, editsDir, revId, cliPath, smokeCmd } = options
  const { dir, manifest } = await loadRevision(editsDir, revId)
  const paths = profilePaths(dshHome, manifest.profile)
  const currentHash = await fileHash(paths.patchPath)
  if (currentHash !== manifest.renderedPatchHash) {
    throw new ApplyError('patch-not-applied', `current patch hash ${currentHash} does not match revision`)
  }
  const dumpText = await dumpForProfile({ dshHome, profile: manifest.profile, cliPath })
  const plan = JSON.parse(await readFile(path.join(dir, 'plan.json'), 'utf8'))
  const entries = plan.entries.map((entry) => ({
    rowId: entry.rowId,
    ...(entry.disabled === undefined ? {} : { disabled: entry.disabled }),
    ...(entry.config === undefined ? {} : { config: entry.config }),
  }))
  assertRenderedValues(dumpText, entries)
  if (manifest.smokeRequired) runSmoke(smokeCmd, { dshHome, profile: manifest.profile })
  const result = { schema: APPLY_SCHEMA, revId, ok: true, checkedAt: new Date().toISOString() }
  await atomicWrite(path.join(dir, 'verify.json'), `${JSON.stringify(result, null, 2)}\n`)
  return result
}

/* ── apply / rollback / status ───────────────────────────────────────────── */

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function evalReportHash(report) {
  const { reportHash: _ignored, ...rest } = report
  return hashOf(stableStringify(rest))
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const DEFAULT_EVAL_PREREG = path.join(REPO_ROOT, 'e2e', 'holdout', 'preregistration.json')
const DEFAULT_EVAL_TASKS = path.join(REPO_ROOT, 'e2e', 'holdout', 'tasks.jsonl')

/** Validate a PR-4 evaluation report against the revision/manifest. */
export async function validateEvaluationReport(reportFile, manifest, options = {}) {
  let report
  try { report = JSON.parse(await readFile(reportFile, 'utf8')) } catch (error) {
    throw new ApplyError('evaluation-invalid', `cannot read evaluation report: ${error.message}`)
  }
  if (report?.schema !== 'harness2-eval/v1') throw new ApplyError('evaluation-invalid', 'report schema must be harness2-eval/v1')
  if (report.verdict !== 'accept') throw new ApplyError('evaluation-rejected', `evaluation verdict is ${String(report.verdict)}; only accept may apply`)
  if (report.revisionId !== manifest.revId) throw new ApplyError('evaluation-mismatch', 'evaluation revisionId does not match manifest')
  if (report.planToken !== manifest.planToken) throw new ApplyError('evaluation-mismatch', 'evaluation planToken does not match manifest')
  if (!manifest.contentHashes.includes(report.contentHash)) throw new ApplyError('evaluation-mismatch', 'evaluation contentHash does not match manifest')
  if (report.reportHash !== evalReportHash(report)) throw new ApplyError('evaluation-invalid', 'reportHash does not match report content')
  for (const key of ['batchId', 'preregHash', 'tasksHash']) {
    if (typeof report[key] !== 'string' || report[key].length === 0) throw new ApplyError('evaluation-invalid', `report missing ${key}`)
  }
  const preregFile = options.preregFile ?? DEFAULT_EVAL_PREREG
  const tasksFile = options.tasksFile ?? DEFAULT_EVAL_TASKS
  const [preregHash, tasksHash] = await Promise.all([hashOf(await readFile(preregFile, 'utf8')), hashOf(await readFile(tasksFile, 'utf8'))])
  if (report.preregHash !== preregHash) throw new ApplyError('evaluation-mismatch', 'preregHash does not match the registered preregistration')
  if (report.tasksHash !== tasksHash) throw new ApplyError('evaluation-mismatch', 'tasksHash does not match the holdout tasks file')
  return report
}

export async function applyRevision(options) {
  const { dshHome, editsDir, revId, token, yes = false, allowUnevaluated = false, evaluation, cliPath } = options
  const { dir, manifest } = await loadRevision(editsDir, revId)
  const paths = profilePaths(dshHome, manifest.profile)
  if (manifest.metadataMismatch.length > 0) throw new ApplyError('body-metadata-mismatch', 'refusing to apply a revision with metadata mismatch')
  if (token !== manifest.planToken) throw new ApplyError('token-mismatch', 'plan token does not match the revision')
  const preflightText = await readTextOrNull(path.join(dir, 'preflight.json'))
  if (preflightText === null) throw new ApplyError('preflight-required', 'run preflight before apply')
  const preflight = JSON.parse(preflightText)
  if (preflight.ok !== true || preflight.basePatchHash !== manifest.basePatchHash || preflight.renderedPatchHash !== manifest.renderedPatchHash) {
    throw new ApplyError('preflight-stale', 'preflight does not match this revision')
  }
  if (!yes) throw new ApplyError('confirmation-required', 'apply requires --yes after human review')
  let evaluationMode
  let evaluationMeta
  if (typeof evaluation === 'string' && evaluation.length > 0) {
    const report = await validateEvaluationReport(evaluation, manifest, options)
    evaluationMode = 'accept'
    evaluationMeta = { evaluationReportHash: report.reportHash, verdict: report.verdict, batchId: report.batchId }
  } else {
    if (!allowUnevaluated) throw new ApplyError('evaluation-required', 'apply requires --evaluation <report.json> with verdict accept')
    if (process.env.HARNESS2_ALLOW_UNEVALUATED !== '1') {
      throw new ApplyError('evaluation-force-env-required', '--allow-unevaluated requires HARNESS2_ALLOW_UNEVALUATED=1 and is for controlled tests only')
    }
    evaluationMode = 'forced-unevaluated'
    evaluationMeta = { evaluationReportHash: null, verdict: 'forced-unevaluated', batchId: null }
  }
  const currentText = (await readTextOrNull(paths.patchPath)) ?? '[]\n'
  if (hashOf(currentText) !== manifest.basePatchHash) {
    throw new ApplyError('base-patch-changed', 'target patch changed since plan; re-plan before applying')
  }
  const patch = await readFile(path.join(dir, 'patch.yml'), 'utf8')
  if (hashOf(patch) !== manifest.renderedPatchHash) throw new ApplyError('revision-tampered', 'revision patch hash mismatch')
  await mkdir(path.dirname(path.join(dir, 'backup', 'cordis.patch.yml')), { recursive: true })
  await copyFile(paths.patchPath, path.join(dir, 'backup', 'cordis.patch.yml')).catch(async () => {
    await writeFile(path.join(dir, 'backup', 'cordis.patch.yml'), currentText, 'utf8')
  })
  const lockPath = path.join(paths.profileDir, '.harness2-apply.lock')
  await withFileLock(lockPath, async () => {
    await atomicWrite(paths.patchPath, patch)
  })
  const readback = await fileHash(paths.patchPath)
  if (readback !== manifest.renderedPatchHash) {
    await atomicWrite(paths.patchPath, currentText)
    throw new ApplyError('apply-verify-failed', 'readback hash mismatch; restored the base patch')
  }
  const dumpText = await dumpForProfile({ dshHome, profile: manifest.profile, cliPath }).catch(() => '')
  const hmrRow = dumpText.length > 0 ? parseDumpRows(dumpText).get('hmr') : undefined
  const reload = hmrRow !== undefined && hmrRow.disabled !== true ? 'hmr-pending-human-confirm' : 'restart-required'
  const active = {
    schema: APPLY_SCHEMA, kind: 'active', revisionId: revId, profile: manifest.profile,
    basePatchHash: manifest.basePatchHash, renderedPatchHash: manifest.renderedPatchHash,
    reload, evaluation: evaluationMode, ...evaluationMeta, appliedAt: new Date().toISOString(),
  }
  await mkdir(path.join(dshHome, 'apply'), { recursive: true })
  await atomicWrite(path.join(dshHome, 'apply', 'active.json'), `${JSON.stringify(active, null, 2)}\n`)
  await appendJournal(dshHome, {
    kind: 'committed', revisionId: revId, profile: manifest.profile, cycleId: manifest.cycleId,
    basePatchHash: manifest.basePatchHash, renderedPatchHash: manifest.renderedPatchHash,
    reload, evaluation: evaluationMode, ...evaluationMeta, recordedAt: new Date().toISOString(),
  })
  await atomicWrite(path.join(dir, 'manifest.json'), `${JSON.stringify({
    ...manifest,
    application: { reload, evaluation: evaluationMode, ...evaluationMeta, appliedAt: new Date().toISOString() },
  }, null, 2)}\n`)
  return { revisionId: revId, reload, evaluation: evaluationMode, ...evaluationMeta }
}

export async function rollbackRevision(options) {
  const { dshHome, editsDir, revId, force = false } = options
  const { dir, manifest } = await loadRevision(editsDir, revId)
  const paths = profilePaths(dshHome, manifest.profile)
  const currentHash = await fileHash(paths.patchPath)
  if (currentHash === manifest.basePatchHash) {
    await appendJournal(dshHome, { kind: 'rolled-back', revisionId: revId, profile: manifest.profile, status: 'already-base', recordedAt: new Date().toISOString() })
    return { revisionId: revId, alreadyBase: true }
  }
  if (currentHash !== manifest.renderedPatchHash && !force) {
    throw new ApplyError('patch-modified', 'patch was modified after apply; rerun with --force to restore the backup')
  }
  const backup = await readFile(path.join(dir, 'backup', 'cordis.patch.yml'), 'utf8')
  if (hashOf(backup) !== manifest.basePatchHash) throw new ApplyError('backup-corrupt', 'backup does not hash to basePatchHash')
  await atomicWrite(paths.patchPath, backup)
  const restored = await fileHash(paths.patchPath)
  if (restored !== manifest.basePatchHash) throw new ApplyError('rollback-verify-failed', 'restored patch hash does not match basePatchHash')
  await mkdir(path.join(dshHome, 'apply'), { recursive: true })
  await atomicWrite(path.join(dshHome, 'apply', 'active.json'), `${JSON.stringify({ schema: APPLY_SCHEMA, kind: 'active', status: 'rolled-back', revisionId: revId, profile: manifest.profile, rolledBackAt: new Date().toISOString() }, null, 2)}\n`)
  await appendJournal(dshHome, { kind: 'rolled-back', revisionId: revId, profile: manifest.profile, restoredPatchHash: restored, recordedAt: new Date().toISOString() })
  return { revisionId: revId, restoredPatchHash: restored }
}

export async function rememberRevision(dshHome, entry) {
  const dir = path.join(dshHome, 'apply')
  await mkdir(dir, { recursive: true })
  await appendFile(path.join(dir, 'revindex.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8')
}

export async function findRevision(dshHome, revId) {
  const text = await readTextOrNull(path.join(dshHome, 'apply', 'revindex.jsonl'))
  if (text === null) return undefined
  let found
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const entry = JSON.parse(line)
      if (entry?.revId === revId && typeof entry.editsDir === 'string') found = entry
    } catch { /* ignore malformed index lines */ }
  }
  return found
}

export async function loadRevisionByIndex(dshHome, revId) {
  const entry = await findRevision(dshHome, revId)
  if (entry === undefined) throw new ApplyError('revision-missing', `revision ${revId} is not registered under ${path.join(dshHome, 'apply')}`)
  return { ...(await loadRevision(entry.editsDir, revId)), editsDir: entry.editsDir }
}

export async function statusReport({ dshHome, editsDir }) {
  const root = editsDir === undefined ? undefined : applierRoot(editsDir)
  const revisions = root === undefined ? [] : await readdir(path.join(root, 'revisions')).catch(() => [])
  const indexText = await readTextOrNull(path.join(dshHome, 'apply', 'revindex.jsonl'))
  const indexed = indexText === null ? [] : indexText.trim().split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
  const journalText = await readTextOrNull(path.join(dshHome, 'apply', 'journal.jsonl'))
  const journal = journalText === null ? [] : journalText.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const active = JSON.parse((await readTextOrNull(path.join(dshHome, 'apply', 'active.json'))) ?? 'null')
  return { revisions: revisions.sort(), indexed, active, journalTail: journal.slice(-10) }
}
