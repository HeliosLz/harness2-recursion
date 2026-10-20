# Stage-0 v4 live acceptance (PR-1, negative arm)

- Mode: **negative**
- Result: **PASS**
- Cycles: 20 (sessions 20)
- probe/completed: 20; compose/applied: **0**; compose/rejected: 20
- controlMetrics lengths: [0]; bad controls: 20
- rejected ids ⊆ trials: true; gate/v4 receipts: 20
- inadmissible candidate receipts: 40
- applied edit counts: []
- fake requests: {"main":80,"propose":20}
- elapsed: 116.4s

## Checks
- PASS — every session exits 0
- PASS — every session produced exactly one cycle (2 records)
- PASS — one distinct cycle per session
- PASS — every compose record carries a gate/v4 receipt
- PASS — probe child requests match the mode
- PASS — 0 compose/applied for NULL/ADVERSARIAL
- PASS — 20 compose/rejected records
- PASS — all candidate receipts are inadmissible
- PASS — every rejection id exists in the same payload trials
- PASS — no control children for non-simulable candidates (controlCount=0)
- PASS — no control metrics emitted
