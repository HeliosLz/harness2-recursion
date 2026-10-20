# Rationale — pre-registered Stage-0 design

This file is the pre-registered experiment design; it is not regenerated from results.

## Cycle count and arm shape

**Chosen:** one combined arm of 20 fresh headless sessions; each session's Propose response contains **both** candidates, so each candidate is probed 20 times. A trigger cycle is one session, so the unit of analysis matches the gate invocation.

**Rejected:** two arms of 20 sessions (40 total). It doubles runtime without changing the conclusion space (100% vs 10% is decided long before n=40), and introduces arm-order/state confounds irrelevant to the claim. If one candidate were rejected, the other's status remains readable from the composed payload, so the combined arm does not hide per-candidate rejection.

## Where acceptance is read

**Chosen:** only the frozen ledger payloads:
- accepted = `compose/applied.appliedEdits[]` contains the candidate's `candidateId` **and** `contentHash`, and the component/operation match;
- rejected = the id appears in `compose/rejected.rejectedCandidateIds`;
- absent = a compose record exists but the candidate appears in neither list;
- missing = no compose record (reported separately, not silently counted as rejection).

**Rejected:** probe validity, stdout, plugin logs, or `EXPERIENCE.md` as the acceptance signal. A valid advisory probe says nothing about whether the gate accepted the edit.

## Candidate identity

Candidate ids are recomputed exactly as the task plugin does (`cand-` + first 16 hex of `sha256("<candidateType>:<component>:<content>")`), and hashes are `sha256:<hex>` of the exact content. The fake server and the analyzer import the same `proposals.mjs`, so producer and analyzer cannot drift.

## Failure-budget reset

The fake provider keys its 3-failure budget by the first user task string. Every session uses a unique task string; retries only occur when a session produced no ledger record at all, and use a new key. This gives exactly one trigger cycle per session without a global counter leaking between conversations.

## Denominator

Primary = cycles with a compose record (the gate was actually invoked). Secondary = attempted sessions. The grafted report shows both; with 0 no-compose cycles they currently agree.

## Error handling

A session is retried once only when it produced no ledger record at all; a probe-without-compose is recorded as `MISSING_COMPOSE` and is not retried, so a real gate bug cannot be hidden by retries.

## Interpretation boundary

`compose/applied` is a decision record. In dsh 0.2.1 there is no `applyHarnessPatch`, so `applyMode` is `noop-todo`/`next-task-ledger`; the experiment measures the gate's decision behavior, not live harness mutation. Stating this limitation is part of the pre-registration, not an after-the-fact excuse.
