/**
 * PR-1.1: matched probe arms.
 *
 * Control and treatment share one prompt skeleton and one child lifecycle. The
 * control replaces the edit body with a deterministic, length-matched neutral
 * placeholder; the treatment keeps the edit body. Both register a same-length
 * `deployment:persona-prefix` section so the token guard is not biased by
 * prompt/section length differences.
 */
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { ProbeMetrics } from './index.ts'

export type ArmMode = 'treatment' | 'control'

export interface ArmCandidate {
  readonly candidateId: string
  readonly candidateType: string
  readonly component: string
  readonly operation: string
  readonly content: string
}

export interface ArmPromptInput {
  readonly taskId: string
  readonly cycleId: string
  readonly baseline: ProbeMetrics
  readonly replayScope: 'last-failed-step' | 'full-task'
  readonly trajectorySummary: string
  readonly candidate: ArmCandidate
  /** Hash seed for the neutral placeholder words (normally cycleId). */
  readonly seed: string
}

export interface ArmPrompt {
  readonly prompt: string
  readonly sectionText: string
}

const NEUTRAL_WORDS = Object.freeze([
  'neutral', 'reference', 'placeholder', 'control', 'baseline', 'restore',
  'recovery', 'unchanged', 'comparison', 'evidence', 'observation', 'replay',
])

/** Deterministic neutral text with exactly `length` characters (no edit text). */
export function neutralPlaceholder(length: number, seed: string): string {
  if (length <= 0) return ''
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  const start = hash % NEUTRAL_WORDS.length
  const words: string[] = []
  for (let index = 0; index < 64; index += 1) {
    words.push(NEUTRAL_WORDS[(start + index) % NEUTRAL_WORDS.length]!)
  }
  return words.join(' ').slice(0, length)
}

function padTo(value: string, length: number): string {
  if (length <= 0) return ''
  const repeated = value.repeat(Math.ceil(length / Math.max(1, value.length)))
  return repeated.slice(0, length)
}

function controlValue(value: string, length: number): string {
  return padTo(`c-${value.replace(/[^a-z0-9-]/gi, '') || 'neutral'}`, length)
}

/**
 * Build one arm's prompt + system-prompt section text.
 *
 * Treatment and control produce byte-identical lengths because every
 * candidate-derived field is substituted with a same-length neutral token and
 * the edit body is replaced by a same-length placeholder.
 */
export function buildArmPrompt(input: ArmPromptInput, mode: ArmMode): ArmPrompt {
  const candidate = input.candidate
  const placeholder = neutralPlaceholder(candidate.content.length, input.seed)
  const editText = mode === 'treatment' ? candidate.content : placeholder
  const candidateId = mode === 'treatment' ? candidate.candidateId : controlValue(candidate.candidateId, candidate.candidateId.length)
  const candidateType = mode === 'treatment' ? candidate.candidateType : controlValue(candidate.candidateType, candidate.candidateType.length)
  const component = mode === 'treatment' ? candidate.component : controlValue(candidate.component, candidate.component.length)
  const operation = mode === 'treatment' ? candidate.operation : controlValue(candidate.operation, candidate.operation.length)
  const prompt = [
    'You are an ADVISORY replay subagent for a task-recursion system.',
    'Your tools are NOT sandbox-restricted yet (TODO(ROUND2_SANDBOX)); do not',
    'modify the workspace, install packages, or run mutating commands.',
    `taskId: ${input.taskId}`,
    `cycleId: ${input.cycleId}`,
    `replayScope: ${input.replayScope}`,
    `candidateId: ${candidateId} (${candidateType})`,
    `proposed component: ${component}`,
    `proposed operation: ${operation}`,
    'proposed edit:',
    editText,
    'baseline metrics:',
    JSON.stringify(input.baseline),
    'failure summary:',
    input.trajectorySummary,
    'Replay the failed step as faithfully as possible with this edit in mind,',
    'then finish. The harness measures behavior from your transcript.',
  ].join('\n')
  return { prompt, sectionText: editText }
}

export interface ProbeArmIo {
  readonly createChild: (parent: Agent) => Promise<AgentHandle>
  readonly sendPrompt: (child: AgentHandle, prompt: string) => void
  readonly waitForIdle: (agent: Agent, timeoutMs: number) => Promise<boolean>
  readonly metrics: (
    ctx: import('@deepseek-ai/cordis').Context,
    agent: Agent,
    messages: readonly { readonly role: string; readonly content: readonly { readonly type: string }[]; readonly isError?: boolean }[],
    durationMs: number,
    prompt: string,
  ) => ProbeMetrics
  readonly lastAssistantText: (agent: Agent) => string
  readonly estimateTokens: (text: string) => number
  readonly onError: (code: string, details?: unknown) => void
}

export interface ProbeArmResult {
  readonly metrics?: ProbeMetrics
  readonly tokenCost: number
  readonly error?: 'persona-injection-unavailable' | 'empty-transcript' | 'timeout' | 'probe-arm-failed'
}

/**
 * Run one child arm (control or treatment) with a shared lifecycle.
 *
 * A section is registered only when `sectionText` is provided; a missing
 * `systemPrompt` service is a fail-closed diagnosis, never fake metrics.
 */
export async function runProbeArm(
  io: ProbeArmIo,
  context: import('@deepseek-ai/cordis').Context,
  parent: Agent,
  input: {
    readonly prompt: string
    readonly sectionText?: string
    readonly timeoutMs: number
    readonly cycleId: string
    readonly candidateId?: string
  },
): Promise<ProbeArmResult> {
  let child: AgentHandle | undefined
  let disposeSection: (() => void) | undefined
  const startedAt = performance.now()
  try {
    child = await io.createChild(parent)
    if (input.sectionText !== undefined) {
      const agentContext = (child.agent as unknown as {
        ctx?: { get?: (name: string) => unknown }
      }).ctx
      const systemPrompt = agentContext?.get?.('systemPrompt') as
        | { section?: (section: { name: string; order: number; text: string }) => unknown }
        | undefined
      if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
        io.onError('persona-injection-unavailable', {
          cycleId: input.cycleId,
          ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId }),
        })
        return { tokenCost: io.estimateTokens(input.prompt), error: 'persona-injection-unavailable' }
      }
      const disposable = systemPrompt.section({
        name: 'deployment:persona-prefix',
        order: 0,
        text: input.sectionText,
      })
      if (typeof disposable === 'function') disposeSection = disposable as () => void
    }
    io.sendPrompt(child, input.prompt)
    const idle = await io.waitForIdle(child.agent, input.timeoutMs)
    const durationMs = performance.now() - startedAt
    if (!idle) {
      io.onError('probe-arm-timeout', {
        cycleId: input.cycleId,
        ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId }),
      })
      return { tokenCost: io.estimateTokens(input.prompt), error: 'timeout' }
    }
    const metrics = io.metrics(
      context,
      child.agent,
      child.agent.session.deriveMessages(),
      durationMs,
      input.prompt,
    )
    if (metrics.stepCount === 0 || !metrics.completion) {
      io.onError('empty-transcript', {
        cycleId: input.cycleId,
        ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId }),
      })
      return { tokenCost: metrics.tokenCost, error: 'empty-transcript' }
    }
    return {
      metrics,
      tokenCost: metrics.tokenCost + io.estimateTokens(io.lastAssistantText(child.agent)),
    }
  } catch (error) {
    io.onError('probe-arm-failed', {
      cycleId: input.cycleId,
      ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId }),
      error: error instanceof Error ? error.message : String(error),
    })
    return { tokenCost: io.estimateTokens(input.prompt), error: 'probe-arm-failed' }
  } finally {
    if (disposeSection !== undefined) {
      try { disposeSection() } catch { /* effect disposal must not mask the arm */ }
    }
    if (child !== undefined) await child.dispose().catch(() => undefined)
  }
}
