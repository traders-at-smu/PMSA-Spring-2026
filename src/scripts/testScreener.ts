// We temporarily override the config strictly for this test script so it 
// runs successfully even if the user hasn't set up the .env file yet.
process.env.TARGET_USER_ADDRESS = "0x0000000000000000000000000000000000000000";
process.env.MY_PROXY_WALLET_ADDRESS = "0x0000000000000000000000000000000000000000";
process.env.PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000000";
process.env.RPC_URL = "https://polygon-rpc.com";
process.env.MONGO_URI = "mongodb://localhost:27017/pm-copy-bot-test";

process.env.MIN_LIQUIDITY = "5000"; // $5k min liquidity
process.env.MIN_VOLUME_24H = "10000"; // $10k min 24h volume
process.env.SCREENER_CATEGORIES = ""; // all

import { MarketScreener } from "../marketScreener";

async function runTest() {
    console.log("==========================================");
    console.log("   Market Screener Test (Phase 1)");
    console.log("==========================================");

    // Re-import config to apply the temporary env vars
    const { config } = require("../config");

    console.log(`Filters Active:`);
    console.log(`- Min Liquidity: $${config.minLiquidity.toLocaleString()}`);
    console.log(`- Min 24h Volume: $${config.minVolume24h.toLocaleString()}`);
    console.log(`- Categories: ${config.screenerCategories.length ? config.screenerCategories.join(', ') : 'All'}`);
    console.log("------------------------------------------");

    const screener = new MarketScreener();
    const suspiciousMarkets = await screener.getTrendingInsiderMarkets(500);

    if (suspiciousMarkets.length === 0) {
        console.log("No markets passed the screener filters.");
        return;
    }

    console.log(`\nTop 10 High-Potential Insider Markets (Sorted by Volume Spike Ratio):`);

    const top10 = suspiciousMarkets.slice(0, 10);

    for (let i = 0; i < top10.length; i++) {
        const market = top10[i];
        console.log(`\n[${i + 1}] ${market.question}`);
        console.log(`    Category  : ${market.category}`);
        console.log(`    Spike Ratio: ${(market.volumeSpikeRatio * 100).toFixed(1)}% of total volume was today`);
        console.log(`    24h Volume: $${market.volume24hr.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
        console.log(`    Total Vol : $${market.volumeTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
        console.log(`    Liquidity : $${market.liquidity.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
        console.log(`    URL       : https://polymarket.com/market/${market.slug}`);
    }
}

runTest().catch(console.error);
