"""Streamlit dashboard for trading operations and API observability."""

from __future__ import annotations

import argparse
import json
import time
from typing import Any

import pandas as pd
import streamlit as st

from src.config import load_config
from src.connectors.kalshi import KalshiClient
from src.connectors.polymarket import PolymarketClient
from src.execution import ExecutionEngine
from src.service import BotService
from src.state_store import StateStore


def _parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="config/config.json")
    parser.add_argument("--credentials", default="config/credentials.json")
    return parser.parse_args()


def _runtime(args):
    config = load_config(args.config, args.credentials)
    store = StateStore(config["paths"]["state_db"])
    kalshi = KalshiClient(config)
    poly = PolymarketClient(config)
    execution = ExecutionEngine(config, store, kalshi, poly)
    service = BotService(config, store, kalshi, poly, execution)
    return config, store, execution, service


def _inject_styles() -> None:
    st.markdown(
        """
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Manrope:wght@400;500;600;700&display=swap');

          :root {
            --bg: #0a0d13;
            --bg-soft: #0f1420;
            --panel: rgba(16, 22, 34, 0.78);
            --panel-strong: rgba(19, 27, 41, 0.92);
            --line: rgba(147, 162, 190, 0.26);
            --text: #e8ecf3;
            --muted: #a0adbf;
            --accent-warm: #c8a37e;
            --accent-cool: #6e97ff;
          }

          .stApp {
            font-family: "Manrope", sans-serif;
            color: var(--text);
            background:
              radial-gradient(72rem 52rem at 8% -8%, rgba(200, 163, 126, 0.22), transparent 50%),
              radial-gradient(62rem 46rem at 100% -12%, rgba(110, 151, 255, 0.18), transparent 55%),
              linear-gradient(160deg, #080b11 0%, #0b1018 55%, #090d15 100%);
          }

          .stApp [data-testid="stAppViewContainer"] {
            background: transparent;
          }

          .stApp .block-container {
            max-width: 1360px;
            padding-top: 2rem;
            padding-bottom: 2.25rem;
          }

          h1, h2, h3 {
            font-family: "Fraunces", Georgia, serif;
            letter-spacing: -0.018em;
            color: #f4f0e9;
          }

          p, label, span, div, li {
            color: var(--text);
          }

          [data-testid="stCaptionContainer"] p {
            color: var(--muted);
          }

          [data-testid="stMetric"] {
            background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.01));
            border: 1px solid var(--line);
            border-radius: 14px;
            padding: 0.85rem 1rem;
            backdrop-filter: blur(6px);
          }

          [data-testid="stMetricValue"] {
            font-family: "Fraunces", Georgia, serif;
            font-weight: 600;
            color: #f6f2eb;
          }

          [data-testid="stMetricLabel"] {
            text-transform: uppercase;
            letter-spacing: 0.08em;
            font-size: 0.72rem;
            color: var(--muted);
          }

          [data-testid="stTabs"] div[role="tablist"] {
            background: var(--panel);
            border: 1px solid var(--line);
            border-radius: 14px;
            padding: 0.3rem;
          }

          [data-testid="stTabs"] button[role="tab"] {
            font-weight: 650;
            color: var(--muted);
            border-radius: 10px;
            transition: all 0.18s ease;
          }

          [data-testid="stTabs"] button[role="tab"][aria-selected="true"] {
            color: #f7f1e8;
            background: linear-gradient(90deg, rgba(200, 163, 126, 0.22), rgba(110, 151, 255, 0.2));
            border: 1px solid rgba(200, 163, 126, 0.35);
          }

          [data-testid="stDataFrame"] {
            border: 1px solid var(--line);
            border-radius: 14px;
            background: var(--panel-strong);
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
          }

          [data-testid="stDataFrame"] [data-testid="stTable"] {
            color: var(--text);
          }

          [data-baseweb="select"] > div,
          .stTextInput input,
          .stNumberInput input,
          .stTextArea textarea {
            background: rgba(12, 18, 29, 0.94);
            color: var(--text);
            border: 1px solid var(--line);
            border-radius: 10px;
          }

          [data-baseweb="select"] > div:hover,
          .stTextInput input:hover,
          .stNumberInput input:hover,
          .stTextArea textarea:hover {
            border-color: rgba(200, 163, 126, 0.45);
          }

          .stButton > button {
            border-radius: 12px;
            border: 1px solid rgba(200, 163, 126, 0.4);
            color: #f5eee4;
            background:
              linear-gradient(140deg, rgba(200, 163, 126, 0.22), rgba(110, 151, 255, 0.16));
            font-weight: 650;
            letter-spacing: 0.01em;
          }

          .stButton > button:hover {
            border-color: rgba(200, 163, 126, 0.66);
            box-shadow: 0 0 0 0.18rem rgba(200, 163, 126, 0.16);
          }

          [data-testid="stExpander"] {
            border: 1px solid var(--line);
            border-radius: 12px;
            background: var(--panel);
          }

          @media (max-width: 800px) {
            .stApp .block-container {
              padding-top: 1.2rem;
              padding-bottom: 1.8rem;
            }
          }
        </style>
        """,
        unsafe_allow_html=True,
    )


def _safe_json_loads(payload: str, default: Any) -> Any:
    try:
        return json.loads(payload)
    except Exception:
        return default


def _to_dataframe(payload: Any) -> pd.DataFrame:
    if isinstance(payload, list):
        return pd.DataFrame(payload)
    if isinstance(payload, dict):
        return pd.DataFrame([payload]) if payload else pd.DataFrame()
    return pd.DataFrame()


def _ensure_current_cycle(service: BotService, store: StateStore) -> tuple[str, dict[str, Any]]:
    cycle_id = str(st.session_state.get("current_cycle_id", "")).strip()
    if cycle_id:
        cycle = store.get_cycle(cycle_id)
        if cycle:
            return cycle_id, cycle

    recent_cycles = store.list_recent_cycles(limit=1)
    if recent_cycles:
        cycle_id = str(recent_cycles[0]["cycle_id"])
        cycle = store.get_cycle(cycle_id)
        if cycle:
            st.session_state["current_cycle_id"] = cycle_id
            return cycle_id, cycle

    result = service.run_cycle(execute_trades=False)
    cycle_id = str(result["cycle_id"])
    st.session_state["current_cycle_id"] = cycle_id
    st.session_state["last_refresh_cycle_id"] = cycle_id
    st.session_state["auto_cycle_last_error_count"] = len(result.get("errors", []))
    st.session_state["auto_cycle_last_error"] = ""
    cycle = store.get_cycle(cycle_id)
    if not cycle:
        raise RuntimeError("Current cycle was created but could not be loaded from state store")
    return cycle_id, cycle


def _flatten_snapshots(snapshots: list[dict[str, Any]]) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for s in snapshots:
        k = s.get("kalshi", {}) if isinstance(s.get("kalshi"), dict) else {}
        p = s.get("polymarket", {}) if isinstance(s.get("polymarket"), dict) else {}
        rows.append(
            {
                "pair_id": s.get("pair_id", ""),
                "category": s.get("category", ""),
                "days_to_resolution": s.get("days_to_resolution", 0),
                "kalshi_ticker": s.get("kalshi_ticker", ""),
                "polymarket_market_slug": s.get("polymarket_market_slug", ""),
                "kalshi_yes_bid": k.get("yes_bid", 0),
                "kalshi_yes_ask": k.get("yes_ask", 0),
                "kalshi_no_bid": k.get("no_bid", 0),
                "kalshi_no_ask": k.get("no_ask", 0),
                "polymarket_yes_bid": p.get("yes_bid", 0),
                "polymarket_yes_ask": p.get("yes_ask", 0),
                "polymarket_no_bid": p.get("no_bid", 0),
                "polymarket_no_ask": p.get("no_ask", 0),
            }
        )
    return pd.DataFrame(rows)


def _flatten_decisions(opportunities: list[dict[str, Any]]) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for d in opportunities:
        md = d.get("metadata", {}) if isinstance(d.get("metadata"), dict) else {}
        reasons = d.get("reasons", [])
        if not isinstance(reasons, list):
            reasons = [str(reasons)]
        rows.append(
            {
                "pair_id": d.get("pair_id", ""),
                "strategy": d.get("strategy", ""),
                "trade": bool(d.get("trade", False)),
                "contracts": int(d.get("contracts", 0) or 0),
                "kalshi_side": d.get("kalshi_side", ""),
                "kalshi_price": d.get("kalshi_price", 0),
                "polymarket_side": d.get("polymarket_side", ""),
                "polymarket_price": d.get("polymarket_price", 0),
                "edge_dollar": d.get("edge_dollar", 0),
                "edge_pct": d.get("edge_pct", 0),
                "annualized_edge": d.get("annualized_edge", 0),
                "contracts_before_arb_ends": md.get("contracts_before_arb_ends", 0),
                "contracts_available_kalshi_side": md.get("contracts_available_kalshi_side", 0),
                "contracts_available_polymarket_side": md.get("contracts_available_polymarket_side", 0),
                "arb_stop_reason": md.get("arb_stop_reason", ""),
                "reasons": "; ".join(str(r) for r in reasons if str(r).strip()),
            }
        )
    return pd.DataFrame(rows)


def _render_control_panel(ctrl: dict[str, Any], store: StateStore, execution: ExecutionEngine, service: BotService) -> None:
    st.markdown("### Control Center")
    col1, col2, col3 = st.columns([1, 1, 1.25], gap="large")

    with col1:
        mode = st.selectbox("Mode", ["paper", "live"], index=0 if ctrl["mode"] == "paper" else 1, key="mode_select")
        if st.button("Apply Mode", key="apply_mode_btn", use_container_width=True):
            store.update_runtime_control(mode=mode)
            st.success(f"Mode set to {mode}")

    with col2:
        arm = st.toggle("ARM LIVE", value=bool(ctrl["arm_live"]), key="arm_toggle")
        if st.button("Apply Arm State", key="arm_state_btn", use_container_width=True):
            if arm:
                token = execution.arm_live()
                st.success(f"Live armed. Token: {token}")
            else:
                execution.disarm_live()
                st.warning("Live disarmed")

    with col3:
        typed = st.text_input("Typed confirmation token", value="", type="password", key="typed_confirm_input")
        if st.button("Run Trade Cycle", key="trade_now_btn", use_container_width=True):
            mode_now = store.get_runtime_control()["mode"]
            result = service.run_cycle(execute_trades=True, mode_override=mode_now, typed_confirm=typed)
            st.session_state["current_cycle_id"] = result["cycle_id"]
            st.session_state["last_execution_cycle_id"] = result["cycle_id"]
            st.session_state["last_execution_payload"] = result["execution"]
            st.success(f"Trade cycle completed: {result['cycle_id']}")

    action_col1, action_col2 = st.columns([1, 3], gap="large")
    with action_col1:
        if st.button("Refresh Market Data", key="refresh_data_btn", use_container_width=True):
            result = service.run_cycle(execute_trades=False)
            st.session_state["current_cycle_id"] = result["cycle_id"]
            st.session_state["last_refresh_cycle_id"] = result["cycle_id"]
            st.session_state["auto_cycle_last_error_count"] = len(result.get("errors", []))
            st.session_state["auto_cycle_last_error"] = ""
            st.success(f"Pulled cycle {result['cycle_id']}")
    with action_col2:
        if st.session_state.get("last_execution_payload"):
            with st.expander(
                f"Latest execution payload ({st.session_state.get('last_execution_cycle_id', 'n/a')})",
                expanded=False,
            ):
                st.json(st.session_state["last_execution_payload"])


def _run_auto_cycle_scheduler(service: BotService, refresh_ms: int, enabled: bool) -> None:
    interval_ms = max(250, int(refresh_ms))
    interval_sec = interval_ms / 1000.0

    @st.fragment(run_every=f"{interval_ms}ms")
    def _scheduler() -> None:
        now = time.time()

        if not enabled:
            st.session_state["auto_cycle_inflight"] = False
            st.session_state["auto_cycle_next_due_ts"] = now + interval_sec
            return

        if bool(st.session_state.get("auto_cycle_inflight", False)):
            return

        next_due = float(st.session_state.get("auto_cycle_next_due_ts", 0.0))
        if now < next_due:
            return

        st.session_state["auto_cycle_inflight"] = True
        started = time.time()
        try:
            result = service.run_cycle(execute_trades=False)
            st.session_state["last_refresh_cycle_id"] = result["cycle_id"]
            st.session_state["current_cycle_id"] = result["cycle_id"]
            st.session_state["auto_cycle_last_error_count"] = len(result.get("errors", []))
            st.session_state["auto_cycle_last_error"] = ""
        except Exception as exc:
            st.session_state["auto_cycle_last_error"] = str(exc)
        finally:
            st.session_state["auto_cycle_inflight"] = False
            st.session_state["auto_cycle_last_duration_ms"] = int((time.time() - started) * 1000)
            st.session_state["auto_cycle_next_due_ts"] = time.time() + interval_sec

        st.rerun(scope="app")

    _scheduler()


def _render_auto_cycle_status(refresh_ms: int, enabled: bool) -> None:
    if not enabled:
        st.caption(f"Auto API pull disabled. Interval configured: {refresh_ms}ms.")
        return

    inflight = bool(st.session_state.get("auto_cycle_inflight", False))
    last_cycle_id = str(st.session_state.get("last_refresh_cycle_id", ""))
    last_duration = int(st.session_state.get("auto_cycle_last_duration_ms", 0))
    last_error_count = int(st.session_state.get("auto_cycle_last_error_count", 0))
    last_error = str(st.session_state.get("auto_cycle_last_error", "")).strip()
    next_due_ts = float(st.session_state.get("auto_cycle_next_due_ts", 0.0))

    if inflight:
        st.caption("Auto API pull running...")
        return

    if last_error:
        st.warning(f"Last auto pull failed: {last_error}")

    next_due_in = max(0.0, next_due_ts - time.time())
    st.caption(
        "Auto API pull enabled "
        f"(every {refresh_ms}ms). "
        f"Last cycle: {last_cycle_id or 'n/a'} "
        f"({last_duration}ms, errors: {last_error_count}). "
        f"Next in {next_due_in:.1f}s."
    )


def app():
    st.set_page_config(page_title="Cross-Exchange Arb Bot", layout="wide")
    _inject_styles()

    args = _parse_args()
    config, store, execution, service = _runtime(args)

    st.title("Kalshi + Polymarket Arbitrage")
    st.caption("Execution controls, opportunity review, and observability in one place.")

    ctrl = store.get_runtime_control()
    _render_control_panel(ctrl, store, execution, service)
    st.divider()

    selected_cycle, cycle = _ensure_current_cycle(service, store)

    snapshots = _safe_json_loads(cycle["snapshots_json"], [])
    opportunities = _safe_json_loads(cycle["opportunities_json"], [])
    cycle_errors = _safe_json_loads(cycle.get("errors_json", "[]"), [])
    raw_kalshi = _safe_json_loads(cycle["raw_kalshi_json"], {})
    raw_polymarket = _safe_json_loads(cycle["raw_polymarket_json"], {})

    snapshots_df = _flatten_snapshots(snapshots)
    opportunities_df = _flatten_decisions(opportunities)
    errors_df = _to_dataframe(cycle_errors)
    orders_df = pd.DataFrame(store.list_orders(limit=200))
    if not orders_df.empty and "cycle_id" in orders_df.columns:
        orders_df = orders_df[orders_df["cycle_id"] == selected_cycle]
    alerts_df = pd.DataFrame(store.list_alerts(limit=200))

    tradable_count = 0
    avg_edge_pct = 0.0
    avg_annualized_edge_pct = 0.0
    if not opportunities_df.empty and "trade" in opportunities_df.columns:
        tradable_count = int(opportunities_df["trade"].fillna(False).sum())
    if not opportunities_df.empty and "edge_pct" in opportunities_df.columns:
        avg_edge_pct = float(opportunities_df["edge_pct"].fillna(0.0).mean()) * 100.0
    if not opportunities_df.empty and "annualized_edge" in opportunities_df.columns:
        avg_annualized_edge_pct = float(opportunities_df["annualized_edge"].fillna(0.0).mean()) * 100.0

    m1, m2, m3, m4, m5 = st.columns(5, gap="small")
    m1.metric("Live Cycle", selected_cycle)
    m2.metric("Pairs", len(snapshots_df))
    m3.metric("Tradable", tradable_count, delta=f"{len(opportunities_df)} opportunities")
    m4.metric("Mean Edge", f"{avg_edge_pct:.2f}%")
    m5.metric("Mean Annualized Edge", f"{avg_annualized_edge_pct:.2f}%", delta=f"{len(errors_df)} cycle errors")

    trading_tab, portfolio_tab, copy_tab, ops_tab, raw_tab = st.tabs(
        ["Trading View", "Portfolio", "Copy Trading", "Operations", "Raw API Data"]
    )

    with trading_tab:
        left, right = st.columns([1.2, 1.8], gap="large")

        with left:
            st.subheader("Current Market Prices")
            if snapshots_df.empty:
                st.info("No snapshots stored for this cycle.")
            else:
                st.dataframe(snapshots_df, use_container_width=True, hide_index=True)

        with right:
            st.subheader("Current Trade Plan")
            if opportunities_df.empty:
                st.info("No opportunities for this cycle.")
            else:
                planned_df = opportunities_df[opportunities_df["trade"] == True]  # noqa: E712
                planned_cols = [
                    "pair_id",
                    "strategy",
                    "contracts",
                    "kalshi_side",
                    "kalshi_price",
                    "polymarket_side",
                    "polymarket_price",
                    "edge_dollar",
                    "edge_pct",
                    "annualized_edge",
                    "contracts_before_arb_ends",
                    "contracts_available_kalshi_side",
                    "contracts_available_polymarket_side",
                ]
                if planned_df.empty:
                    st.info("No trades currently pass constraints.")
                else:
                    st.dataframe(
                        planned_df[[c for c in planned_cols if c in planned_df.columns]],
                        use_container_width=True,
                        hide_index=True,
                    )

                with st.expander("All evaluated opportunities", expanded=False):
                    display_cols = [
                        "pair_id",
                        "strategy",
                        "trade",
                        "contracts",
                        "edge_dollar",
                        "edge_pct",
                        "annualized_edge",
                        "kalshi_side",
                        "kalshi_price",
                        "polymarket_side",
                        "polymarket_price",
                        "arb_stop_reason",
                        "reasons",
                    ]
                    st.dataframe(
                        opportunities_df[[c for c in display_cols if c in opportunities_df.columns]],
                        use_container_width=True,
                        hide_index=True,
                    )

    with portfolio_tab:
        st.subheader("Portfolio Overview")
        portfolio_summary = service.portfolio.get_portfolio_summary()
        pc1, pc2, pc3, pc4 = st.columns(4, gap="small")
        pc1.metric("Open Positions", portfolio_summary["open_position_count"])
        pc2.metric("Total Cost", f"${portfolio_summary['total_cost']:.2f}")
        pc3.metric("Unrealized P&L", f"${portfolio_summary['total_unrealized_pnl']:.2f}")
        pc4.metric("Realized P&L", f"${portfolio_summary['total_realized_pnl']:.2f}")

        positions_df = pd.DataFrame(store.list_positions(status="open"))
        if positions_df.empty:
            st.info("No open positions.")
        else:
            st.dataframe(positions_df, use_container_width=True, hide_index=True)

        with st.expander("P&L History", expanded=False):
            pnl_history = store.list_pnl_snapshots(limit=50)
            if pnl_history:
                pnl_df = pd.DataFrame(pnl_history)
                st.dataframe(pnl_df, use_container_width=True, hide_index=True)
            else:
                st.info("No P&L snapshots yet.")

    with copy_tab:
        st.subheader("Copy Trading")

        ct_left, ct_right = st.columns([1, 2], gap="large")
        with ct_left:
            st.markdown("#### Add Copy Target")
            ct_address = st.text_input("Trader address", key="ct_address")
            ct_name = st.text_input("Trader name", key="ct_name")
            if st.button("Add Target", key="add_ct_btn"):
                if ct_address:
                    store.save_copy_target(ct_address, ct_name or ct_address[:10])
                    st.success(f"Added {ct_name or ct_address[:10]}")

            st.markdown("#### Active Targets")
            targets = store.list_copy_targets(active_only=True)
            if targets:
                targets_df = pd.DataFrame(targets)
                st.dataframe(targets_df, use_container_width=True, hide_index=True)
            else:
                st.info("No active copy targets.")

        with ct_right:
            st.markdown("#### Recent Signals")
            signals = store.list_copy_signals(limit=50)
            if signals:
                signals_df = pd.DataFrame(signals)
                st.dataframe(signals_df, use_container_width=True, hide_index=True)
            else:
                st.info("No copy trading signals yet.")

            if st.button("Poll Targets Now", key="poll_ct_btn"):
                result = service.run_copy_cycle()
                st.success(f"Found {result['signals_found']} signals")
                if result["signals"]:
                    st.json(result["signals"])

    with ops_tab:
        st.subheader("Cycle Errors")
        if errors_df.empty:
            st.success("No cycle errors for selected cycle.")
        else:
            st.dataframe(errors_df, use_container_width=True, hide_index=True)

        ops_left, ops_right = st.columns(2, gap="large")
        with ops_left:
            st.subheader("Order Ledger (Current Cycle)")
            if orders_df.empty:
                st.info("No orders recorded for this cycle.")
            else:
                st.dataframe(orders_df, use_container_width=True, hide_index=True)
        with ops_right:
            st.subheader("Alerts")
            if alerts_df.empty:
                st.info("No alerts recorded yet.")
            else:
                st.dataframe(alerts_df, use_container_width=True, hide_index=True)

    with raw_tab:
        raw_left, raw_right = st.columns(2, gap="large")
        with raw_left:
            st.subheader("Kalshi Raw Payload")
            st.json(raw_kalshi, expanded=False)
        with raw_right:
            st.subheader("Polymarket Raw Payload")
            st.json(raw_polymarket, expanded=False)

    refresh_ms = int(config.get("dashboard", {}).get("autorefresh_ms", 2000))
    auto_pull_enabled = st.toggle(
        "Auto-pull market data",
        value=bool(st.session_state.get("auto_pull_enabled", True)),
        key="auto_pull_enabled",
    )
    _render_auto_cycle_status(refresh_ms, auto_pull_enabled)
    _run_auto_cycle_scheduler(service, refresh_ms, auto_pull_enabled)


if __name__ == "__main__":
    app()
