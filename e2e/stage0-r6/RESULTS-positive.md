# Stage-0 v4 live acceptance (PR-1, positive arm)

- Mode: **positive**
- Result: **PASS**
- Cycles: 20 (sessions 20)
- probe/completed: 20; compose/applied: **20**; compose/rejected: 0
- controlMetrics lengths: [4]; bad controls: 0 (expected 4)
- rejected ids ⊆ trials: true; gate/v4 receipts: 20
- inadmissible candidate receipts: 0
- edit bodies: 2 unique (2 hash-valid), referenced hashes 2, missing 0
- applied edit counts: [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]
- fake requests: {"main":80,"propose":20,"probe":120,"reflection":20}
- elapsed: 116.9s

## Checks
- PASS — every session exits 0
- PASS — every session produced exactly one cycle (2 records)
- PASS — one distinct cycle per session
- PASS — every compose record carries a gate/v4 receipt
- PASS — probe child requests match the mode
- PASS — all bodies are content-addressed and hash-valid
- PASS — every referenced trial/applied hash has a body
- PASS — positive-control persona applied in >= 18 cycles (got 20)
- PASS — every applied cycle records exactly one edit
- PASS — every applied edit is a canonical persona hash
- PASS — applied receipts show admitted candidates
- PASS — every applied receipt has controlCount=4 and stable=true
- PASS — every candidate has 2 matched controls and no bad metrics
