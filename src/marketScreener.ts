import axios from "axios";
import { config } from "./config";
import { logger } from "./logger";

export interface ScreenerMarket {
    conditionId: string;
    slug: string;
    question: string;
    liquidity: number;
    volume24hr: number;
    volumeTotal: number;
    volumeSpikeRatio: number; // 24hr / Total (higher is more suspicious)
    category: string;
}

export class MarketScreener {
    /**
     * Fetches active markets from Gamma API and filters them based on config
     * @param limit How many pages to fetch (max 500 per page, defaults to 500 total)
     */
    async getTrendingInsiderMarkets(limit: number = 500): Promise<ScreenerMarket[]> {
        logger.info(`Fetching active markets for screening (limit: ${limit})...`);

        try {
            // Fetch active, unclosed markets
            const resp = await axios.get(`${config.gammaApiUrl}/markets`, {
                params: {
                    active: true,
                    closed: false,
                    limit,
                },
            });

            if (!resp.data || !Array.isArray(resp.data)) {
                logger.warn("Invalid response from Gamma API /markets");
                return [];
            }

            const allMarkets = resp.data;
            logger.info(`Fetched ${allMarkets.length} active markets. Applying filters...`);

            const filteredMarkets: ScreenerMarket[] = [];

            for (const m of allMarkets) {
                const liquidityNum = m.liquidityNum || 0;
                const volume24hr = m.volume24hr || 0;
                const volumeTotal = m.volumeNum || 0;
                const category = m.category || "Unknown";

                // 1. Filter out dead markets (low liquidity)
                if (liquidityNum < config.minLiquidity) continue;

                // 2. Filter out markets with no recent action
                if (volume24hr < config.minVolume24h) continue;

                // 3. Category filtering (if specific categories are configured)
                if (config.screenerCategories.length > 0) {
                    if (!config.screenerCategories.includes(category)) {
                        continue;
                    }
                }

                // Calculate insider heuristic: Volume Spike Ratio
                // We add 1 to denominator to avoid division by zero
                // If total volume is 10k, and 5k of it was in last 24h, the ratio is 50%.
                const spikeRatio = volume24hr / (volumeTotal || 1);

                filteredMarkets.push({
                    conditionId: m.conditionId,
                    slug: m.slug,
                    question: m.question || m.title || "Unknown Market",
                    liquidity: liquidityNum,
                    volume24hr: volume24hr,
                    volumeTotal: volumeTotal,
                    volumeSpikeRatio: spikeRatio,
                    category: category,
                });
            }

            // Sort by the highest spike ratio
            filteredMarkets.sort((a, b) => b.volumeSpikeRatio - a.volumeSpikeRatio);

            logger.success(`Screener found ${filteredMarkets.length} high-potential markets.`);
            return filteredMarkets;

        } catch (err) {
            logger.error("Market screener failed to fetch data:", err);
            return [];
        }
    }
}
