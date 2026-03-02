from src.execution import ExecutionEngine


class DummyStore:
    def __init__(self):
        self.ctrl = {"mode": "paper", "arm_live": 0, "confirm_token": None, "confirm_expires_at": None}
        self.alerts = []

    def update_runtime_control(self, **kwargs):
        self.ctrl.update(kwargs)

    def get_runtime_control(self):
        return self.ctrl

    def save_alert(self, severity, message, pair_id=None, details=None):
        self.alerts.append((severity, message, pair_id, details))

    def save_order(self, *args, **kwargs):
        pass


class DummyClient:
    pass


def test_live_guard_blocks_when_not_armed():
    cfg = {"live_safety": {"require_arm": True, "require_typed_confirm": True, "confirm_token_ttl_sec": 30}}
    store = DummyStore()
    engine = ExecutionEngine(cfg, store, DummyClient(), DummyClient())
    out = engine.execute("c1", [], mode="live", typed_confirm="x")
    assert out[0]["status"] == "blocked"