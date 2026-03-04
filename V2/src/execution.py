"""Order execution flow for paper/live modes with live safety checks."""

from __future__ import annotations

import secrets
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from typing import Any

from src.models import OpportunityDecision


class ExecutionEngine:
    def __init__(self, config: dict[str, Any], state_store, kalshi_client, polymarket_client):
        self.config = config
        self.store = state_store
        self.kalshi = kalshi_client
        self.poly = polymarket_client
        self.risk_manager = None  # Set by service after portfolio is available
        self.notifier = None  # Set by service after notifications are configured

    def arm_live(self, confirm_token: str | None = None) -> str:
        token = confirm_token or secrets.token_hex(6)
        ttl = int(self.config["live_safety"].get("confirm_token_ttl_sec", 600))
        expires_at = (datetime.now(timezone.utc) + timedelta(seconds=ttl)).isoformat()
        self.store.update_runtime_control(arm_live=1, confirm_token=token, confirm_expires_at=expires_at)
        return token

    def disarm_live(self) -> None:
        self.store.update_runtime_control(arm_live=0, confirm_token=None, confirm_expires_at=None)

    def _live_allowed(self, typed_confirm: str | None) -> tuple[bool, str]:
        ctrl = self.store.get_runtime_control()

        if self.config["live_safety"].get("require_arm", True) and int(ctrl.get("arm_live", 0)) != 1:
            return False, "Live blocked: ARM LIVE is off"

        if self.config["live_safety"].get("require_typed_confirm", True):
            token = ctrl.get("confirm_token")
            exp = ctrl.get("confirm_expires_at")
            if not token or not typed_confirm or token.strip() != typed_confirm.strip():
                return False, "Live blocked: typed confirmation token mismatch"
            if exp and datetime.now(timezone.utc) > datetime.fromisoformat(exp):
                return False, "Live blocked: typed confirmation token expired"

        return True, "ok"

    def execute(self, cycle_id: str, decisions: list[OpportunityDecision], mode: str, typed_confirm: str | None = None) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        tradable = [d for d in decisions if d.trade]

        if mode == "live":
            allowed, reason = self._live_allowed(typed_confirm)
            if not allowed:
                self.store.save_alert("high", reason, details={"cycle_id": cycle_id})
                return [{"status": "blocked", "reason": reason}]

        for d in tradable:
            # Risk check
            if self.risk_manager:
                allowed, reason = self.risk_manager.check_pre_trade(d)
                if not allowed:
                    self.store.save_alert("medium", f"Trade blocked by risk: {reason}", pair_id=d.pair_id)
                    if self.notifier:
                        self.notifier.notify_risk_alert(reason, {"pair_id": d.pair_id, "strategy": d.strategy})
                    results.append({"decision": asdict(d), "status": "risk_blocked", "reason": reason})
                    continue

            idem_base = f"{cycle_id}:{d.pair_id}:{d.strategy}:{d.contracts}"
            if mode == "paper":
                paper_resp_k = {
                    "simulated": True,
                    "venue": "kalshi",
                    "side": d.kalshi_side,
                    "contracts": d.contracts,
                    "price": d.kalshi_price,
                }
                paper_resp_p = {
                    "simulated": True,
                    "venue": "polymarket",
                    "side": d.polymarket_side,
                    "contracts": d.contracts,
                    "price": d.polymarket_price,
                }
                self.store.save_order(cycle_id, f"{idem_base}:kalshi", d.pair_id, "kalshi", mode, d.kalshi_side, d.contracts, d.kalshi_price, "filled", paper_resp_k)
                self.store.save_order(cycle_id, f"{idem_base}:polymarket", d.pair_id, "polymarket", mode, d.polymarket_side, d.contracts, d.polymarket_price, "filled", paper_resp_p)
                if self.notifier:
                    self.notifier.notify_trade_executed(d, mode)
                results.append({"decision": asdict(d), "kalshi": paper_resp_k, "polymarket": paper_resp_p})
                continue

            try:
                resp_k = self.kalshi.place_order(
                    ticker=d.metadata["kalshi_ticker"],
                    side=d.kalshi_side,
                    contracts=d.contracts,
                    price=d.kalshi_price,
                    client_order_id=f"{idem_base}:k",
                )
                self.store.save_order(cycle_id, f"{idem_base}:kalshi", d.pair_id, "kalshi", mode, d.kalshi_side, d.contracts, d.kalshi_price, "submitted", resp_k)
            except Exception as exc:
                self.store.save_alert("high", "Kalshi order failed", pair_id=d.pair_id, details={"error": str(exc), "decision": asdict(d)})
                results.append({"decision": asdict(d), "status": "kalshi_failed", "error": str(exc)})
                continue

            try:
                poly_token = d.metadata["polymarket_yes_token_id"] if d.polymarket_side == "yes" else d.metadata["polymarket_no_token_id"]
                resp_p = self.poly.place_order(token_id=poly_token, side="buy", size=d.contracts, price=d.polymarket_price)
                self.store.save_order(cycle_id, f"{idem_base}:polymarket", d.pair_id, "polymarket", mode, d.polymarket_side, d.contracts, d.polymarket_price, "submitted", resp_p)
                if self.notifier:
                    self.notifier.notify_trade_executed(d, mode)
                results.append({"decision": asdict(d), "kalshi": resp_k, "polymarket": resp_p})
            except Exception as exc:
                self.store.save_alert(
                    "high",
                    "Partial failure: polymarket leg failed after kalshi fill",
                    pair_id=d.pair_id,
                    details={"error": str(exc), "decision": asdict(d), "kalshi_response": resp_k},
                )
                if self.notifier:
                    self.notifier.notify_risk_alert(
                        "Partial failure: polymarket leg failed after kalshi fill",
                        {"pair_id": d.pair_id, "error": str(exc)},
                    )
                results.append({"decision": asdict(d), "status": "partial_failure", "error": str(exc), "kalshi": resp_k})

        return results