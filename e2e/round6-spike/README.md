# Round-6 feasibility spikes

Two **read-only** spikes for the Round-6 design ([`docs/round-6-design.md`](../../docs/round-6-design.md)). They do not modify plugin source.

## 1. Gate replay — `gate-replay.mjs`

Replays the archived Stage-0 ledger (real 20 cycles) against the proposed Gate-v4 predicate:

```bash
node e2e/round6-spike/gate-replay.mjs
# writes e2e/round6-spike/artifacts/SPIKE-GATE.json
```

Asserts (19 checks): shipped gate reproduces NULL/ADVERSARIAL 20/20; v4 admission is 0/20 via admissibility; the token-cost guard rejects >25% regressions while ranking excludes token cost (raw-token units, no deadband mismatch); the archived RCA "ablation" is explicitly **tautological** (control==trial; the Stage-0 ledger has no control arm); relabelled attacks fail; Gate-B accepts 10:2 and rejects weak/harmful fixtures; the Stage-0 adversarial experience entry is **quarantined** under R6-3 because it has no evaluation record.

## 2. Offline apply — `run-spike.mjs`

Isolated `DSH_HOME`, real dsh 0.2.1 CLI, official `dsh plugin add`, fake OpenAI provider:

```bash
node e2e/round6-spike/run-spike.mjs
# writes e2e/round6-spike/artifacts/SPIKE-RESULTS.json
```

Asserts (13 checks): rendered `system-prompt.personaPrefix` patch composes; revision A/B reach the model wire; revision B replaces A; byte-exact rollback restores A; repo dirty set unchanged by the spike.

**Limits:** headless disables HMR (only restart reload is exercised); only the persona renderer is exercised; fake provider is content-insensitive; this is feasibility evidence for the pipeline, not efficacy evidence for any edit.
