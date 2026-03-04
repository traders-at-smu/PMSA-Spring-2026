#!/usr/bin/env python3
"""
model_v1_bridge.py
JSON bridge around model_v1.model_decision for batch evaluation.
"""

import json
import os
import sys
from typing import Any, Dict, List

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from model_v1 import model_decision  # noqa: E402


class BridgeError(Exception):
    pass


def _validate_item(item: Dict[str, Any]) -> None:
    if not isinstance(item, dict):
        raise BridgeError("Each batch item must be an object")
    for key in ("opportunity_row", "lob_metrics", "recent_snapshots"):
        if key not in item:
            raise BridgeError(f"Missing required key: {key}")



def main() -> int:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise BridgeError("Root payload must be an object")

        bankroll = payload.get("bankroll_usd")
        items = payload.get("items", [])
        if not isinstance(items, list):
            raise BridgeError("items must be an array")

        results: List[Dict[str, Any]] = []
        for index, item in enumerate(items):
            _validate_item(item)
            decision = model_decision(
                item["opportunity_row"],
                item["lob_metrics"],
                item["recent_snapshots"],
                bankroll_usd=float(bankroll) if bankroll is not None else 10_000,
            )
            results.append({
                "index": index,
                "id": item.get("id"),
                "decision": decision,
            })

        json.dump({"ok": True, "results": results}, sys.stdout)
        return 0
    except Exception as err:  # pylint: disable=broad-except
        json.dump({"ok": False, "error": str(err)}, sys.stdout)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
