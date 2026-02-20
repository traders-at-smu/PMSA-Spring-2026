import dotenv from "dotenv";
dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

export const config = {
  // Target trader
  targetUserAddress: required("TARGET_USER_ADDRESS"),
  myProxyWalletAddress: required("MY_PROXY_WALLET_ADDRESS"),

  // Wallet
  privateKey: required("PRIVATE_KEY"),

  // Contracts
  ctfAddress: process.env.CTF_ADDRESS || "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  ctfExchangeAddress: process.env.CTF_EXCHANGE_ADDRESS || "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
  negRiskAdapterAddress: process.env.NEG_RISK_ADAPTER_ADDRESS || "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
  negRiskCtfExchangeAddress: process.env.NEG_RISK_CTF_EXCHANGE_ADDRESS || "0xC5d563A36AE78145C45a50134d48A1215220f80a",
  usdcAddress: process.env.USDC_CONTRACT_ADDRESS || "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",

  // APIs
  clobHttpUrl: process.env.CLOB_HTTP_URL || "https://clob.polymarket.com",
  gammaApiUrl: process.env.GAMMA_API_URL || "https://gamma-api.polymarket.com",
  dataApiUrl: process.env.DATA_API_URL || "https://data-api.polymarket.com",

  // Gas
  gasLimit: parseInt(process.env.GAS_LIMIT || "5000000"),
  gasPriceLimit: process.env.GAS_PRICE_LIMIT || "110000000000",

  // Bot
  waitingTime: parseInt(process.env.WAITING_TIME || "4"),
  maxPositionLimit: parseFloat(process.env.MAX_POSITION_LIMIT || "0.2"),
  blacklistedMarkets: (process.env.BLACKLISTED_MARKETS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Infrastructure
  rpcUrl: required("RPC_URL"),
  mongoUri: required("MONGO_URI"),

  // Chain
  chainId: 137,

  // Redemption interval (ms) - default 2 hours
  redemptionInterval: 2 * 60 * 60 * 1000,
};
