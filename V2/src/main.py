"""CLI entrypoint for scan/run/trade/dashboard/validation commands."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time

from src.config import ConfigError, ensure_live_credentials, load_config
from src.connectors.kalshi import KalshiClient
from src.connectors.polymarket import PolymarketClient
from src.execution import ExecutionEngine
from src.service import BotService
from src.state_store import StateStore


def build_runtime(config_path: str, credentials_path: str):
    config = load_config(config_path=config_path, credentials_path=credentials_path)
    store = StateStore(config["paths"]["state_db"])
    kalshi = KalshiClient(config)
    polymarket = PolymarketClient(config)
    execution = ExecutionEngine(config, store, kalshi, polymarket)
    service = BotService(config, store, kalshi, polymarket, execution)
    return config, store, execution, service


def cmd_validate(args) -> int:
    try:
        load_config(args.config, args.credentials)
    except ConfigError as exc:
        print(f"Config invalid: {exc}")
        return 1
    print("Config valid")
    return 0


def cmd_scan(args) -> int:
    config, _, _, service = build_runtime(args.config, args.credentials)
    result = service.run_cycle(execute_trades=False)
    print(
        json.dumps(
            {
                "cycle_id": result["cycle_id"],
                "mode": config["mode"],
                "opportunities": result["decisions"],
                "errors": result.get("errors", []),
            },
            indent=2,
        )
    )
    return 0


def cmd_trade_once(args) -> int:
    config, store, execution, service = build_runtime(args.config, args.credentials)
    if args.arm_live:
        token = execution.arm_live()
        print(f"Live armed. Confirmation token: {token}")

    mode = args.mode if args.mode else store.get_runtime_control()["mode"]
    if mode == "live":
        try:
            ensure_live_credentials(config)
        except ConfigError as exc:
            print(f"Config invalid for live trading: {exc}")
            return 1
    result = service.run_cycle(execute_trades=True, mode_override=mode, typed_confirm=args.confirm_token)
    print(json.dumps({"cycle_id": result["cycle_id"], "mode": mode, "execution": result["execution"]}, indent=2))
    return 0


def cmd_run(args) -> int:
    config, store, execution, service = build_runtime(args.config, args.credentials)
    if args.arm_live:
        token = execution.arm_live()
        print(f"Live armed. Confirmation token: {token}")

    while True:
        mode = args.mode if args.mode else store.get_runtime_control()["mode"]
        if args.execute and mode == "live":
            try:
                ensure_live_credentials(config)
            except ConfigError as exc:
                print(f"Config invalid for live trading: {exc}")
                return 1
        result = service.run_cycle(execute_trades=args.execute, mode_override=mode, typed_confirm=args.confirm_token)
        print(
            json.dumps(
                {
                    "cycle_id": result["cycle_id"],
                    "mode": mode,
                    "decision_count": len(result["decisions"]),
                    "execution_count": len(result["execution"]),
                    "error_count": len(result.get("errors", [])),
                }
            )
        )
        time.sleep(service.config["scan_interval_seconds"])


def cmd_copy_scan(args) -> int:
    config, _, _, service = build_runtime(args.config, args.credentials)
    result = service.run_copy_cycle()
    print(json.dumps(result, indent=2))
    return 0


def cmd_copy_run(args) -> int:
    config, _, _, service = build_runtime(args.config, args.credentials)
    print("Copy trading monitor running. Press Ctrl+C to stop.")
    while True:
        result = service.run_copy_cycle()
        if result["signals_found"] > 0:
            print(json.dumps(result, indent=2))
        time.sleep(service.copy_trading.poll_interval)


def cmd_dashboard(args) -> int:
    cmd = [
        sys.executable,
        "-m",
        "streamlit",
        "run",
        "src/dashboard.py",
        "--",
        "--config",
        args.config,
        "--credentials",
        args.credentials,
    ]
    return subprocess.call(cmd)


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Kalshi + Polymarket arbitrage bot")
    p.add_argument("--config", default="config/config.json")
    p.add_argument("--credentials", default="config/credentials.json")

    sub = p.add_subparsers(dest="command", required=True)

    s_validate = sub.add_parser("validate-config")
    s_validate.set_defaults(func=cmd_validate)

    s_scan = sub.add_parser("scan")
    s_scan.set_defaults(func=cmd_scan)

    s_trade_once = sub.add_parser("trade-once")
    s_trade_once.add_argument("--mode", choices=["paper", "live"], default=None)
    s_trade_once.add_argument("--arm-live", action="store_true")
    s_trade_once.add_argument("--confirm-token", default=None)
    s_trade_once.set_defaults(func=cmd_trade_once)

    s_run = sub.add_parser("run")
    s_run.add_argument("--mode", choices=["paper", "live"], default=None)
    s_run.add_argument("--execute", action="store_true", help="Place orders (paper or live).")
    s_run.add_argument("--arm-live", action="store_true")
    s_run.add_argument("--confirm-token", default=None)
    s_run.set_defaults(func=cmd_run)

    s_copy_scan = sub.add_parser("copy-scan")
    s_copy_scan.set_defaults(func=cmd_copy_scan)

    s_copy_run = sub.add_parser("copy-run")
    s_copy_run.set_defaults(func=cmd_copy_run)

    s_dashboard = sub.add_parser("dashboard")
    s_dashboard.set_defaults(func=cmd_dashboard)

    return p


def main() -> int:
    args = parser().parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
