# Stage-0 v4 live acceptance (PR-1, negative arm)

- Mode: **negative**
- Result: **PASS**
- Cycles: 20 (sessions 20)
- probe/completed: 20; compose/applied: **0**; compose/rejected: 20
- controlMetrics lengths: [2]; bad controls: 0
- rejected ids ⊆ trials: true; gate/v4 receipts: 20
- inadmissible candidate receipts: 40
- applied edit counts: []
- fake requests: {"main":80,"propose":20,"probe":40,"reflection":20}
- elapsed: 117.5s

## Checks
- PASS — every session exits 0
- PASS — every session produced exactly one cycle (2 records)
- PASS — one distinct cycle per session
- PASS — every cycle has exactly 2 recovery controls
- PASS — every compose record carries a gate/v4 receipt
- PASS — every gate receipt has controlCount=2 and stable=true
- PASS — probe child requests match the mode
- PASS — 0 compose/applied for NULL/ADVERSARIAL
- PASS — 20 compose/rejected records
- PASS — all candidate receipts are inadmissible
- PASS — every rejection id exists in the same payload trials
