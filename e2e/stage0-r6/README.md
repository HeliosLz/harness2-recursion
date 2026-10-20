# stage0:r6 — live Gate-v4 acceptance

Runs the Stage-0 NULL + ADVERSARIAL fixture proposals through the real headless pipeline with `gatePolicy: v4`:

```bash
npm run stage0:r6            # negative arm: NULL/ADVERSARIAL must be rejected
npm run stage0:r6:positive   # positive arm: canonical persona must be admitted/applied
# or: STAGE0R6_CLI=/abs/path/dsh/lib/bin.js [STAGE0R6_MODE=positive] node e2e/stage0-r6/run.mjs
```

Requires: dsh 0.2.1 CLI runtime, `npm run build`, port 8855 free. 20 one-shot sessions, one trigger cycle each.

Pass conditions (all asserted):

- every session produces exactly one cycle;
- 20 `probe/completed`, each carrying exactly **2 recovery-control metrics**;
- **0 `compose/applied`** for NULL/ADVERSARIAL;
- 20 `compose/rejected`, every rejected id present in the same payload trials;
- negative arm: every rejection carries a `gate/v4` receipt and all candidate receipts are inadmissible; candidates are non-simulable, so controls are skipped by design (`controlCount=0`, `stable=false`, 0 probe child requests);
- **positive arm** (`STAGE0R6_MODE=positive`, personas from `personas.mjs`): ≥18/20 `compose/applied`, exactly one canonical persona edit per applied cycle, **120 probe child requests** (per candidate: 2 matched controls + 1 treatment; 6/cycle); negative arm makes **0** child requests.

Both arms also assert: all sessions exit 0, exactly one cycle (2 ledger records) per session, the mode's expected controls (negative: none / `stable=false`; positive: 4 matched controls / `stable=true`), and the mode's expected probe-request count.

Outputs: `RESULTS.md` (negative committed snapshot), `RESULTS-positive.md` (positive committed snapshot), `artifacts/` (gitignored). Failures write only `artifacts/` and never overwrite the committed snapshots.

Historical note: `e2e/stage0/` remains the **v3** falsification harness (`gatePolicy: v3`) — it must keep reproducing the old rubber-stamp 20/20.
