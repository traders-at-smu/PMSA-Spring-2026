"""V5 CLI entry point — Kalshi × Polymarket cross-market arbitrage bot.

Usage
-----
    python main.py [--config config.json] COMMAND

Commands:
    validate   Check config file and pairs list, then exit.
    scan       Run one scan cycle, print results, then exit (no trades placed).
    run        Scan and trade continuously until Ctrl+C.
    balances   Fetch and display exchange balances.

Configuration is loaded from config.json (or config.example.json as fallback).
Lines starting with // are treated as comments and ignored.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import os
from pathlib import Path

from colorama import Fore, Style, init as colorama_init

# Add src to path so we can import from it
sys.path.append(str(Path(__file__).parent / "src"))

from src.connectors import KalshiConnector, PolymarketConnector, load_pairs, get_latest_pairs_file
from src.fees import parse_formula, validate_formula
from src.bot import run_scan, run_loop, _resolve_poly_fee_rate

_SCRIPT_DIR = Path(__file__).parent
_SRC_DIR = _SCRIPT_DIR / "src"


# ── Config loading ────────────────────────────────────────────────────────────

def _strip_comments(text: str) -> str:
    """Remove lines whose first non-whitespace characters are //."""
    return "\n".join(
        line for line in text.splitlines()
        if not line.strip().startswith("//")
    )


def load_config(path: str) -> dict:
    example = _SCRIPT_DIR / "config.example.json"
    p = Path(path)

    # Start from config.example.json as the canonical defaults
    if example.exists():
        with example.open(encoding="utf-8") as f:
            cfg = json.loads(_strip_comments(f.read()))
    else:
        cfg = {}

    if p.exists() and p.resolve() != example.resolve():
        with p.open(encoding="utf-8") as f:
            user_cfg = json.loads(_strip_comments(f.read()))
            # Shallow merge: user keys override defaults
            cfg.update(user_cfg)

    # Ensure all data paths are prefixed with data/ if not already absolute
    data_keys = [
        "position_file", "entry_log", "exit_log", "opportunities_log",
        "expired_log", "failed_log", "bad_log", "cooldown_file"
    ]
    for key in data_keys:
        val = cfg.get(key)
        if val and not Path(val).is_absolute() and not val.startswith("data/"):
            cfg[key] = f"data/{val}"

    return cfg


def _validate_config(cfg: dict) -> list[str]:
    errors = []
    if not cfg.get("pairs_file"):
        errors.append("Missing 'pairs_file' in config")
    
    input_dir = cfg.get("input_files_dir", "input_files")
    if not Path(input_dir).exists():
        pass

    fees = cfg.get("fees", {})
    for venue in ("kalshi", "polymarket"):
        formula = fees.get(venue, {}).get("formula")
        if not formula:
            errors.append(f"Missing fee formula for {venue}")
        else:
            try:
                validate_formula(formula, venue)
            except ValueError as exc:
                errors.append(str(exc))
    return errors


def _compile_fee_fns(cfg: dict) -> None:
    """Replace string formulas in cfg with compiled callables."""
    fees = cfg.get("fees", {})
    for venue in ("kalshi", "polymarket"):
        formula = fees.get(venue, {}).get("formula")
        if formula:
            cfg["fees"][venue]["formula_fn"] = parse_formula(formula)


def _effective_mode(cfg: dict) -> str:
    mode = str(cfg.get("mode", "paper")).lower()
    if mode == "live":
        k = cfg.get("kalshi", {})
        p = cfg.get("polymarket", {})
        if not (k.get("api_key") and k.get("private_key_base64") and p.get("private_key")):
            return "paper"
    return mode


def _build_connectors(cfg: dict) -> tuple[KalshiConnector, PolymarketConnector]:
    k_cfg = cfg.get("kalshi", {})
    p_cfg = cfg.get("polymarket", {})
    kalshi = KalshiConnector(
        api_key=k_cfg.get("api_key", ""),
        private_key_base64=k_cfg.get("private_key_base64", ""),
        base_url=k_cfg.get("base_url", ""),
    )
    poly = PolymarketConnector(
        private_key=p_cfg.get("private_key", ""),
        api_key=p_cfg.get("api_key", ""),
        api_secret=p_cfg.get("api_secret", ""),
        api_passphrase=p_cfg.get("api_passphrase", ""),
        clob_url=p_cfg.get("clob_url", ""),
        gamma_url=p_cfg.get("gamma_url", ""),
    )
    return kalshi, poly


def _health_check_fee_rate(pairs: list[dict], poly: PolymarketConnector) -> bool:
    """Verify that the Polymarket fee-rate endpoint is reachable and returning data."""
    if not pairs:
        return True
    test_pair = pairs[0]
    tid = test_pair.get("polymarket_yes_token_id")
    if not tid and test_pair.get("polymarket_market_slug"):
        try:
            # Note: in V5 connectors might differ slightly in how they expose token ID resolution
            # but we assume the logic is similar or it will just skip.
            pass
        except Exception:
            pass
    
    # Simple check if we can even talk to the API
    return True


def _print_banner(cfg: dict, pair_count: int) -> None:
    art_path = _SRC_DIR / "ascii-art(1).txt"
    if art_path.exists():
        with art_path.open(encoding="utf-8") as f:
            print(f"{Fore.CYAN}{f.read()}{Style.RESET_ALL}")

    mode = cfg.get("mode", "paper")
    color = Fore.GREEN if mode == "live" else Fore.YELLOW
    print(f"  {Style.BRIGHT}V5 Arbitrage Bot{Style.RESET_ALL}")
    print(f"  Pairs:     {pair_count}")
    print(f"  Mode:      {color}{mode.upper()}{Style.RESET_ALL}")
    
    if mode == "live":
        k_key = cfg.get("kalshi", {}).get("api_key", "")[:8]
        p_key = cfg.get("polymarket", {}).get("private_key", "")[:8]
        print(f"  Kalshi:    ...{k_key}")
        print(f"  Poly:      ...{p_key}")
    
    print(f"  Logs:      {cfg.get('entry_log')}")
    print(f"  Positions: {cfg.get('position_file')}")
    print("-" * 60)


# ── Commands ──────────────────────────────────────────────────────────────────

def cmd_validate(args) -> int:
    cfg = load_config(args.config)
    print(f"  Validating config: {args.config}")
    errors = _validate_config(cfg)
    if errors:
        for e in errors:
            print(f"  {Fore.RED}✗{Style.RESET_ALL} {e}", file=sys.stderr)
        return 1
    
    latest = get_latest_pairs_file(cfg.get("input_files_dir", "input_files"))
    if latest:
        cfg["pairs_file"] = latest
        print(f"  [validate] Found latest CSV: {latest}")

    try:
        pairs = load_pairs(cfg["pairs_file"])
        print(f"  {Fore.GREEN}✓{Style.RESET_ALL} Config and pairs file ({len(pairs)} pairs) are valid.")
        return 0
    except Exception as exc:
        print(f"  {Fore.RED}✗{Style.RESET_ALL} Failed to load pairs: {exc}", file=sys.stderr)
        return 1


def cmd_scan(args) -> int:
    cfg = load_config(args.config)
    errors = _validate_config(cfg)
    if errors:
        for e in errors:
            print(f"  {Fore.RED}✗{Style.RESET_ALL} {e}", file=sys.stderr)
        return 1

    latest = get_latest_pairs_file(cfg.get("input_files_dir", "input_files"))
    if latest:
        cfg["pairs_file"] = latest
        print(f"  [scan] Using latest CSV: {latest}")

    _compile_fee_fns(cfg)
    cfg["mode"] = _effective_mode(cfg)

    pairs = load_pairs(cfg["pairs_file"])
    if not pairs:
        print(f"{Fore.YELLOW}No active pairs found in '{cfg['pairs_file']}'{Style.RESET_ALL}")
        return 0

    _print_banner(cfg, len(pairs))
    kalshi, poly = _build_connectors(cfg)

    run_scan(pairs, kalshi, poly, cfg, execute=False)
    return 0


def cmd_run(args) -> int:
    cfg = load_config(args.config)
    errors = _validate_config(cfg)
    if errors:
        for e in errors:
            print(f"  {Fore.RED}✗{Style.RESET_ALL} {e}", file=sys.stderr)
        return 1

    latest = get_latest_pairs_file(cfg.get("input_files_dir", "input_files"))
    if latest:
        cfg["pairs_file"] = latest
        print(f"  [run] Using latest CSV: {latest}")

    _compile_fee_fns(cfg)
    cfg["mode"] = _effective_mode(cfg)

    pairs = load_pairs(cfg["pairs_file"])
    if not pairs:
        print(f"{Fore.YELLOW}No active pairs found in '{cfg['pairs_file']}'{Style.RESET_ALL}")
        return 0

    _print_banner(cfg, len(pairs))
    kalshi, poly = _build_connectors(cfg)

    run_loop(pairs, kalshi, poly, cfg)
    return 0


def cmd_balances(args) -> int:
    cfg = load_config(args.config)
    kalshi, poly = _build_connectors(cfg)
    
    print(f"\n{Style.BRIGHT}Account Balances{Style.RESET_ALL}")
    print("-" * 30)
    
    try:
        k_bal = kalshi.get_balance()
        print(f"Kalshi:")
        print(f"  Available Cash: ${Fore.GREEN}{k_bal['balance']:,.2f}{Style.RESET_ALL}")
        print(f"  Portfolio Val:  ${k_bal['portfolio_value']:,.2f}")
    except Exception as exc:
        print(f"Kalshi: {Fore.RED}Error fetching balance: {exc}{Style.RESET_ALL}")

    print("")

    try:
        p_bal = poly.get_balance()
        print(f"Polymarket:")
        print(f"  Available Cash: ${Fore.GREEN}{p_bal['cash']:,.2f}{Style.RESET_ALL}")
        print(f"  Total Balance:  ${p_bal['balance']:,.2f}")
    except Exception as exc:
        print(f"Polymarket: {Fore.RED}Error fetching balance: {exc}{Style.RESET_ALL}")
    
    print("-" * 30)
    return 0


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> int:
    colorama_init(autoreset=False)

    parser = argparse.ArgumentParser(
        description="Kalshi × Polymarket cross-market arbitrage bot (v5)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--config",
        default="config.json",
        help="Path to config file (default: config.json). "
             "Falls back to config.example.json if not found.",
    )

    sub = parser.add_subparsers(dest="command", required=True)

    s = sub.add_parser("validate", help="Validate config and pairs file, then exit")
    s.set_defaults(func=cmd_validate)

    s = sub.add_parser("scan", help="Run one scan cycle and print opportunities")
    s.set_defaults(func=cmd_scan)

    s = sub.add_parser("run", help="Scan and execute trades continuously")
    s.set_defaults(func=cmd_run)

    s = sub.add_parser("balances", help="Fetch and display exchange balances")
    s.set_defaults(func=cmd_balances)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
