- [ ] Pairs generation is broken on Ties for Football Games - AI Ignore this
- [ ] Add script to find and fix failed pairs in V4 - AI Ignore 
- [X] add script to polytoken to check for same information already exisiting 
- [ ] increased data validation on contracts

- V1
    - [ ] Re-add sorting functionality to scanner
    - [ ] Add spread calculation in scanner pairs tab

- V4

Ian
- Connect github to server, choose between droplet and app platform
- Fix- we are paper trading so someone placed a bid and in theory we would have bought it but in reality we didnt because were paper trading so when the cycle went around again it still saw the bid and took it again
- Buy many servers to not get rate liimited?
- Add polymarket fees
- Make it skipp if <0.85 rather than 0.6>
- Make those pairs go to failed pairs or another bad pairs json.

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
 