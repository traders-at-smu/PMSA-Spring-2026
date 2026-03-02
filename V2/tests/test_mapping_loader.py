import tempfile
from pathlib import Path

from src.mapping_loader import MappingError, load_mapping


def test_mapping_loader_csv_ok():
    csv = """pair_id,kalshi_ticker,polymarket_market_slug,polymarket_yes_token_id,polymarket_no_token_id,resolution_time_utc,active\np1,KX-1,mkt,1,2,2026-12-31T23:59:59Z,true\n"""
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "pairs.csv"
        path.write_text(csv, encoding="utf-8")
        rows = load_mapping(str(path))
        assert len(rows) == 1
        assert rows[0]["pair_id"] == "p1"


def test_mapping_loader_missing_column():
    csv = """pair_id,kalshi_ticker,resolution_time_utc,active\np1,KX-1,2026-12-31T23:59:59Z,true\n"""
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "pairs.csv"
        path.write_text(csv, encoding="utf-8")
        try:
            load_mapping(str(path))
            assert False, "expected MappingError"
        except MappingError:
            assert True