/**
 * Minimal fake dsh CLI for unit tests of harness2-apply.
 *
 * `--profile <p> --dump-config`: reads $DSH_HOME/profiles/<p>/cordis.patch.yml,
 * applies its rows over a base dump, and prints the composed YAML.
 * Env FAKE_SKIP_BUNDLE=1 prints the "skipping profile bundle" warning.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'

const args = process.argv.slice(2)
const profileIndex = args.indexOf('--profile')
const profile = profileIndex >= 0 ? args[profileIndex + 1] : 'test'
if (!args.includes('--dump-config')) {
  process.stderr.write('fake-dsh: only --dump-config is implemented\n')
  process.exit(1)
}
const home = process.env.DSH_HOME
const patchPath = path.join(home, 'profiles', profile, 'cordis.patch.yml')
let patch = '[]'
try { patch = await readFile(patchPath, 'utf8') } catch { /* empty */ }
let parsed
try { parsed = YAML.parse(patch, { logLevel: 'silent' }) } catch (error) {
  process.stderr.write(`fake-dsh: bad patch: ${error.message}\n`)
  process.exit(1)
}
if (!Array.isArray(parsed)) parsed = []
const rows = new Map([
  ['system-prompt', { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt', config: {
    personaPrefix: 'BASE PERSONA', personaSuffix: 'BASE SUFFIX', toolOrder: ['bash', 'read', '<unlisted-tools>'], toolDescription: 'keep-me',
  } }],
  ['harness2-task-recursion', { id: 'harness2-task-recursion', name: 'harness2-task-recursion', config: { triggerThreshold: 3, cooldownMs: 60000 } }],
  ['session-title-llm', { id: 'session-title-llm', name: '@deepseek-ai/dsh-session-title-first-prompt-llm', config: { targetWords: 5 } }],
  ['hmr', { id: 'hmr', name: '@deepseek-ai/dsh-hmr', disabled: true }],
])
for (const row of parsed) {
  if (row === null || typeof row !== 'object' || typeof row.id !== 'string') continue
  const existing = rows.get(row.id) ?? { id: row.id }
  if (typeof row.name === 'string') existing.name = row.name
  if (row.disabled !== undefined) existing.disabled = row.disabled
  if (row.config !== undefined) existing.config = row.config
  rows.set(row.id, existing)
}
if (process.env.FAKE_SKIP_BUNDLE === '1') {
  process.stdout.write('skipping profile bundle "harness2-task-recursion": missing dependency\n')
}
process.stdout.write(YAML.stringify([...rows.values()], { lineWidth: 0 }))
