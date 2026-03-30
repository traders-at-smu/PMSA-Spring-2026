"""Kalshi REST client for market data and live order placement."""

from __future__ import annotations

import base64
import time
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding


class KalshiClient:
    def __init__(self, config: dict[str, Any]):
        api_cfg = config["api"]["kalshi"]
        env = api_cfg.get("environment", "prod")
        self.base_url = api_cfg["base_url_prod"] if env == "prod" else api_cfg["base_url_demo"]
        self.access_key_id = api_cfg.get("access_key_id", "")
        self._private_key = self._load_private_key(api_cfg)
        self.timeout = 10
        self.resolve_markets_via_api = bool(api_cfg.get("resolve_markets_via_api", True))
        self.market_discovery_cache_ttl_sec = int(api_cfg.get("market_discovery_cache_ttl_sec", 300))
        self.market_discovery_max_pages = int(api_cfg.get("market_discovery_max_pages", 20))
        self.market_title_min_score = float(api_cfg.get("market_title_min_score", 0.5))
        self.series_discovery_cache_ttl_sec = int(api_cfg.get("series_discovery_cache_ttl_sec", 600))
        self.series_title_min_score = float(api_cfg.get("series_title_min_score", 0.2))
        self._market_cache: dict[str, dict[str, Any] | None] = {}
        self._event_markets_cache: dict[str, list[dict[str, Any]]] = {}
        self._series_markets_cache: dict[str, list[dict[str, Any]]] = {}
        self._series_cache: list[dict[str, Any]] = []
        self._series_cache_expiry = 0.0
        self._open_markets_cache: list[dict[str, Any]] = []
        self._open_markets_cache_expiry = 0.0

    def _load_private_key(self, api_cfg: dict[str, Any]):
        private_key_b64 = api_cfg.get("private_key_base64", "")
        private_key_path = api_cfg.get("private_key_path", "")

        key_bytes = b""
        if private_key_b64:
            key_bytes = base64.b64decode(private_key_b64)
        elif private_key_path and Path(private_key_path).exists():
            key_bytes = Path(private_key_path).read_bytes()

        if not key_bytes:
            return None

        return serialization.load_pem_private_key(key_bytes, password=None)

    def _signed_headers(self, method: str, path: str) -> dict[str, str]:
        if not self._private_key or not self.access_key_id:
            raise RuntimeError("Kalshi live trading requires access_key_id and private key")

        ts_ms = str(int(time.time() * 1000))
        msg = f"{ts_ms}{method.upper()}{path}".encode("utf-8")
        sig = self._private_key.sign(
            msg,
            padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH),
            hashes.SHA256(),
        )
        sig_b64 = base64.b64encode(sig).decode("utf-8")
        return {
            "KALSHI-ACCESS-KEY": self.access_key_id,
            "KALSHI-ACCESS-TIMESTAMP": ts_ms,
            "KALSHI-ACCESS-SIGNATURE": sig_b64,
            "Content-Type": "application/json",
        }

    @staticmethod
    def _coerce_float(value: Any) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return 0.0

    @staticmethod
    def _is_open_market(market: dict[str, Any] | None) -> bool:
        status = str((market or {}).get("status", "")).strip().lower()
        return status in {"active", "open"}

    @staticmethod
    def _event_ticker_from_market_like(value: str) -> str:
        ticker = str(value or "").strip()
        if not ticker:
            return ""
        if "/" in ticker:
            ticker = ticker.split("/")[-1].strip()
        ticker = ticker.upper()
        if ticker.count("-") >= 2:
            return ticker.rsplit("-", 1)[0]
        return ticker

    @staticmethod
    def _ticker_from_kalshi_url(url: str) -> str:
        s = str(url or "").strip()
        if not s:
            return ""
        parsed = urlparse(s)
        parts = [p for p in parsed.path.split("/") if p]
        for i, part in enumerate(parts):
            if part.lower() == "markets" and i + 1 < len(parts):
                return "/".join(parts[i + 1 :]).strip()
        return ""

    @staticmethod
    def _normalize_text(text: str) -> str:
        allowed = []
        for ch in str(text or "").lower():
            if ch.isalnum():
                allowed.append(ch)
            else:
                allowed.append(" ")
        return " ".join("".join(allowed).split())

    @classmethod
    def _title_similarity(cls, query: str, title: str) -> float:
        stop_words = {
            "a",
            "an",
            "and",
            "are",
            "at",
            "be",
            "by",
            "for",
            "from",
            "has",
            "have",
            "if",
            "in",
            "is",
            "no",
            "of",
            "on",
            "or",
            "the",
            "to",
            "under",
            "over",
            "what",
            "when",
            "where",
            "who",
            "will",
            "win",
            "wins",
            "with",
            "yes",
        }
        q = cls._normalize_text(query)
        t = cls._normalize_text(title)
        if not q or not t:
            return 0.0
        aliases = {
            "basketball": "nba",
            "nba": "nba",
            "football": "nfl",
            "nfl": "nfl",
            "baseball": "mlb",
            "mlb": "mlb",
            "hockey": "nhl",
            "nhl": "nhl",
            "soccer": "soccer",
            "futbol": "soccer",
            "champion": "championship",
            "champions": "championship",
            "final": "finals",
            "finals": "finals",
        }

        def _canon(tok: str) -> str:
            return aliases.get(tok, tok)

        q_tokens = [_canon(tok) for tok in q.split() if tok not in stop_words and len(tok) > 2]
        t_tokens = [_canon(tok) for tok in t.split() if tok not in stop_words and len(tok) > 2]
        if not q_tokens or not t_tokens:
            return 0.0
        q_set = set(q_tokens)
        t_set = set(t_tokens)
        overlap_count = len(q_set & t_set)
        required_overlap = 1 if len(q_set) <= 2 else 2
        if overlap_count < required_overlap:
            return 0.0

        seq_score = SequenceMatcher(None, q, t).ratio()
        query_coverage = overlap_count / len(q_set)
        candidate_precision = overlap_count / len(t_set)
        blended = (0.2 * seq_score) + (0.4 * query_coverage) + (0.4 * candidate_precision)
        return max(query_coverage, blended)

    @classmethod
    def _market_rank_key(cls, market: dict[str, Any]) -> tuple[float, float, float, str]:
        return (
            cls._coerce_float(market.get("liquidity", 0)),
            cls._coerce_float(market.get("volume_24h", market.get("volume", 0))),
            cls._coerce_float(market.get("open_interest", 0)),
            str(market.get("updated_time", "")),
        )

    @classmethod
    def _best_market(cls, markets: list[dict[str, Any]]) -> dict[str, Any] | None:
        candidates = [m for m in markets if isinstance(m, dict) and str(m.get("ticker", "")).strip()]
        if not candidates:
            return None
        candidates.sort(
            key=lambda m: (
                1 if cls._is_open_market(m) else 0,
                *cls._market_rank_key(m),
            ),
            reverse=True,
        )
        return candidates[0]

    def get_market(self, ticker: str) -> dict[str, Any] | None:
        t = str(ticker or "").strip()
        if not t:
            return None
        if t in self._market_cache:
            return self._market_cache[t]

        url = f"{self.base_url}/markets/{t}"
        res = requests.get(url, timeout=self.timeout)
        if res.status_code == 404:
            self._market_cache[t] = None
            return None
        res.raise_for_status()
        market = res.json().get("market")
        if not isinstance(market, dict):
            market = None
        self._market_cache[t] = market
        return market

    def _list_markets(
        self,
        status: str | None = None,
        event_ticker: str | None = None,
        series_ticker: str | None = None,
    ) -> list[dict[str, Any]]:
        markets: list[dict[str, Any]] = []
        cursor: str | None = None
        pages = 0

        while True:
            params: dict[str, Any] = {"limit": 500}
            if status:
                params["status"] = status
            if event_ticker:
                params["event_ticker"] = event_ticker
            if series_ticker:
                params["series_ticker"] = series_ticker
            if cursor:
                params["cursor"] = cursor

            res = requests.get(f"{self.base_url}/markets", params=params, timeout=self.timeout)
            res.raise_for_status()
            payload = res.json()
            page_markets = payload.get("markets", [])
            if not isinstance(page_markets, list):
                break
            markets.extend([m for m in page_markets if isinstance(m, dict)])

            cursor = payload.get("cursor")
            pages += 1
            if not cursor or not page_markets or pages >= self.market_discovery_max_pages:
                break
            if event_ticker and pages >= 3:
                break
            if series_ticker and pages >= 8:
                break

        return markets

    def _series_catalog(self) -> list[dict[str, Any]]:
        now = time.time()
        if now < self._series_cache_expiry and self._series_cache:
            return self._series_cache

        res = requests.get(f"{self.base_url}/series", params={"limit": 10000}, timeout=self.timeout)
        res.raise_for_status()
        payload = res.json()
        series = payload.get("series", [])
        if not isinstance(series, list):
            series = []

        self._series_cache = [s for s in series if isinstance(s, dict)]
        self._series_cache_expiry = now + max(1, self.series_discovery_cache_ttl_sec)
        self._series_markets_cache.clear()
        return self._series_cache

    def _best_series_ticker_for_title(self, title_hint: str, category_hint: str = "") -> str:
        hint = str(title_hint or "").strip()
        if not hint:
            return ""
        target_category = str(category_hint or "").strip().lower()

        best_ticker = ""
        best_score = 0.0
        for series in self._series_catalog():
            if target_category and target_category != "default":
                series_category = str(series.get("category", "")).strip().lower()
                if series_category and series_category != target_category:
                    continue

            series_title = str(series.get("title", ""))
            score = self._title_similarity(hint, series_title)
            if score < self.series_title_min_score:
                continue
            ticker = str(series.get("ticker", "")).strip()
            if score > best_score and ticker:
                best_score = score
                best_ticker = ticker

        return best_ticker

    def _markets_for_series(self, series_ticker: str) -> list[dict[str, Any]]:
        st = str(series_ticker or "").strip()
        if not st:
            return []
        if st in self._series_markets_cache:
            return self._series_markets_cache[st]
        markets = self._list_markets(status="open", series_ticker=st)
        self._series_markets_cache[st] = markets
        return markets

    def _markets_for_event(self, event_ticker: str) -> list[dict[str, Any]]:
        et = str(event_ticker or "").strip()
        if not et:
            return []
        if et in self._event_markets_cache:
            return self._event_markets_cache[et]

        markets = self._list_markets(status="open", event_ticker=et)
        self._event_markets_cache[et] = markets
        return markets

    def _open_markets(self) -> list[dict[str, Any]]:
        now = time.time()
        if now < self._open_markets_cache_expiry and self._open_markets_cache:
            return self._open_markets_cache

        markets = self._list_markets(status="open")
        if not markets:
            all_markets = self._list_markets()
            markets = [m for m in all_markets if self._is_open_market(m)]

        self._open_markets_cache = markets
        self._open_markets_cache_expiry = now + max(1, self.market_discovery_cache_ttl_sec)
        return markets

    def resolve_market_ticker(self, mapping_row: dict[str, Any]) -> str:
        configured_ticker = str(mapping_row.get("kalshi_ticker", "")).strip()
        url_ticker = self._ticker_from_kalshi_url(str(mapping_row.get("kalshi_url", "")))
        title_hint = str(mapping_row.get("kalshi_title_hint", mapping_row.get("notes", ""))).strip()
        category_hint = str(mapping_row.get("category", "")).strip()

        candidates: list[str] = []
        for c in [configured_ticker, url_ticker]:
            if c and c not in candidates:
                candidates.append(c)

        for candidate in candidates:
            market = self.get_market(candidate)
            if market and self._is_open_market(market):
                return candidate

            event_ticker = ""
            if market:
                event_ticker = str(market.get("event_ticker", "")).strip()
            if not event_ticker:
                event_ticker = self._event_ticker_from_market_like(candidate)
            event_best = self._best_market(self._markets_for_event(event_ticker))
            if event_best:
                ticker = str(event_best.get("ticker", "")).strip()
                if ticker:
                    return ticker

        if self.resolve_markets_via_api and title_hint:
            series_ticker = self._best_series_ticker_for_title(title_hint, category_hint=category_hint)
            series_markets = self._markets_for_series(series_ticker) if series_ticker else []
            best_market = None
            best_key: tuple[float, float, float, float, str] | None = None
            for market in series_markets:
                market_title = str(market.get("title", ""))
                market_subtitle = str(market.get("subtitle", market.get("sub_title", "")))
                market_yes_sub = str(market.get("yes_sub_title", ""))
                market_no_sub = str(market.get("no_sub_title", ""))
                score = self._title_similarity(
                    title_hint,
                    f"{market_title} {market_subtitle} {market_yes_sub} {market_no_sub}".strip(),
                )
                if score < self.market_title_min_score:
                    continue
                rank = self._market_rank_key(market)
                candidate_key = (score, *rank)
                if best_key is None or candidate_key > best_key:
                    best_market = market
                    best_key = candidate_key
            if best_market:
                ticker = str(best_market.get("ticker", "")).strip()
                if ticker:
                    return ticker

            best_market: dict[str, Any] | None = None
            best_key: tuple[float, float, float, float, str] | None = None
            for market in self._open_markets():
                market_title = str(market.get("title", ""))
                market_subtitle = str(market.get("subtitle", market.get("sub_title", "")))
                market_yes_sub = str(market.get("yes_sub_title", ""))
                market_no_sub = str(market.get("no_sub_title", ""))
                score = self._title_similarity(
                    title_hint,
                    f"{market_title} {market_subtitle} {market_yes_sub} {market_no_sub}".strip(),
                )
                if score < self.market_title_min_score:
                    continue
                rank = self._market_rank_key(market)
                candidate_key = (score, *rank)
                if best_key is None or candidate_key > best_key:
                    best_market = market
                    best_key = candidate_key

            if best_market:
                ticker = str(best_market.get("ticker", "")).strip()
                if ticker:
                    return ticker

        for fallback in [configured_ticker, url_ticker]:
            if fallback:
                return fallback
        return ""

    def get_orderbook(self, ticker: str) -> dict[str, Any]:
        t = str(ticker or "").strip()
        if not t:
            raise RuntimeError("Kalshi ticker is empty")
        if not self.get_market(t):
            raise RuntimeError(f"Kalshi market not found: {t}")
        url = f"{self.base_url}/markets/{t}/orderbook"
        res = requests.get(url, timeout=self.timeout)
        res.raise_for_status()
        return res.json()

    @staticmethod
    def _extract_price_size(level: Any) -> tuple[int, int]:
        if isinstance(level, dict):
            price = level.get("price", level.get("yes_price", level.get("no_price", 0)))
            size = level.get("count", level.get("quantity", level.get("size", 0)))
        elif isinstance(level, (list, tuple)):
            price = level[0] if len(level) > 0 else 0
            size = level[1] if len(level) > 1 else 0
        else:
            return 0, 0

        try:
            price_cents = int(float(price))
            qty = int(float(size))
        except (TypeError, ValueError):
            return 0, 0
        if qty <= 0:
            return 0, 0
        return price_cents, qty

    @classmethod
    def _best_bid(cls, bids: list[Any]) -> float:
        best_cents = max((cls._extract_price_size(level)[0] for level in bids), default=0)
        return max(0.0, min(1.0, best_cents / 100.0))

    @classmethod
    def _derive_asks_from_opposite_bids(cls, opposite_bids: list[Any]) -> list[dict[str, Any]]:
        asks_by_price: dict[float, int] = {}
        for level in opposite_bids:
            bid_cents, qty = cls._extract_price_size(level)
            if qty <= 0:
                continue
            ask = round((100 - bid_cents) / 100.0, 6)
            if ask < 0.0 or ask > 1.0:
                continue
            asks_by_price[ask] = asks_by_price.get(ask, 0) + qty
        return [{"price": p, "size": asks_by_price[p]} for p in sorted(asks_by_price)]

    def get_quotes(self, ticker: str) -> dict[str, Any]:
        market = self.get_market(ticker)
        if not market:
            raise RuntimeError(f"Kalshi market not found: {ticker}")
        if not self._is_open_market(market):
            status = str(market.get("status", "")).strip().lower() or "unknown"
            raise RuntimeError(f"Kalshi market '{ticker}' is '{status}', expected active/open")
        data = self.get_orderbook(ticker)
        ob = data.get("orderbook", {})
        yes_bids = ob.get("yes", [])
        no_bids = ob.get("no", [])

        yes_bid = self._best_bid(yes_bids)
        no_bid = self._best_bid(no_bids)
        yes_ask = max(0.0, 1.0 - no_bid)
        no_ask = max(0.0, 1.0 - yes_bid)
        buy_yes_asks = self._derive_asks_from_opposite_bids(no_bids)
        buy_no_asks = self._derive_asks_from_opposite_bids(yes_bids)

        return {
            "yes_bid": yes_bid,
            "yes_ask": yes_ask,
            "no_bid": no_bid,
            "no_ask": no_ask,
            "depth": {
                "buy_yes": buy_yes_asks,
                "buy_no": buy_no_asks,
            },
            "raw": {
                "orderbook": data,
                "market": market,
            },
        }

    def place_order(self, ticker: str, side: str, contracts: int, price: float, client_order_id: str) -> dict[str, Any]:
        path = "/portfolio/orders"
        payload = {
            "ticker": ticker,
            "client_order_id": client_order_id,
            "type": "limit",
            "action": "buy",
            "side": side,
            "count": contracts,
            "yes_price": int(round(price * 100)) if side == "yes" else None,
            "no_price": int(round(price * 100)) if side == "no" else None,
        }
        payload = {k: v for k, v in payload.items() if v is not None}

        url = f"{self.base_url}{path}"
        headers = self._signed_headers("POST", path)
        res = requests.post(url, json=payload, headers=headers, timeout=self.timeout)
        res.raise_for_status()
        return res.json()
