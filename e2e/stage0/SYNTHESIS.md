# Arena synthesis — Stage-0 falsification gate (2026-10-20)

**Shape:** 3 candidates raced on the same brief (build + run the Stage-0 falsification gate), then `rank all` against a fixed 6-criterion rubric (R1 protocol fidelity, R2 measurement integrity, R3 reproducibility, R4 interpretive rigor, R5 engineering quality, R6 cost/efficiency).
**Outcome:** all three reproduced the claim; base chosen on maintainability/audit, not on the result.

## Pick

**Base: candidate-1** (parent score 30/30; cross-judge score 30/30). Candidate-2 27/30, candidate-3 24/30.

Why candidate-1:

- `proposals.mjs` is the **single source of truth** shared by the fake server and the analyzer — no duplicated literal strings (c2/c3 had producer/analyzer drift risk);
- primary denominator is **compose cycles** (c2 used `probed`, c3 used attempted sessions);
- the documented command is the command that actually works (c2/c3 docs started a manual fake server that conflicts with their runner);
- invariants are asserted in a reusable anomalies structure: ledger v3, continuous revision chain, id/entry-id equality, compose anchors, `appliedEdits` ↔ `appliedCandidateIds` one-to-one, de-duplicated components.

## Grafts

From **candidate-2** (no-op sanity + downstream):
- Log the Propose response contents and assert **both literal candidates appear in the Propose response** and in the probe prompts (closes the "was the exact string actually proposed" gap).
- Parse `EXPERIENCE.md` after the run and assert whether an accepted bad edit is distilled as positive experience (hash match; meta stores no content).

From **candidate-3** (correlation + isolation):
- Per-cycle fake-server correlation table (`4 main + 1 propose + 2 probe + 1 reflection`), using non-overlapping session windows.
- Dual denominator (compose cycles primary, attempted sessions secondary).
- Explicit `git status --porcelain` before/after assertion (excluding `e2e/stage0/`).

## Rejections

- **candidate-2** as base: non-executable Commands block (manual server conflicts with `assertPortFree`; manual session loop wiped by runner), duplicated proposal constants, denominator `probed` rather than compose cycles.
- **candidate-3** as base: artifact lifecycle flaw (deleted `results.json` but kept stale `REPORT.md` during rerun), no ledger v3/chain validation, post-run "pre-registered" RATIONALE, undisclosed second run.
- Both remain valid **evidence**; their ledgers independently show 20/20 for both bad edits.

## Rubric ambiguities recorded

1. "20 cycles each" was implemented as one combined arm of 20 sessions, both candidates per cycle ⇒ 20 observations per candidate. If two arms of 20 (40 sessions) was intended, all three under-run; the 20/20 vs 10% margin makes the verdict unchanged.
2. Denominator choice (compose cycles vs attempted sessions) is the main scoring contention; with zero missing-compose cycles both give 100%.
3. Candidates used either repo `link:` installs (c1) or byte-identical copies (c2/c3); both exercise the real plugin code.

## Verification of the synthesized artifact

The synthesized `e2e/stage0/` was rerun end-to-end after grafting:

- **PASS**; 20/20 sessions exit 0; 40 ledger v3 records (20 `probe/completed` + 20 `compose/applied`); 0 rejected, 0 missing, 0 missing cycles.
- NULL accepted **20/20 = 100%**; ADVERSARIAL accepted **20/20 = 100%** (Wilson 95% 83.9–100%).
- Grafted checks: Propose responses contain both literals 20/20; probe prompts cover both 20/20; per-cycle request windows exactly 4/1/2/1; EXPERIENCE.md contains the adversarial hash as `outcome: accepted`; repo status unchanged; **0 anomalies**.
- Runtime 108.9s (first verified run), fake provider only, no paid tokens.

**Verdict: GATE INVALID** under the pre-registered >10% rule. The compose gate is content-blind: any valid probe reports `completion=true` against a baseline `completion=false`, so a no-op and an injection both look like improvements.

## Follow-ups (P0, before any "self-evolution" claim)

1. Fix compose fitness: add a post-burst/recovery control arm or placebo rejection; `completion` must not be hard-coded `true` for trials.
2. Persist edit content (`{component, operation, content, contentHash}`) before `compose/applied` so OFFLINE can apply decisions.
3. Let meta respect `applyMode` (or rename the event) so non-applied decisions are not learned as applied experience.
4. Per-agent scoping for pending patches / applied components (latent ONLINE defect).
5. Confidence replication: re-confirming the same edit should accumulate evidence instead of only rewarding novelty.
6. `metricWeights.tokenCost` currently makes cost regressions negligible.

See `RESULTS.md` for the full report and `artifacts/` (gitignored) for raw evidence.
