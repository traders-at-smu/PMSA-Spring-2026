"""Fee formula DSL: parse and safely evaluate configurable fee expressions.

Predefined variables available in any formula string:
  p   = contract price / probability  (0–1 range, e.g. 0.65 = 65% YES chance)
  q   = 1 − p  (complement probability, i.e. chance of the opposite outcome)
  c   = number of contracts being traded

Allowed operators: + − * / ** ( )
No function calls or external names are permitted.

Examples
--------
  "p * (1 - p) * 0.007 * c"    Kalshi standard:   price × (1-price) × 0.7% × contracts
  "p * q * 0.0175 * c"         Polymarket standard: same structure with 1.75% rate
  "0.02 * c"                   Flat 2 cents per contract regardless of price
"""

from __future__ import annotations

import ast
import math

_ALLOWED_NAMES: frozenset[str] = frozenset({"p", "q", "c"})
_SAFE_GLOBALS: dict = {"__builtins__": {}}


def parse_formula(formula: str):
    """Parse a fee formula string and return a callable fee_fn(p, c) -> float.

    The callable takes:
        p (float): contract price / probability in [0, 1]
        c (int):   number of contracts

    Raises ValueError if the formula uses disallowed names or contains
    function calls.
    """
    formula = formula.strip()
    try:
        tree = ast.parse(formula, mode="eval")
    except SyntaxError as exc:
        raise ValueError(f"Invalid fee formula syntax: {formula!r} — {exc}") from exc

    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id not in _ALLOWED_NAMES:
            raise ValueError(
                f"Unknown variable '{node.id}' in formula {formula!r}. "
                f"Allowed variables: {', '.join(sorted(_ALLOWED_NAMES))}"
            )
        if isinstance(node, ast.Call):
            raise ValueError(
                f"Function calls are not allowed in fee formulas: {formula!r}"
            )

    # compile once for speed
    code = compile(tree, "<fee_formula>", "eval")

    def fee_fn(p: float, c: int) -> float:
        return float(eval(code, _SAFE_GLOBALS, {"p": float(p), "q": 1.0 - float(p), "c": int(c)}))  # noqa: S307

    return fee_fn


def validate_formula(formula: str, name: str = "formula") -> None:
    """Validate a formula string by parsing it and running a test evaluation.

    Raises ValueError with a descriptive message on any failure.
    Intended to be called at startup so config errors surface immediately.
    """
    try:
        fn = parse_formula(formula)
        result = fn(0.5, 10)
    except Exception as exc:
        raise ValueError(f"Fee formula '{name}' is invalid: {exc}") from exc
    if not isinstance(result, (int, float)):
        raise ValueError(f"Fee formula '{name}' did not return a number")


def apply_fee(formula_fn, p: float, c: int, round_up: bool = False) -> float:
    """Evaluate the compiled fee formula; optionally round up to nearest cent.

    Always returns a non-negative value — fees cannot be negative.
    """
    fee = max(0.0, formula_fn(p, c))
    if round_up:
        fee = math.ceil(fee * 100.0) / 100.0
    return fee
