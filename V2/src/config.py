"""Load and merge bot configuration and credentials."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any


class ConfigError(RuntimeError):
    pass


DEFAULT_CONFIG = {
    "api": {
        "kalshi": {
            "environment": "prod",
            "base_url_prod": "https://api.elections.kalshi.com/trade-api/v2",
            "base_url_demo": "https://demo-api.kalshi.co/trade-api/v2",
            "access_key_id": "",
            "private_key_path": "",
            "private_key_base64": "",
            "resolve_markets_via_api": True,
            "market_discovery_cache_ttl_sec": 300,
            "market_discovery_max_pages": 20,
            "market_title_min_score": 0.5,
            "series_discovery_cache_ttl_sec": 600,
            "series_title_min_score": 0.2,
        },
        "polymarket": {
            "clob_host": "https://clob.polymarket.com",
            "chain_id": 137,
            "private_key": "",
            "api_key": "",
            "api_secret": "",
            "api_passphrase": "",
        },
    }
}


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = copy.deepcopy(base)
    for key, value in override.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_json(path: str | Path) -> dict[str, Any]:
    p = Path(path)
    if not p.exists():
        raise ConfigError(f"Missing JSON file: {p}")
    with p.open("r", encoding="utf-8") as f:
        return json.load(f)


def load_config(config_path: str = "config/config.json", credentials_path: str = "config/credentials.json") -> dict[str, Any]:
    config_file = Path(config_path)
    if not config_file.exists():
        config_file = Path("config/config.example.json")
    config = _deep_merge(DEFAULT_CONFIG, load_json(config_file))

    credentials_file = Path(credentials_path)
    if credentials_file.exists():
        credentials = load_json(credentials_file)
        config = _deep_merge(config, {"api": _deep_merge(config.get("api", {}), credentials)})

    mapping_path = Path(config.get("paths", {}).get("mapping_file", ""))
    detected_pairs_xlsx = Path("Pairs_for_Kalshi_and_Polymarket.xlsx")
    if (
        str(mapping_path).replace("\\", "/").lower() == "data/pairs.example.csv"
        and detected_pairs_xlsx.exists()
    ):
        config.setdefault("paths", {})["mapping_file"] = str(detected_pairs_xlsx)

    _validate_config(config)
    return config


def _validate_config(config: dict[str, Any]) -> None:
    required_top = [
        "mode",
        "scan_interval_seconds",
        "fixed_contract_size",
        "kp_max_per_trade",
        "annualized_edge_min",
        "live_safety",
        "paths",
        "fees",
    ]
    for key in required_top:
        if key not in config:
            raise ConfigError(f"Missing required config key: {key}")

    mode = config["mode"]
    if mode not in {"paper", "live"}:
        raise ConfigError("mode must be either 'paper' or 'live'")

    if config["scan_interval_seconds"] <= 0:
        raise ConfigError("scan_interval_seconds must be > 0")

    mapping_file = Path(config["paths"]["mapping_file"])
    if not mapping_file.exists():
        raise ConfigError(f"Mapping file not found: {mapping_file}")


def ensure_live_credentials(config: dict[str, Any]) -> None:
    kalshi = config.get("api", {}).get("kalshi", {})
    poly = config.get("api", {}).get("polymarket", {})

    kalshi_ok = bool(kalshi.get("access_key_id")) and bool(
        kalshi.get("private_key_base64") or kalshi.get("private_key_path")
    )
    if not kalshi_ok:
        raise ConfigError(
            "Live mode requires Kalshi credentials: api.kalshi.access_key_id and "
            "one of api.kalshi.private_key_path/private_key_base64."
        )

    poly_required = ["private_key", "api_key", "api_secret", "api_passphrase"]
    missing_poly = [k for k in poly_required if not str(poly.get(k, "")).strip()]
    if missing_poly:
        raise ConfigError(
            "Live mode requires Polymarket credentials. Missing: "
            + ", ".join(f"api.polymarket.{k}" for k in missing_poly)
        )
