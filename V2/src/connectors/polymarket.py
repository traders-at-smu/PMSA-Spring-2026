"""Polymarket CLOB client for market data and live order placement."""

from __future__ import annotations

import json
from typing import Any

import requests


class PolymarketClient:
    def __init__(self, config: dict[str, Any]):
        api_cfg = config["api"]["polymarket"]
        self.host = api_cfg["clob_host"].rstrip("/")
        self.chain_id = int(api_cfg.get("chain_id", 137))
        self.private_key = api_cfg.get("private_key", "")
        self.api_key = api_cfg.get("api_key", "")
        self.api_secret = api_cfg.get("api_secret", "")
        self.api_passphrase = api_cfg.get("api_passphrase", "")
        self.timeout = 10
        self._client = None
        self.gamma_host = api_cfg.get("gamma_host", "https://gamma-api.polymarket.com").rstrip("/")

    def _ensure_clob_client(self):
        if self._client is not None:
            return
        try:
            from py_clob_client.client import ClobClient
        except Exception as exc:
            raise RuntimeError("py-clob-client is required for live Polymarket trading") from exc

        if not self.private_key:
            raise RuntimeError("Missing polymarket private_key for live mode")

        self._client = ClobClient(
            host=self.host,
            key=self.private_key,
            chain_id=self.chain_id,
            creds={
                "key": self.api_key,
                "secret": self.api_secret,
                "passphrase": self.api_passphrase,
            }
            if self.api_key and self.api_secret and self.api_passphrase
            else None,
        )

    def get_book(self, token_id: str) -> dict[str, Any]:
        url = f"{self.host}/book"
        res = requests.get(url, params={"token_id": token_id}, timeout=self.timeout)
        res.raise_for_status()
        return res.json()

    @staticmethod
    def _parse_list_field(value: Any) -> list[str]:
        if isinstance(value, list):
            return [str(v) for v in value]
        if isinstance(value, str):
            s = value.strip()
            if not s:
                return []
            try:
                parsed = json.loads(s)
                if isinstance(parsed, list):
                    return [str(v) for v in parsed]
            except json.JSONDecodeError:
                return [s]
        return []

    def resolve_tokens_from_slug(self, market_slug: str) -> dict[str, str]:
        if not market_slug:
            raise RuntimeError("Cannot resolve Polymarket token IDs without market slug")

        url = f"{self.gamma_host}/markets"
        res = requests.get(url, params={"slug": market_slug}, timeout=self.timeout)
        res.raise_for_status()
        payload = res.json()
        if not isinstance(payload, list) or not payload:
            raise RuntimeError(f"No Polymarket market found for slug '{market_slug}'")

        market = payload[0]
        token_ids = self._parse_list_field(market.get("clobTokenIds"))
        outcomes = [o.strip().lower() for o in self._parse_list_field(market.get("outcomes"))]
        if len(token_ids) < 2:
            raise RuntimeError(f"Polymarket market '{market_slug}' does not contain two outcome token IDs")

        yes_idx, no_idx = 0, 1
        if len(outcomes) >= 2:
            if "yes" in outcomes and "no" in outcomes:
                yes_idx = outcomes.index("yes")
                no_idx = outcomes.index("no")

        return {
            "yes_token_id": token_ids[yes_idx],
            "no_token_id": token_ids[no_idx],
            "resolution_time_utc": str(market.get("endDate", "")),
            "market_id": str(market.get("id", "")),
            "question": str(market.get("question", "")),
        }

    def _extract_best_prices(self, book_data: dict[str, Any]) -> tuple[float, float]:
        bids = book_data.get("bids", [])
        asks = book_data.get("asks", [])

        def _p(level: Any) -> float:
            if isinstance(level, dict):
                return float(level.get("price", 0.0))
            if isinstance(level, (list, tuple)) and level:
                return float(level[0])
            return 0.0

        best_bid = max((_p(b) for b in bids), default=0.0)
        best_ask = min((_p(a) for a in asks), default=1.0)
        return best_bid, best_ask

    @staticmethod
    def _extract_price_size(level: Any) -> tuple[float, int]:
        if isinstance(level, dict):
            price = level.get("price", 0.0)
            size = level.get("size", level.get("quantity", level.get("amount", 0)))
        elif isinstance(level, (list, tuple)):
            price = level[0] if len(level) > 0 else 0.0
            size = level[1] if len(level) > 1 else 0
        else:
            return 0.0, 0

        try:
            p = float(price)
            qty = int(float(size))
        except (TypeError, ValueError):
            return 0.0, 0
        if qty <= 0:
            return 0.0, 0
        if p < 0.0 or p > 1.0:
            return 0.0, 0
        return p, qty

    @classmethod
    def _normalize_asks(cls, book_data: dict[str, Any]) -> list[dict[str, Any]]:
        asks = book_data.get("asks", [])
        asks_by_price: dict[float, int] = {}
        for level in asks:
            price, qty = cls._extract_price_size(level)
            if qty <= 0:
                continue
            rp = round(price, 6)
            asks_by_price[rp] = asks_by_price.get(rp, 0) + qty
        return [{"price": p, "size": asks_by_price[p]} for p in sorted(asks_by_price)]

    def get_quotes(
        self,
        yes_token_id: str,
        no_token_id: str,
        market_slug: str | None = None,
    ) -> dict[str, Any]:
        resolved: dict[str, str] = {}
        yid = str(yes_token_id or "").strip()
        nid = str(no_token_id or "").strip()

        if (not yid or not nid) and market_slug:
            resolved = self.resolve_tokens_from_slug(market_slug)
            yid = resolved["yes_token_id"]
            nid = resolved["no_token_id"]

        try:
            yes_book = self.get_book(yid)
            no_book = self.get_book(nid)
        except requests.HTTPError as exc:
            status = getattr(exc.response, "status_code", None)
            # Fallback for stale token IDs in mapping: re-resolve from slug and retry.
            if status == 404 and market_slug:
                resolved = self.resolve_tokens_from_slug(market_slug)
                yid = resolved["yes_token_id"]
                nid = resolved["no_token_id"]
                yes_book = self.get_book(yid)
                no_book = self.get_book(nid)
            else:
                raise

        yes_bid, yes_ask = self._extract_best_prices(yes_book)
        no_bid, no_ask = self._extract_best_prices(no_book)

        return {
            "yes_bid": yes_bid,
            "yes_ask": yes_ask,
            "no_bid": no_bid,
            "no_ask": no_ask,
            "depth": {
                "yes_asks": self._normalize_asks(yes_book),
                "no_asks": self._normalize_asks(no_book),
            },
            "raw": {
                "yes": yes_book,
                "no": no_book,
            },
            "resolved": resolved,
            "yes_token_id": yid,
            "no_token_id": nid,
        }

    def place_order(self, token_id: str, side: str, size: int, price: float) -> dict[str, Any]:
        if side.lower() != "buy":
            raise RuntimeError("Polymarket client currently supports BUY side only")

        self._ensure_clob_client()

        from py_clob_client.clob_types import OrderArgs

        order = self._client.create_order(
            OrderArgs(
                token_id=str(token_id),
                price=float(price),
                size=float(size),
                side="BUY",
            )
        )
        return self._client.post_order(order, order_type="GTC")
