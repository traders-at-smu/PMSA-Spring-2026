# Davis + Hayden

Assignee: Davis Lynn, Hayden Kreikemeier
Status: Complete

# Davis + Hayden (together) — **Physical Model (Decision Engine)**

You two are now the team that turns “edge exists” into “expected net edge after slippage + recommended cap.”

### What you must bring

**A. A single file named `model_v1.py` (or notebook) with this function:**

`model_decision(opportunity_row, lob_metrics, recent_snapshots) -> dict`

It must return exactly:

- `expected_slippage` (in $ or cents per contract)
- `fill_prob_20s` (0–1)
- `expected_net_edge` (edge after slippage, in $/contract)
- `recommended_cap` (max $ notional)

**B. Define required inputs**

You must list exactly what you need logged:

- last 3 snapshots of the pair (30s interval)
- top-of-book depth
- depth within profitable band
- edge persistence (did edge exist last scan?)

**C. V1 model can be heuristic, but must be explicit**

Example must be something like:

- slippage = function of requested size vs depth
- fill_prob = function of (depth ratio, edge persistence)
- cap = bankroll * min(0.20, fill_prob * edge_strength_scaled)

**D. Demonstrate on 3 opportunities**

Take 3 rows from Miguel’s `opportunities_raw.csv` + Quang sizing metrics and output the 4 model fields above.

✅ Acceptance criteria for Wed:

- We can plug your model output directly into Ian’s sizing formula with no guessing.