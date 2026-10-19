/**
 * Harness² component names (round-3 frozen) and legacy migration map.
 *
 * This file MUST stay byte-identical in both plugins; the two packages carry
 * identical copies and never import each other (round-1 red line).
 */
export const COMPONENT_NAMES = [
  'system-prompt',
  'guardrails',
  'memory',
  'tool-guidance',
  'subagents',
  'skills',
  'scripts',
  'plugins',
] as const

export type ComponentName = (typeof COMPONENT_NAMES)[number]

export function isComponentName(value: unknown): value is ComponentName {
  return typeof value === 'string' && (COMPONENT_NAMES as readonly string[]).includes(value)
}

/** Round-2 provisional names → round-3 frozen names (meta load migration). */
export const LEGACY_COMPONENT_MIGRATION: Record<string, ComponentName> = {
  'tool-definitions': 'tool-guidance',
  'tool-policy': 'guardrails',
  'context-assembly': 'system-prompt',
  'experience-memory': 'memory',
  'subagent-composition': 'subagents',
  'workflow-control': 'skills',
  'verification': 'guardrails',
}
