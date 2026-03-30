from src.connectors.kalshi import KalshiClient


def _client() -> KalshiClient:
    return KalshiClient(
        {
            "api": {
                "kalshi": {
                    "environment": "prod",
                    "base_url_prod": "https://api.elections.kalshi.com/trade-api/v2",
                    "base_url_demo": "https://demo-api.kalshi.co/trade-api/v2",
                    "access_key_id": "",
                    "private_key_path": "",
                    "private_key_base64": "",
                }
            }
        }
    )


def test_ticker_from_kalshi_url():
    client = _client()
    ticker = client._ticker_from_kalshi_url("https://kalshi.com/markets/KXTEST-1")
    assert ticker == "KXTEST-1"


def test_ticker_from_nested_market_url_path():
    client = _client()
    ticker = client._ticker_from_kalshi_url("https://kalshi.com/markets/pro-basketball-mvp/kxnbamvp-26")
    assert ticker == "pro-basketball-mvp/kxnbamvp-26"


def test_event_ticker_from_market_like():
    client = _client()
    event = client._event_ticker_from_market_like("KXABC-2026-DEF123")
    assert event == "KXABC-2026"


def test_event_ticker_from_slug_path():
    client = _client()
    event = client._event_ticker_from_market_like("pro-basketball-mvp/kxnbamvp-26")
    assert event == "KXNBAMVP-26"


def test_title_similarity_prefers_token_overlap():
    client = _client()
    score = client._title_similarity("will real madrid win", "yes Real Madrid,yes Over 2.5 goals scored")
    assert score > 0.4
