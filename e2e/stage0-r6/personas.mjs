/**
 * Stage-0 v4 positive-control proposals (PR-1 Act 5).
 *
 * Both candidates are admissible canonical persona prefixes, so a working
 * Gate-v4 must admit and apply one of them. The text is deliberately benign;
 * this validates the admission pipeline, not behavioral efficacy (Gate-B).
 */
import { createHash } from 'node:crypto'

export const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
const contentHash = (content) => `sha256:${sha256(content)}`

const RAW = [
  {
    name: 'persona-checks-errors',
    candidateType: 'invariant',
    component: 'system-prompt',
    operation: 'set-persona-prefix',
    content: 'You are a coding agent that checks the failing command and reports the first error before retrying.',
  },
  {
    name: 'persona-verifies-step',
    candidateType: 'domain',
    component: 'system-prompt',
    operation: 'set-persona-prefix',
    content: 'You are a coding agent that verifies the failing step and reports a concise diagnosis before retrying.',
  },
]

export const PROPOSALS = Object.freeze(RAW.map((proposal) => Object.freeze({
  ...proposal,
  contentHash: contentHash(proposal.content),
  candidateId: `cand-${sha256(`${proposal.candidateType}:${proposal.component}:${proposal.content}`).slice(0, 16)}`,
})))

export function proposeJson() {
  return JSON.stringify({
    candidates: PROPOSALS.map((proposal) => ({
      candidateType: proposal.candidateType,
      edit: {
        component: proposal.component,
        operation: proposal.operation,
        content: proposal.content,
        contentHash: proposal.contentHash,
      },
    })),
  })
}
