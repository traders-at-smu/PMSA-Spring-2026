import pytest

from src.config import ConfigError, ensure_live_credentials, load_config


def test_paper_config_loads_without_credentials_file():
    cfg = load_config("config/config.example.json", "config/does-not-exist.json")
    assert cfg["mode"] == "paper"


def test_live_credentials_required():
    cfg = load_config("config/config.example.json", "config/does-not-exist.json")
    cfg["mode"] = "live"
    with pytest.raises(ConfigError):
        ensure_live_credentials(cfg)