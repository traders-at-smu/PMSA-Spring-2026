import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { Contract } from "@ethersproject/contracts";
import { AddressZero, HashZero, MaxUint256 } from "@ethersproject/constants";
import { JsonRpcProvider } from "@ethersproject/providers";
import axios from "axios";
import { getSettings } from "./config";
import { logger } from "./logger";
import { TargetPosition, MyPosition, MarketInfo } from "./types";

// ---- Polygon chain constants (hardcoded for Polygon mainnet) ----
const CHAIN_ID = 137;
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const CTF_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_CTF_EXCHANGE_ADDRESS = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const GAS_LIMIT = 500000;

/** Minimal RPC rotator shim for V3 — single-URL fallback. */
class RpcRotator {
  private provider: JsonRpcProvider;
  constructor(rpcUrl: string) {
    this.provider = new JsonRpcProvider(rpcUrl);
  }
  getProvider(): JsonRpcProvider {
    return this.provider;
  }
  async getWorkingProvider(): Promise<JsonRpcProvider> {
    return this.provider;
  }
}

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

const CTF_ABI = [
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
];

const SAFE_ABI = [
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool success)",
];

export class PolymarketClient {
  private clobClient!: ClobClient;
  private wallet: Wallet;
  private rpcRotator: RpcRotator;
  private marketCache: Map<string, MarketInfo> = new Map();

  constructor(rpcRotator: RpcRotator) {
    this.rpcRotator = rpcRotator;
    const provider = rpcRotator.getProvider();
    const settings = getSettings();
    this.wallet = new Wallet(settings.apiKeys.polymarket.privateKey, provider);
  }

  async initialize(): Promise<void> {
    logger.info("Initializing Polymarket client...");
    const settings = getSettings();
    const clobHttpUrl = settings.externalApis.clobHttpUrl;
    const proxyWallet = settings.apiKeys.polymarket.proxyWalletAddress;

    // Derive API credentials
    const tempClient = new ClobClient(
      clobHttpUrl,
      CHAIN_ID,
      this.wallet
    );
    const creds = await tempClient.createOrDeriveApiKey();
    logger.success("API credentials derived");

    // Create authenticated client with Safe wallet (signatureType=2)
    this.clobClient = new ClobClient(
      clobHttpUrl,
      CHAIN_ID,
      this.wallet,
      creds,
      2, // POLY_GNOSIS_SAFE
      proxyWallet
    );

    // Verify connection
    const ok = await this.clobClient.getOk();
    logger.success(`CLOB client connected: ${ok}`);
  }

  async ensureApprovals(): Promise<void> {
    const settings = getSettings();
    const proxyWallet = settings.apiKeys.polymarket.proxyWalletAddress;
    const provider = await this.rpcRotator.getWorkingProvider();
    const wallet = this.wallet.connect(provider);

    const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, wallet);
    const ctf = new Contract(CTF_ADDRESS, CTF_ABI, wallet);

    // Check and set USDC approval for CTF
    const usdcAllowance = await usdc.allowance(
      proxyWallet,
      CTF_ADDRESS
    );
    if (usdcAllowance.lt("1000000000000")) {
      logger.info("Setting USDC approval for CTF...");
      await this.executeSafeTransaction(
        USDC_ADDRESS,
        usdc.interface.encodeFunctionData("approve", [
          CTF_ADDRESS,
          MaxUint256,
        ])
      );
      logger.success("USDC approved for CTF");
    }

    // Check and set CTF approval for CTF Exchange
    const isApprovedExchange = await ctf.isApprovedForAll(
      proxyWallet,
      CTF_EXCHANGE_ADDRESS
    );
    if (!isApprovedExchange) {
      logger.info("Setting CTF approval for CTF Exchange...");
      await this.executeSafeTransaction(
        CTF_ADDRESS,
        ctf.interface.encodeFunctionData("setApprovalForAll", [
          CTF_EXCHANGE_ADDRESS,
          true,
        ])
      );
      logger.success("CTF approved for CTF Exchange");
    }

    // Check and set CTF approval for Neg Risk CTF Exchange
    const isApprovedNegRisk = await ctf.isApprovedForAll(
      proxyWallet,
      NEG_RISK_CTF_EXCHANGE_ADDRESS
    );
    if (!isApprovedNegRisk) {
      logger.info("Setting CTF approval for Neg Risk CTF Exchange...");
      await this.executeSafeTransaction(
        CTF_ADDRESS,
        ctf.interface.encodeFunctionData("setApprovalForAll", [
          NEG_RISK_CTF_EXCHANGE_ADDRESS,
          true,
        ])
      );
      logger.success("CTF approved for Neg Risk CTF Exchange");
    }
  }

  private async executeSafeTransaction(
    to: string,
    data: string
  ): Promise<void> {
    const settings = getSettings();
    const proxyWallet = settings.apiKeys.polymarket.proxyWalletAddress;
    const provider = await this.rpcRotator.getWorkingProvider();
    const wallet = this.wallet.connect(provider);
    const safe = new Contract(proxyWallet, SAFE_ABI, wallet);

    const ownerAddr = this.wallet.address.toLowerCase().replace("0x", "");
    const signature =
      "0x" +
      "000000000000000000000000" +
      ownerAddr +
      "0000000000000000000000000000000000000000000000000000000000000000" +
      "01";

    const tx = await safe.execTransaction(
      to,
      0,
      data,
      0, // CALL
      0,
      0,
      0,
      AddressZero,
      AddressZero,
      signature,
      { gasLimit: GAS_LIMIT }
    );
    await tx.wait();
  }

  // ---- Target User Position Monitoring ----

  async getTargetPositions(targetAddress?: string): Promise<TargetPosition[]> {
    const settings = getSettings();
    const address = targetAddress || settings.apiKeys.polymarket.proxyWalletAddress;
    const url = `${settings.externalApis.dataApiUrl}/positions`;
    const resp = await axios.get(url, {
      params: {
        user: address,
        sizeThreshold: 0,
        limit: 500,
        sortBy: "TOKENS",
        sortDirection: "DESC",
      },
    });

    return resp.data.map((p: any) => ({
      asset: p.asset,
      conditionId: p.conditionId,
      size: parseFloat(p.size),
      avgPrice: parseFloat(p.avgPrice),
      curPrice: parseFloat(p.curPrice),
      currentValue: parseFloat(p.currentValue),
      title: p.title,
      outcome: p.outcome,
      outcomeIndex: parseInt(p.outcomeIndex),
      slug: p.slug,
      endDate: p.endDate,
      proxyWallet: p.proxyWallet,
    }));
  }

  async getMyPositions(): Promise<MyPosition[]> {
    const settings = getSettings();
    const proxyWallet = settings.apiKeys.polymarket.proxyWalletAddress;
    const url = `${settings.externalApis.dataApiUrl}/positions`;
    const resp = await axios.get(url, {
      params: {
        user: proxyWallet,
        sizeThreshold: 0,
        limit: 500,
        sortBy: "TOKENS",
        sortDirection: "DESC",
      },
    });

    return resp.data.map((p: any) => ({
      asset: p.asset,
      conditionId: p.conditionId,
      size: parseFloat(p.size),
      avgPrice: parseFloat(p.avgPrice),
      curPrice: parseFloat(p.curPrice),
      currentValue: parseFloat(p.currentValue),
      title: p.title,
      outcome: p.outcome,
      outcomeIndex: parseInt(p.outcomeIndex),
    }));
  }

  async getMyPortfolioValue(): Promise<number> {
    const settings = getSettings();
    const proxyWallet = settings.apiKeys.polymarket.proxyWalletAddress;
    const url = `${settings.externalApis.dataApiUrl}/value`;
    const resp = await axios.get(url, {
      params: { user: proxyWallet },
    });
    if (resp.data && resp.data.length > 0) {
      return parseFloat(resp.data[0].value);
    }
    return 0;
  }

  async getUsdcBalance(): Promise<number> {
    const settings = getSettings();
    const proxyWallet = settings.apiKeys.polymarket.proxyWalletAddress;
    const provider = await this.rpcRotator.getWorkingProvider();
    const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, provider);
    const balance = await usdc.balanceOf(proxyWallet);
    return parseFloat(balance.toString()) / 1e6;
  }

  // ---- Market Data ----

  async getMarketInfo(conditionId: string): Promise<MarketInfo | null> {
    if (this.marketCache.has(conditionId)) {
      return this.marketCache.get(conditionId)!;
    }

    const settings = getSettings();
    try {
      const resp = await axios.get(`${settings.externalApis.gammaApiUrl}/markets`, {
        params: { condition_ids: conditionId },
      });

      if (!resp.data || resp.data.length === 0) return null;

      const m = resp.data[0];
      // Gamma API returns some array fields as JSON strings
      const parseField = (v: any, fallback: any[]) => {
        if (Array.isArray(v)) return v;
        if (typeof v === "string") { try { return JSON.parse(v); } catch { return fallback; } }
        return fallback;
      };
      const info: MarketInfo = {
        conditionId: m.conditionId,
        questionId: m.questionID,
        clobTokenIds: parseField(m.clobTokenIds, []),
        outcomes: parseField(m.outcomes, ["Yes", "No"]),
        outcomePrices: parseField(m.outcomePrices, []),
        negRisk: m.negRisk || false,
        active: m.active,
        closed: m.closed,
        acceptingOrders: m.acceptingOrders,
        orderPriceMinTickSize: m.orderPriceMinTickSize || 0.01,
        title: m.question || m.title || "",
        slug: m.slug || "",
      };

      this.marketCache.set(conditionId, info);
      return info;
    } catch (err) {
      logger.error(`Failed to get market info for ${conditionId}:`, err);
      return null;
    }
  }

  // ---- Trading ----

  async placeBuyOrder(
    tokenId: string,
    price: number,
    size: number,
    negRisk: boolean,
    tickSize: string
  ): Promise<string | null> {
    try {
      const resp = await this.clobClient.createAndPostOrder(
        {
          tokenID: tokenId,
          price,
          side: Side.BUY,
          size,
        },
        { tickSize: tickSize as any, negRisk },
        OrderType.GTC
      );

      if (resp.success) {
        logger.trade(
          `BUY order placed: ${size} shares @ $${price} | OrderID: ${resp.orderID}`
        );
        return resp.orderID;
      } else {
        logger.error(`BUY order failed: ${resp.errorMsg}`);
        return null;
      }
    } catch (err) {
      logger.error("Failed to place BUY order:", err);
      return null;
    }
  }

  async placeSellOrder(
    tokenId: string,
    price: number,
    size: number,
    negRisk: boolean,
    tickSize: string
  ): Promise<string | null> {
    try {
      const resp = await this.clobClient.createAndPostOrder(
        {
          tokenID: tokenId,
          price,
          side: Side.SELL,
          size,
        },
        { tickSize: tickSize as any, negRisk },
        OrderType.GTC
      );

      if (resp.success) {
        logger.trade(
          `SELL order placed: ${size} shares @ $${price} | OrderID: ${resp.orderID}`
        );
        return resp.orderID;
      } else {
        logger.error(`SELL order failed: ${resp.errorMsg}`);
        return null;
      }
    } catch (err) {
      logger.error("Failed to place SELL order:", err);
      return null;
    }
  }

  async placeMarketBuy(
    tokenId: string,
    amount: number,
    negRisk: boolean,
    tickSize: string
  ): Promise<string | null> {
    try {
      const resp = await this.clobClient.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          amount,
          side: Side.BUY,
        },
        { tickSize: tickSize as any, negRisk },
        OrderType.FOK
      );

      if (resp.success) {
        logger.trade(
          `Market BUY: $${amount} spent | OrderID: ${resp.orderID}`
        );
        return resp.orderID;
      } else {
        logger.error(`Market BUY failed: ${resp.errorMsg}`);
        return null;
      }
    } catch (err) {
      logger.error("Failed to place market BUY:", err);
      return null;
    }
  }

  async placeMarketSell(
    tokenId: string,
    amount: number,
    negRisk: boolean,
    tickSize: string
  ): Promise<string | null> {
    try {
      const resp = await this.clobClient.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          amount,
          side: Side.SELL,
        },
        { tickSize: tickSize as any, negRisk },
        OrderType.FOK
      );

      if (resp.success) {
        logger.trade(
          `Market SELL: $${amount} worth | OrderID: ${resp.orderID}`
        );
        return resp.orderID;
      } else {
        logger.error(`Market SELL failed: ${resp.errorMsg}`);
        return null;
      }
    } catch (err) {
      logger.error("Failed to place market SELL:", err);
      return null;
    }
  }

  async cancelAllOrders(): Promise<void> {
    try {
      await this.clobClient.cancelAll();
      logger.info("All open orders cancelled");
    } catch (err) {
      logger.error("Failed to cancel all orders:", err);
    }
  }

  // ---- Redemption ----

  async isMarketResolved(conditionId: string): Promise<boolean> {
    try {
      const provider = await this.rpcRotator.getWorkingProvider();
      const ctf = new Contract(CTF_ADDRESS, CTF_ABI, provider);
      const denominator = await ctf.payoutDenominator(conditionId);
      return !denominator.eq(0);
    } catch {
      return false;
    }
  }

  async redeemPosition(conditionId: string): Promise<string | null> {
    try {
      const settings = getSettings();
      const proxyWallet = settings.apiKeys.polymarket.proxyWalletAddress;
      const provider = await this.rpcRotator.getWorkingProvider();
      const ctf = new Contract(CTF_ADDRESS, CTF_ABI, provider);

      const redeemData = ctf.interface.encodeFunctionData("redeemPositions", [
        USDC_ADDRESS,
        HashZero,
        conditionId,
        [1, 2],
      ]);

      const wallet = this.wallet.connect(provider);
      const safe = new Contract(
        proxyWallet,
        SAFE_ABI,
        wallet
      );

      const ownerAddr = this.wallet.address.toLowerCase().replace("0x", "");
      const signature =
        "0x" +
        "000000000000000000000000" +
        ownerAddr +
        "0000000000000000000000000000000000000000000000000000000000000000" +
        "01";

      const tx = await safe.execTransaction(
        CTF_ADDRESS,
        0,
        redeemData,
        0,
        0,
        0,
        0,
        AddressZero,
        AddressZero,
        signature,
        { gasLimit: GAS_LIMIT }
      );
      const receipt = await tx.wait();
      return receipt.transactionHash;
    } catch (err) {
      logger.error(`Failed to redeem position for ${conditionId}:`, err);
      return null;
    }
  }

  getClobClient(): ClobClient {
    return this.clobClient;
  }

  getWalletAddress(): string {
    return this.wallet.address;
  }
}
