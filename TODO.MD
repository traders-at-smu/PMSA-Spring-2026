- [ ] Pairs generation is broken on Ties for Football Games - AI Ignore this
- [ ] Re-add sorting functionality to scanner
- [ ] Add spread calculation in scanner pairs tab 
- [x] Add CLI Version of Bot
    - [ ] Cross-market arbitrage only
        - [ ] information > Trade Rules.md
    - [ ] CMD output, as well as trading log output for the bot
        - Log for trades should be in a json format
            {
                "trade_number": "T12345",
                "title": "Election Outcome Contract",
                "kalshi_token": "KALSHI_ABC123",
                "polymarket_token": "POLY_XYZ789",
                "kalshi_price": 0.32,
                "polymarket_price": 0.36,
                "fee": 1.25,
                "kalshi_contracts_purchased": 100,
                "polymarket_contracts_purchased": 95,
                "total_profit": 42.75
            }
    - [ ] Manual pairs only, no AI Pairs
    - [ ] No fetching all market data, only contracts listed in manual pairs
    - [ ] add capability for live trading using an api, default to paper if no keys are entered
    - [ ] should have the "walking up the book" that the v1 bot contains
    - [ ] I put an ascii art in the v4 file, can you put it in the cli when you launch? I want a similar design to claude code cli
    - [ ] add a settings config.json, I want to be able to config fees (I should be able to enter a formula and you turn that into code of the formula function using predefined variables. For example I should be able to enter p(1-p).007c and that be translated into logic as probability of yes *probability of no * .007 * number of contracts by the backend), minimum arr (minimum arr needs to be calculated for each arbitraged contract, you can see the trading logic under information > Trade Rules.md)
    - Try to keep this in a readable language, no typestripe, node js. Try to make this simple and using few files. maybe try to write it in rust if you can