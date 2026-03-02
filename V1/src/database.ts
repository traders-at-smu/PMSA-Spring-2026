import mongoose from "mongoose";
import { config } from "./config";
import { logger } from "./logger";

const tradeSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  type: { type: String, enum: ["BUY", "SELL"], required: true },
  conditionId: { type: String, required: true },
  asset: { type: String, required: true },
  title: { type: String, required: true },
  outcome: { type: String, required: true },
  size: { type: Number, required: true },
  price: { type: Number, required: true },
  orderId: String,
  status: { type: String, enum: ["SUCCESS", "FAILED", "PENDING"], required: true },
  errorMessage: String,
});

const redemptionSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  conditionId: { type: String, required: true },
  title: { type: String, required: true },
  outcome: { type: String, required: true },
  tokensRedeemed: { type: Number, required: true },
  usdcReceived: { type: Number, required: true },
  txHash: String,
  status: { type: String, enum: ["SUCCESS", "FAILED"], required: true },
});

const positionSnapshotSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  user: { type: String, required: true },
  positions: [
    {
      asset: String,
      conditionId: String,
      size: Number,
      curPrice: Number,
      title: String,
      outcome: String,
    },
  ],
});

export const TradeModel = mongoose.model("Trade", tradeSchema);
export const RedemptionModel = mongoose.model("Redemption", redemptionSchema);
export const PositionSnapshotModel = mongoose.model("PositionSnapshot", positionSnapshotSchema);

export async function connectDatabase(): Promise<void> {
  try {
    await mongoose.connect(config.mongoUri);
    logger.success("Connected to MongoDB");
  } catch (err) {
    logger.error("Failed to connect to MongoDB:", err);
    throw err;
  }
}

export async function recordTrade(trade: {
  type: "BUY" | "SELL";
  conditionId: string;
  asset: string;
  title: string;
  outcome: string;
  size: number;
  price: number;
  orderId?: string;
  status: "SUCCESS" | "FAILED" | "PENDING";
  errorMessage?: string;
}): Promise<void> {
  try {
    await TradeModel.create(trade);
  } catch (err) {
    logger.error("Failed to record trade:", err);
  }
}

export async function recordRedemption(redemption: {
  conditionId: string;
  title: string;
  outcome: string;
  tokensRedeemed: number;
  usdcReceived: number;
  txHash?: string;
  status: "SUCCESS" | "FAILED";
}): Promise<void> {
  try {
    await RedemptionModel.create(redemption);
  } catch (err) {
    logger.error("Failed to record redemption:", err);
  }
}
