import { JsonRpcProvider } from "@ethersproject/providers";
import { config } from "./config";
import { logger } from "./logger";
import fs from "fs";
import path from "path";

export class RpcRotator {
  private urls: string[];
  private currentIndex: number = 0;
  private provider: JsonRpcProvider;

  constructor() {
    this.urls = this.loadRpcUrls();
    this.provider = new JsonRpcProvider(this.urls[0]);
    logger.info(`RPC Rotator initialized with ${this.urls.length} endpoint(s)`);
  }

  private loadRpcUrls(): string[] {
    const rpcFilePath = path.join(process.cwd(), "rpcUrls.json");
    if (fs.existsSync(rpcFilePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(rpcFilePath, "utf-8"));
        if (data.rpcUrls && data.rpcUrls.length > 0) {
          logger.info(`Loaded ${data.rpcUrls.length} RPC URLs from rpcUrls.json`);
          return data.rpcUrls;
        }
      } catch {
        logger.warn("Failed to parse rpcUrls.json, using default RPC_URL");
      }
    }
    return [config.rpcUrl];
  }

  getProvider(): JsonRpcProvider {
    return this.provider;
  }

  rotate(): JsonRpcProvider {
    this.currentIndex = (this.currentIndex + 1) % this.urls.length;
    this.provider = new JsonRpcProvider(this.urls[this.currentIndex]);
    logger.debug(`Rotated to RPC endpoint ${this.currentIndex + 1}/${this.urls.length}`);
    return this.provider;
  }

  async getWorkingProvider(): Promise<JsonRpcProvider> {
    const startIndex = this.currentIndex;
    let attempts = 0;

    while (attempts < this.urls.length) {
      try {
        await this.provider.getBlockNumber();
        return this.provider;
      } catch {
        logger.warn(`RPC endpoint ${this.currentIndex + 1} failed, rotating...`);
        this.rotate();
        attempts++;
      }
    }

    // Reset to original and throw
    this.currentIndex = startIndex;
    this.provider = new JsonRpcProvider(this.urls[startIndex]);
    throw new Error("All RPC endpoints are unreachable");
  }

  async getGasPrice(): Promise<bigint> {
    const provider = await this.getWorkingProvider();
    const gasPrice = await provider.getGasPrice();
    return gasPrice.toBigInt();
  }

  async isGasPriceAcceptable(): Promise<boolean> {
    try {
      const gasPrice = await this.getGasPrice();
      const limit = BigInt(config.gasPriceLimit);
      if (gasPrice > limit) {
        logger.warn(`Gas price ${gasPrice} exceeds limit ${limit}`);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }
}
