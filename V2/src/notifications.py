"""Notification system for Telegram and Discord webhook alerts."""

from __future__ import annotations

import logging
from typing import Any

import requests

from src.models import OpportunityDecision

logger = logging.getLogger(__name__)


class NotificationService:
    def __init__(self, config: dict[str, Any]):
        notif_cfg = config.get("notifications", {})
        self.enabled = notif_cfg.get("enabled", False)
        self.notify_on = notif_cfg.get("notify_on", {})

        self.telegram_token: str | None = None
        self.telegram_chat_id: str | None = None
        tg = notif_cfg.get("telegram", {})
        if tg.get("bot_token") and tg.get("chat_id"):
            self.telegram_token = tg["bot_token"]
            self.telegram_chat_id = str(tg["chat_id"])

        self.discord_webhook: str | None = None
        dc = notif_cfg.get("discord", {})
        if dc.get("webhook_url"):
            self.discord_webhook = dc["webhook_url"]

    def send(self, title: str, body: str, severity: str = "info") -> None:
        """Send to all configured channels. Non-blocking, swallows errors."""
        if not self.enabled:
            return
        if self.telegram_token:
            self._send_telegram(title, body)
        if self.discord_webhook:
            self._send_discord(title, body, severity)

    def _send_telegram(self, title: str, body: str) -> None:
        try:
            text = f"*{title}*\n{body}"
            requests.post(
                f"https://api.telegram.org/bot{self.telegram_token}/sendMessage",
                json={"chat_id": self.telegram_chat_id, "text": text, "parse_mode": "Markdown"},
                timeout=10,
            )
        except Exception:
            logger.debug("Telegram notification failed", exc_info=True)

    def _send_discord(self, title: str, body: str, severity: str) -> None:
        try:
            color_map = {"info": 3447003, "warning": 16776960, "high": 15158332}
            requests.post(
                self.discord_webhook,
                json={
                    "embeds": [
                        {
                            "title": title,
                            "description": body,
                            "color": color_map.get(severity, 3447003),
                        }
                    ]
                },
                timeout=10,
            )
        except Exception:
            logger.debug("Discord notification failed", exc_info=True)

    # --- Convenience methods ---

    def notify_trade_executed(self, decision: OpportunityDecision, mode: str) -> None:
        if not self.notify_on.get("trade_executed", True):
            return
        self.send(
            f"Trade Executed [{mode.upper()}]",
            (
                f"Pair: {decision.pair_id}\n"
                f"Strategy: {decision.strategy}\n"
                f"Contracts: {decision.contracts}\n"
                f"Edge: ${decision.edge_dollar:.4f} ({decision.edge_pct:.2%})\n"
                f"Annualized: {decision.annualized_edge:.1%}"
            ),
        )

    def notify_risk_alert(self, message: str, details: dict[str, Any]) -> None:
        if not self.notify_on.get("risk_alert", True):
            return
        detail_lines = "\n".join(f"{k}: {v}" for k, v in details.items())
        self.send("Risk Alert", f"{message}\n{detail_lines}", severity="high")

    def notify_copy_signal(self, signal: dict[str, Any]) -> None:
        if not self.notify_on.get("copy_signal", True):
            return
        self.send(
            "Copy Trading Signal",
            (
                f"Trader: {signal.get('trader_name', signal.get('trader_address', '?'))}\n"
                f"Market: {signal.get('market_title', '?')}\n"
                f"Side: {signal.get('side', '?')}\n"
                f"Size: ${signal.get('cash_value', 0):.2f}\n"
                f"Suspicion Score: {signal.get('suspicion_score', 0)}"
            ),
        )

    def notify_circuit_breaker(self, reason: str) -> None:
        if not self.notify_on.get("circuit_breaker", True):
            return
        self.send("CIRCUIT BREAKER TRIGGERED", reason, severity="high")
