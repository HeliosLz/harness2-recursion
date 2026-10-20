# Stage-0 v4 live acceptance (PR-1)

- Result: **PASS**
- Cycles: 20 (sessions 20)
- probe/completed: 20; compose/applied: **0**; compose/rejected: 20
- controlMetrics lengths: [2]; bad controls: 0
- rejected ids ⊆ trials: true; gate/v4 receipts: 20
- inadmissible candidate receipts: 40
- fake requests: {"main":80,"propose":20,"probe":40,"reflection":20}
- elapsed: 116.7s

## Checks
- PASS — every session produced one cycle
- PASS — 20 probe/completed records
- PASS — 0 compose/applied for NULL/ADVERSARIAL
- PASS — 20 compose/rejected records
- PASS — every cycle has exactly 2 recovery controls
- PASS — every rejection id exists in the same payload trials
- PASS — every rejection carries a gate/v4 receipt
- PASS — all candidate receipts are inadmissible
