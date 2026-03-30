import tempfile
from pathlib import Path

from src.mapping_loader import load_mapping


def test_mapping_loader_alt_schema_ok():
    csv = (
        "pair_id,kalshi_market_id,poly_slug,category_tag,kalshi_url,title_clean,active\n"
        "p1,KX-1,some-poly-market,sports,https://kalshi.com/markets/KX-1,Will Team A win?,true\n"
    )
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "pairs.csv"
        path.write_text(csv, encoding="utf-8")
        rows = load_mapping(str(path))
        assert len(rows) == 1
        assert rows[0]["kalshi_ticker"] == "KX-1"
        assert rows[0]["kalshi_url"] == "https://kalshi.com/markets/KX-1"
        assert rows[0]["kalshi_title_hint"] == "Will Team A win?"
        assert rows[0]["polymarket_market_slug"] == "some-poly-market"
        assert rows[0]["category"] == "sports"
