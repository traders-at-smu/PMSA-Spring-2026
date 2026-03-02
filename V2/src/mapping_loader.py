"""Load and validate market mapping files from CSV/XLSX."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

REQUIRED_COLUMNS = [
    "pair_id",
    "kalshi_ticker",
    "polymarket_market_slug",
    "polymarket_yes_token_id",
    "polymarket_no_token_id",
    "resolution_time_utc",
    "active",
]

ALT_REQUIRED_COLUMNS = [
    "pair_id",
    "kalshi_market_id",
    "poly_slug",
]


class MappingError(RuntimeError):
    pass


def _norm_columns(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out.columns = [str(c).strip().lower() for c in out.columns]
    return out


def _is_truthy(value: object, default: bool = False) -> bool:
    if value is None:
        return default
    s = str(value).strip().lower()
    if not s:
        return default
    return s in {"true", "1", "yes", "y"}


def _parse_standard(df: pd.DataFrame) -> list[dict]:
    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise MappingError(f"Missing required columns: {missing}")

    if df["pair_id"].duplicated().any():
        dupes = df[df["pair_id"].duplicated()]["pair_id"].tolist()
        raise MappingError(f"Duplicate pair_id values found: {dupes}")

    rows: list[dict] = []
    for idx, row in df.iterrows():
        active = _is_truthy(row.get("active"), default=True)
        if not active:
            continue

        for field in REQUIRED_COLUMNS[:-1]:
            # Allow missing token IDs / resolution to be resolved dynamically at runtime.
            if field in {"polymarket_yes_token_id", "polymarket_no_token_id", "resolution_time_utc"}:
                continue
            val = str(row.get(field, "")).strip()
            if not val:
                raise MappingError(f"Row {idx + 2} missing value for '{field}'")

        rows.append(
            {
                "pair_id": str(row.get("pair_id", "")).strip(),
                "kalshi_ticker": str(row.get("kalshi_ticker", "")).strip(),
                "kalshi_url": str(row.get("kalshi_url", "")).strip(),
                "kalshi_title_hint": str(row.get("kalshi_title_hint", row.get("notes", ""))).strip(),
                "polymarket_market_slug": str(row.get("polymarket_market_slug", "")).strip(),
                "polymarket_yes_token_id": str(row.get("polymarket_yes_token_id", "")).strip(),
                "polymarket_no_token_id": str(row.get("polymarket_no_token_id", "")).strip(),
                "resolution_time_utc": str(row.get("resolution_time_utc", "")).strip(),
                "category": str(row.get("category", "default")).strip().lower() or "default",
                "notes": str(row.get("notes", "")).strip(),
            }
        )

    return rows


def _parse_alt_schema(df: pd.DataFrame) -> list[dict]:
    missing = [c for c in ALT_REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise MappingError(f"Missing required columns: {missing}")

    if df["pair_id"].duplicated().any():
        dupes = df[df["pair_id"].duplicated()]["pair_id"].tolist()
        raise MappingError(f"Duplicate pair_id values found: {dupes}")

    rows: list[dict] = []
    for idx, row in df.iterrows():
        active = _is_truthy(row.get("active"), default=True)
        if not active:
            continue

        pair_id = str(row.get("pair_id", "")).strip()
        kalshi_ticker = str(row.get("kalshi_market_id", "")).strip()
        poly_slug = str(row.get("poly_slug", "")).strip()
        if not pair_id or not kalshi_ticker or not poly_slug:
            raise MappingError(
                f"Row {idx + 2} must include non-empty values for pair_id, kalshi_market_id, and poly_slug"
            )

        rows.append(
            {
                "pair_id": pair_id,
                "kalshi_ticker": kalshi_ticker,
                "kalshi_url": str(row.get("kalshi_url", "")).strip(),
                "kalshi_title_hint": str(row.get("title_clean", row.get("notes", ""))).strip(),
                "polymarket_market_slug": poly_slug,
                "polymarket_yes_token_id": str(
                    row.get("polymarket_yes_token_id", row.get("poly_yes_token_id", ""))
                ).strip(),
                "polymarket_no_token_id": str(
                    row.get("polymarket_no_token_id", row.get("poly_no_token_id", ""))
                ).strip(),
                "resolution_time_utc": str(
                    row.get("resolution_time_utc", row.get("enddate", row.get("end_date", "")))
                ).strip(),
                "category": str(row.get("category", row.get("category_tag", "default"))).strip().lower()
                or "default",
                "notes": str(row.get("notes", row.get("title_clean", ""))).strip(),
            }
        )

    return rows


def load_mapping(path: str) -> list[dict]:
    p = Path(path)
    if not p.exists():
        raise MappingError(f"Mapping file does not exist: {path}")

    suffix = p.suffix.lower()
    if suffix == ".csv":
        df = pd.read_csv(p)
    elif suffix in {".xlsx", ".xlsm", ".xls"}:
        try:
            df = pd.read_excel(p)
        except ImportError as exc:
            raise MappingError("Reading Excel files requires 'openpyxl'. Run: pip install openpyxl") from exc
    else:
        raise MappingError("Mapping file must be .csv or .xlsx")

    df = _norm_columns(df).fillna("")

    if all(c in df.columns for c in REQUIRED_COLUMNS):
        rows = _parse_standard(df)
    elif all(c in df.columns for c in ALT_REQUIRED_COLUMNS):
        rows = _parse_alt_schema(df)
    else:
        raise MappingError(
            "Unsupported mapping schema. Provide either standard columns "
            f"{REQUIRED_COLUMNS} or alternate columns {ALT_REQUIRED_COLUMNS}."
        )

    if not rows:
        raise MappingError("No active rows found in mapping file")

    return rows
