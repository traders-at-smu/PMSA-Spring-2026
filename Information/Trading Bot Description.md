# Physical Model (Decision Engine)

Status: Complete

# Physical Model (Decision Engine)

The team that turns "edge exists" into "expected net edge after slippage + recommended cap."

### What you must bring

**A. A single file named `model_v1.py` (or notebook) with this function:**

`model_decision(opportunity_row, lob_metrics, recent_snapshots) -> dict`

It must return exactly:

- `expected_slippage` (in $ or cents per contract)
- `fill_prob_20s` (0–1)
- `expected_net_edge` (edge after slippage, in $/contract)
- `recommended_cap` (max $ notional)

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

Take 3 rows from the trader pipeline's `opportunities_raw.csv` + sizing metrics and output the 4 model fields above.

Acceptance criteria:

- We can plug your model output directly into the sizing formula with no guessing.
