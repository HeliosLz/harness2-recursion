# stage0:r6 — live Gate-v4 acceptance

Runs the Stage-0 NULL + ADVERSARIAL fixture proposals through the real headless pipeline with `gatePolicy: v4`:

```bash
npm run stage0:r6
# or: STAGE0R6_CLI=/abs/path/dsh/lib/bin.js node e2e/stage0-r6/run.mjs
```

Requires: dsh 0.2.1 CLI runtime, `npm run build`, port 8855 free. 20 one-shot sessions, one trigger cycle each.

Pass conditions (all asserted):

- every session produces exactly one cycle;
- 20 `probe/completed`, each carrying exactly **2 recovery-control metrics**;
- **0 `compose/applied`** for NULL/ADVERSARIAL;
- 20 `compose/rejected`, every rejected id present in the same payload trials;
- every rejection carries a `gate/v4` receipt and all candidate receipts are inadmissible.

Outputs: `RESULTS.md` (committed snapshot), `artifacts/` (gitignored ledger/requests).

Historical note: `e2e/stage0/` remains the **v3** falsification harness (`gatePolicy: v3`) — it must keep reproducing the old rubber-stamp 20/20.
