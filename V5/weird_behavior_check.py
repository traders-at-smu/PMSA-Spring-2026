import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable


def _load_json(path: Path) -> Any:
    if not path.exists():
        return None
    try:
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def _print_section(title: str, items: Iterable[str]) -> None:
    items = list(items)
    if not items:
        return
    print(f"\n== {title} ==")
    for item in items:
        print(f"- {item}")


def _key(entry: dict[str, Any], *fields: str) -> tuple:
    return tuple(entry.get(f, "") for f in fields)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Scan V5 JSON logs for weird behavior (same-side tokens, mismatches, duplicates)."
    )
    parser.add_argument(
        "--base",
        default=".",
        help="Base directory containing V5 JSON files (default: current directory).",
    )
    args = parser.parse_args()

    base = Path(args.base).resolve()
    open_positions = _load_json(base / "open_positions.json") or {}
    opportunities = _load_jsonl(base / "opportunities.json")
    entry_trades = _load_jsonl(base / "entry_trades.json")
    exit_trades = _load_jsonl(base / "exit_trades.json")
    failed_pairs = _load_jsonl(base / "failed_pairs.json")
    expired_pairs = _load_jsonl(base / "expired_pairs.json")

    failed_ids = {p.get("pair_id", "") for p in failed_pairs if p.get("pair_id")}
    expired_ids = {p.get("pair_id", "") for p in expired_pairs if p.get("pair_id")}

    warnings: list[str] = []

    # --- Open positions ---
    open_positions = open_positions if isinstance(open_positions, dict) else {}
    for pair_id, pos in open_positions.items():
        if not isinstance(pos, dict):
            warnings.append(f"open_positions[{pair_id}]: not an object")
            continue
        strategy = pos.get("strategy", "")
        yes_id = str(pos.get("yes_token_id", ""))
        no_id = str(pos.get("no_token_id", ""))
        p_token_id = str(pos.get("p_token_id", ""))
        p_token_ids = pos.get("p_token_ids") or []
        p_leg_prices = pos.get("p_leg_prices") or []

        if pair_id in failed_ids:
            warnings.append(f"open position in failed_pairs.json: {pair_id}")
        if pair_id in expired_ids:
            warnings.append(f"open position in expired_pairs.json: {pair_id}")

        if yes_id and no_id and yes_id == no_id:
            warnings.append(f"open position {pair_id}: YES and NO token IDs identical ({yes_id})")

        if strategy == "BUY_KY_BUY_PN" and p_token_id and no_id and p_token_id != no_id:
            warnings.append(
                f"open position {pair_id}: strategy BUY_KY_BUY_PN but p_token_id != no_token_id"
            )
        if strategy == "BUY_KN_BUY_PY" and p_token_id and yes_id and p_token_id != yes_id:
            warnings.append(
                f"open position {pair_id}: strategy BUY_KN_BUY_PY but p_token_id != yes_token_id"
            )

        if p_token_ids:
            if len(p_leg_prices) not in (0, len(p_token_ids)):
                warnings.append(
                    f"open position {pair_id}: p_leg_prices length {len(p_leg_prices)} != p_token_ids length {len(p_token_ids)}"
                )
        else:
            if not p_token_id:
                warnings.append(f"open position {pair_id}: missing p_token_id and p_token_ids")

    # --- Opportunities and trades ---
    def check_entry_like(label: str, rows: list[dict[str, Any]]) -> list[str]:
        issues: list[str] = []
        for row in rows:
            pid = row.get("pair_id", "")
            strategy = row.get("strategy", "")
            yes_id = str(row.get("yes_token_id", ""))
            no_id = str(row.get("no_token_id", ""))
            p_token_id = str(row.get("p_token_id", row.get("polymarket_token", "")))
            p_token_ids = row.get("p_token_ids") or []
            p_leg_prices = row.get("p_leg_prices") or []

            if yes_id and no_id and yes_id == no_id:
                issues.append(f"{label} {pid}: YES and NO token IDs identical ({yes_id})")
            if strategy == "BUY_KY_BUY_PN" and p_token_id and no_id and p_token_id != no_id:
                issues.append(f"{label} {pid}: BUY_KY_BUY_PN but p_token_id != no_token_id")
            if strategy == "BUY_KN_BUY_PY" and p_token_id and yes_id and p_token_id != yes_id:
                issues.append(f"{label} {pid}: BUY_KN_BUY_PY but p_token_id != yes_token_id")

            if p_token_ids and len(p_leg_prices) not in (0, len(p_token_ids)):
                issues.append(
                    f"{label} {pid}: p_leg_prices length {len(p_leg_prices)} != p_token_ids length {len(p_token_ids)}"
                )
        return issues

    warnings.extend(check_entry_like("opportunity", opportunities))
    warnings.extend(check_entry_like("entry_trade", entry_trades))

    # --- Duplicate detection ---
    dup_warnings: list[str] = []
    def find_duplicates(label: str, rows: list[dict[str, Any]], fields: list[str]) -> None:
        counter: dict[tuple, int] = defaultdict(int)
        for row in rows:
            counter[_key(row, *fields)] += 1
        for k, v in counter.items():
            if v > 1 and k[0]:
                dup_warnings.append(f"{label} duplicate {fields}: {k} x{v}")

    find_duplicates("opportunity", opportunities, ["pair_id", "strategy", "k_price", "p_price"]) 
    find_duplicates("entry_trade", entry_trades, ["pair_id", "strategy", "execution_date", "kalshi_token", "polymarket_token"])

    # --- Pair ID inconsistencies ---
    pid_to_kalshi = defaultdict(set)
    pid_to_poly = defaultdict(set)
    for row in opportunities + entry_trades + exit_trades:
        pid = row.get("pair_id", "")
        if not pid:
            continue
        if row.get("kalshi_token"):
            pid_to_kalshi[pid].add(row.get("kalshi_token"))
        if row.get("polymarket_token"):
            pid_to_poly[pid].add(row.get("polymarket_token"))
    for pid, vals in pid_to_kalshi.items():
        if len(vals) > 1:
            warnings.append(f"pair_id {pid} has multiple kalshi_token values: {sorted(vals)}")
    for pid, vals in pid_to_poly.items():
        if len(vals) > 1:
            warnings.append(f"pair_id {pid} has multiple polymarket_token values: {sorted(vals)}")

    print(f"Scanned: {base}")
    print(f"open_positions: {len(open_positions)} | opportunities: {len(opportunities)} | entry_trades: {len(entry_trades)} | exit_trades: {len(exit_trades)}")
    print(f"failed_pairs: {len(failed_pairs)} | expired_pairs: {len(expired_pairs)}")

    _print_section("Weird Behavior", warnings)
    _print_section("Duplicates", dup_warnings)

    if not warnings and not dup_warnings:
        print("\nNo weird behavior detected.")


if __name__ == "__main__":
    main()
