- [ ] Pairs generation is broken on Ties for Football Games - AI Ignore thi
- [ ] Add script to find and fix failed pairs in V4 - AI Ignore 
- [X] add script to polytoken to check for same information already exisiting 
- [ ] increased data validation on contracts

Ian
 - Make a gameplan
    - Traders@SMU: check into Portfolio value and cash balance api possibility
 - Reminders
- PHASE 2
   - Update the expected edge to be if sold at 0.99
   - Make sure that fees are calulcated when sold as well

   Fix game market pairs (GAME pairs produce fake arb)

Root cause: _resolve_tokens in connectors.py:294-296 defaults to index 0/1 for team-name outcomes instead of matching by team name → wrong Poly token assigned
Both legs of the inverted pair bet the same outcome (double directional bet, not a hedge)
Exit convergence assumption also breaks since game markets resolve binary, not gradually
Fix 1: Update _resolve_tokens to match Kalshi team name → correct Poly outcome token
Fix 2: Remove duplicate GAME pairs from Pairs_for_Kalshi_and_Polymarket.xlsx (each game has 2 Kalshi tickers but 1 Poly market — only one can be correctly aligned)

- Connect github to server, choose between droplet and app platform
- OHHHHH i see what happened, we are paper trading so someone placed a bid and in theory we would have bought it but in reality we didnt because were paper trading so when the cycle went around again it still saw the bid and took it again
- Buy many servers to not get rate liimited?

Davis:
  - Get the URL's corrected so we can easily verify contracts
  - Look into portfolio value and cash holdings tracker

Jackson:
  - Keep an updated list of contracts, take out duplicates, past expirations, and bad links
  - We keep getting similar team contracts ip mixed up
   - Ex: Texas Longhorn and Texas A&M, Mighican state and Michigan
  - We also keep getting the spotify wrong
!! The most successful ones are in groups because the entire grouping is wrong so several pop up
   !! EX: all 4 2024 NFC championship odds are showing an edge(smaller groups better)
- The longer the expiration date, the less movement, forced to hold longer
   - Look for lower expiration dates?
- High volume pairs better for convergence
- 5x more pairs = 5x more profit



DONE
 - File 1 hour paper trade from yesterday
 - delete bad contracts like michigan state and south florida and iowa state
  - Figure out why contracts will mess up and then the same contract works
   - Edit outputs
    - Add % egde
    - Add LOB walk down trades
   - Add LOB to trades.json output
- Fix Fees
- Should errors when looking up a pair automatically be added to failed pairs or should it be re run a couple times incase it shouldnt have been
 