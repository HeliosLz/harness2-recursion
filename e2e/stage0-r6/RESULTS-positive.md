# Stage-0 v4 live acceptance (PR-1, positive arm)

- Mode: **positive**
- Result: **PASS**
- Cycles: 20 (sessions 20)
- probe/completed: 20; compose/applied: **20**; compose/rejected: 0
- controlMetrics lengths: [2]; bad controls: 0
- rejected ids ⊆ trials: true; gate/v4 receipts: 20
- inadmissible candidate receipts: 0
- applied edit counts: [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]
- fake requests: {"main":80,"propose":20,"probe":80,"reflection":20}
- elapsed: 115.8s

## Checks
- PASS — every session exits 0
- PASS — every session produced exactly one cycle (2 records)
- PASS — one distinct cycle per session
- PASS — every cycle has exactly 2 recovery controls
- PASS — every compose record carries a gate/v4 receipt
- PASS — every gate receipt has controlCount=2 and stable=true
- PASS — probe child requests match the mode
- PASS — positive-control persona applied in >= 18 cycles (got 20)
- PASS — every applied cycle records exactly one edit
- PASS — every applied edit is a canonical persona hash
- PASS — applied receipts show admitted candidates
