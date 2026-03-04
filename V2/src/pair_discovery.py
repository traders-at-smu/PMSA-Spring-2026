"""Automated pair discovery: fuzzy-match Kalshi and Polymarket markets by title."""

from __future__ import annotations

import logging
import time
from difflib import SequenceMatcher
from typing import Any

import requests

logger = logging.getLogger(__name__)

GAMMA_API = "https://gamma-api.polymarket.com"


# --- Text similarity utilities (extracted from KalshiClient pattern) ---

_STOP_WORDS = {
    "a", "an", "and", "are", "at", "be", "by", "for", "from", "has", "have",
    "if", "in", "is", "no", "of", "on", "or", "the", "to", "under", "over",
    "what", "when", "where", "who", "will", "win", "wins", "with", "yes",
}

_ALIASES = {
    "basketball": "nba", "nba": "nba", "football": "nfl", "nfl": "nfl",
    "baseball": "mlb", "mlb": "mlb", "hockey": "nhl", "nhl": "nhl",
    "soccer": "soccer", "futbol": "soccer", "champion": "championship",
    "champions": "championship", "final": "finals", "finals": "finals",
}


def normalize_text(text: str) -> str:
    allowed = []
    for ch in str(text or "").lower():
        if ch.isalnum():
            allowed.append(ch)
        else:
            allowed.append(" ")
    return " ".join("".join(allowed).split())


def title_similarity(query: str, title: str) -> float:
    """Compute blended title similarity score (0.0 - 1.0)."""
    q = normalize_text(query)
    t = normalize_text(title)
    if not q or not t:
        return 0.0

    def _canon(tok: str) -> str:
        return _ALIASES.get(tok, tok)

    q_tokens = [_canon(tok) for tok in q.split() if tok not in _STOP_WORDS and len(tok) > 2]
    t_tokens = [_canon(tok) for tok in t.split() if tok not in _STOP_WORDS and len(tok) > 2]
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


class PairDiscovery:
    def __init__(self, config: dict[str, Any], kalshi_client, polymarket_client):
        self.kalshi = kalshi_client
        self.poly = polymarket_client
        disc_cfg = config.get("pair_discovery", {})
        self.enabled = disc_cfg.get("enabled", False)
        self.min_similarity = disc_cfg.get("min_similarity", 0.6)
        self.refresh_interval = disc_cfg.get("refresh_interval_seconds", 3600)
        self.max_discovered = disc_cfg.get("max_discovered_pairs", 50)
        self.auto_activate = disc_cfg.get("auto_activate", False)
        self._last_refresh: float = 0.0
        self._cache: list[dict[str, Any]] = []

    def fetch_polymarket_active_markets(self) -> list[dict[str, Any]]:
        """Fetch all active Polymarket markets from Gamma API."""
        markets: list[dict[str, Any]] = []
        offset = 0
        limit = 100
        while True:
            try:
                resp = requests.get(
                    f"{GAMMA_API}/markets",
                    params={"active": "true", "closed": "false", "limit": limit, "offset": offset},
                    timeout=20,
                )
                resp.raise_for_status()
                batch = resp.json()
                if not batch:
                    break
                markets.extend(batch)
                if len(batch) < limit:
                    break
                offset += limit
            except Exception:
                logger.warning("Failed to fetch Polymarket markets page", exc_info=True)
                break
        return markets

    def fetch_kalshi_active_markets(self) -> list[dict[str, Any]]:
        """Fetch active Kalshi markets using the client's discovery mechanism."""
        try:
            return self.kalshi._open_markets()
        except Exception:
            logger.warning("Failed to fetch Kalshi markets", exc_info=True)
            return []

    def find_matching_pairs(self) -> list[dict[str, Any]]:
        """Find Kalshi↔Polymarket pairs by title similarity."""
        now = time.time()
        if self._cache and (now - self._last_refresh) < self.refresh_interval:
            return self._cache

        kalshi_markets = self.fetch_kalshi_active_markets()
        poly_markets = self.fetch_polymarket_active_markets()

        if not kalshi_markets or not poly_markets:
            return self._cache

        pairs: list[dict[str, Any]] = []
        pair_counter = 1

        for km in kalshi_markets:
            k_title = km.get("title", km.get("event_title", ""))
            k_ticker = km.get("ticker", "")
            if not k_title or not k_ticker:
                continue

            best_score = 0.0
            best_poly = None

            for pm in poly_markets:
                p_title = pm.get("question", pm.get("title", ""))
                score = title_similarity(k_title, p_title)
                if score > best_score:
                    best_score = score
                    best_poly = pm

            if best_score >= self.min_similarity and best_poly:
                tokens = best_poly.get("clobTokenIds", "")
                yes_token = ""
                no_token = ""
                if isinstance(tokens, str) and "," in tokens:
                    parts = tokens.split(",")
                    yes_token = parts[0].strip() if len(parts) > 0 else ""
                    no_token = parts[1].strip() if len(parts) > 1 else ""
                elif isinstance(tokens, list) and len(tokens) >= 2:
                    yes_token = str(tokens[0])
                    no_token = str(tokens[1])

                pairs.append({
                    "pair_id": f"AUTO-{pair_counter:04d}",
                    "kalshi_ticker": k_ticker,
                    "kalshi_title": k_title,
                    "polymarket_market_slug": best_poly.get("slug", ""),
                    "polymarket_title": best_poly.get("question", best_poly.get("title", "")),
                    "polymarket_yes_token_id": yes_token,
                    "polymarket_no_token_id": no_token,
                    "resolution_time_utc": km.get("close_time", best_poly.get("endDate", "")),
                    "category": best_poly.get("category", "default"),
                    "similarity_score": round(best_score, 4),
                    "active": self.auto_activate,
                    "source": "auto_discovery",
                })
                pair_counter += 1

                if len(pairs) >= self.max_discovered:
                    break

        self._cache = pairs
        self._last_refresh = now
        return pairs

    def discover_and_merge(self, existing_mappings: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Find new pairs not in existing mappings and merge them."""
        discovered = self.find_matching_pairs()

        # Deduplicate by kalshi_ticker
        existing_tickers = {m.get("kalshi_ticker", "") for m in existing_mappings}
        new_pairs = [p for p in discovered if p["kalshi_ticker"] not in existing_tickers and p.get("active")]

        return existing_mappings + new_pairs
