[[Trade_Rules.pdf]]
# Variables
- K - Kalshi
- P - Polymarket
- Y - Yes Contract
- N - No Contract
- C - # of Contracts
- A - Annualized
- D - Days till contract resolved
- E - Edge
- Min - Minimum
- Max - Maximum
- $KP_{max}$ - max all in cost per contract
- KP(c) - total $ paid for c contracts
- * - yes/no contract
# Steps of Execution
Polymarket -> Yes ->$Ask_{PY}$ and $Bid_{PY}$ 
Polymarket -> No -> $Ask_{PN}$ and $Bid_{PN}$
Kalshi - > Yes -> $Ask_{KY}$ and $Bid_{KY}$
Kalshi - > No -> $Ask_{KN}$ and $Bid_{KN}$

2 Strategies:
- Buy Ask_KY and Ask_PN
- Buy Ask_KN and Ask_PY

$Fee_{KY}(C=1) = roundup(.007*Ask_{KN} *(1-Ask_{KY}))$
$Fee_{KN}(C=1) = roundup(.007*Ask_{KN} *(1-Ask_{KN}))$

If $Fee_{KY}(C=1) + Ask_{KY} + Ask_{PN} + Fee_{PN}(0) = KYPN(C=1)$ 
- <1 -> Arbitrage Opportunity
- >=1 -> No Trade
If $Fee_{KN}(C=1) + Ask_{PY} + Ask_{KN} + Fee_{PY}(0) = KNPY(C=1)$ 
- <1 -> Arbitrage Opportunity
- >=1 -> No Trade

If there is an arbitrage opportunity:
$KP(c) = Ask_{K*}(c)+ Ask_{P*}(c)+Fee_{K*}(c)+Fee_(P*)(c)$$ - cost of n contracts
$E\$(c) = c-KP(c)$ - $ edge on multiple contracts
$E\$(c=1) = \frac{E\$c}{c} = 1- \frac{KP(c)}{c}$ - $ edge on one contract
$E\%(c) = \frac{E\$(c)}{KP(c)} = \frac{c-KP(c)}{KP(c)}$ - % of an edge on a given contract
$A_e(c) = \frac{E\%(c)*365}{d}$  - Annualized return of a specific # of contract's edges based on their outstanding days remaining

Trading Rules:
- If:
	- $KP(c_{new}) < c_{new}$ (Total $ paid is < than new number of contracts) AND
	- $KP(c) < KP_{max}$ (Total paid for c contracts < less than the max all in cost per contract) AND
	- $A_e(c_{new})\ge A_{min}$ (Annualized edge of new contracts is $\ge$ Minimized annualized return)
- Then Trade