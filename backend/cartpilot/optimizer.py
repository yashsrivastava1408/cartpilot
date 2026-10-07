"""Split a grocery list across apps for the lowest total. Deterministic, no LLM.

Cost of an app that receives at least one item:
    subtotal + handling_fee
    + delivery_fee   unless subtotal >= free_delivery_threshold
    + small_cart_fee if subtotal < small_cart_threshold

Exhaustive search with pruning runs first under a node budget; if the budget runs
out the problem goes to an integer linear program (PuLP + CBC). Both are exact and
are tested against each other. All arithmetic is in integer paise, so there is no float drift.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from .config import Settings, get_settings
from .models import AppCart, Baseline, CartLine, FeeConfig, OptimizeItem, OptimizeRequest, OptimizeResponse

log = logging.getLogger("cartpilot.optimize")


def _paise(rupees: float) -> int:
    return int(round(rupees * 100))


def _rupees(paise: int) -> float:
    return round(paise / 100, 2)


@dataclass(frozen=True)
class _Fees:
    delivery: int
    free_at: int | None
    handling: int
    small_fee: int
    small_below: int

    @classmethod
    def of(cls, f: FeeConfig) -> "_Fees":
        return cls(
            delivery=_paise(f.delivery_fee),
            free_at=None if f.free_delivery_threshold is None else _paise(f.free_delivery_threshold),
            handling=_paise(f.handling_fee),
            small_fee=_paise(f.small_cart_fee),
            small_below=_paise(f.small_cart_threshold),
        )

    def delivery_for(self, subtotal: int) -> int:
        return 0 if self.free_at is not None and subtotal >= self.free_at else self.delivery

    def small_for(self, subtotal: int) -> int:
        return self.small_fee if subtotal < self.small_below else 0

    def total_for(self, subtotal: int) -> int:
        return subtotal + self.handling + self.delivery_for(subtotal) + self.small_for(subtotal)


@dataclass
class _Problem:
    apps: list[str]
    fees: list[_Fees]
    items: list[OptimizeItem]
    # cost[i][a] = line cost in paise, or None when app a does not offer item i
    cost: list[list[int | None]]
    max_apps: int

    def total(self, assignment: list[int]) -> int:
        subtotals = [0] * len(self.apps)
        used = [False] * len(self.apps)
        for i, a in enumerate(assignment):
            subtotals[a] += self.cost[i][a]  # type: ignore[operator]
            used[a] = True
        return sum(self.fees[a].total_for(subtotals[a]) for a in range(len(self.apps)) if used[a])


class _BudgetExceeded(Exception):
    """The pruned search visited more nodes than allowed; hand the problem to the ILP."""


def _solve_exhaustive(p: _Problem, node_budget: int | None = None) -> list[int] | None:
    n, k = len(p.items), len(p.apps)
    nodes = 0
    # Costliest items first: their choice moves the bound the most, so pruning bites early.
    order = sorted(range(n), key=lambda i: -max(c for c in p.cost[i] if c is not None))
    min_rest = [0] * (n + 1)
    for pos in range(n - 1, -1, -1):
        min_rest[pos] = min_rest[pos + 1] + min(c for c in p.cost[order[pos]] if c is not None)

    best_key: tuple[int, int] | None = None
    best: list[int] | None = None
    current = [0] * n
    subtotals = [0] * k
    counts = [0] * k

    def visit(pos: int, goods: int, used: int) -> None:
        nonlocal best_key, best, nodes
        nodes += 1
        if node_budget is not None and nodes > node_budget:
            raise _BudgetExceeded
        if best_key is not None:
            # Fees are never negative, so goods + cheapest remaining is a valid lower bound.
            handling = sum(p.fees[a].handling for a in range(k) if counts[a])
            if goods + min_rest[pos] + handling > best_key[0]:
                return
        if pos == n:
            total = sum(p.fees[a].total_for(subtotals[a]) for a in range(k) if counts[a])
            key = (total, used)
            if best_key is None or key < best_key:
                best_key, best = key, current.copy()
            return
        i = order[pos]
        for a in sorted(range(k), key=lambda a: (p.cost[i][a] is None, p.cost[i][a] or 0)):
            c = p.cost[i][a]
            if c is None:
                continue
            new_used = used + (0 if counts[a] else 1)
            if new_used > p.max_apps:
                continue
            current[i] = a
            subtotals[a] += c
            counts[a] += 1
            visit(pos + 1, goods + c, new_used)
            subtotals[a] -= c
            counts[a] -= 1

    visit(0, 0, 0)
    return best


def _solve_ilp(p: _Problem) -> list[int] | None:
    import pulp

    n, k = len(p.items), len(p.apps)
    prob = pulp.LpProblem("cartpilot_split", pulp.LpMinimize)
    x = {(i, a): pulp.LpVariable(f"x_{i}_{a}", cat="Binary") for i in range(n) for a in range(k) if p.cost[i][a] is not None}
    used = [pulp.LpVariable(f"used_{a}", cat="Binary") for a in range(k)]
    pays_delivery = [pulp.LpVariable(f"deliv_{a}", cat="Binary") for a in range(k)]
    pays_small = [pulp.LpVariable(f"small_{a}", cat="Binary") for a in range(k)]

    subtotal = [pulp.lpSum(p.cost[i][a] * x[i, a] for i in range(n) if (i, a) in x) for a in range(k)]
    prob += pulp.lpSum(
        subtotal[a] + p.fees[a].handling * used[a] + p.fees[a].delivery * pays_delivery[a] + p.fees[a].small_fee * pays_small[a]
        for a in range(k)
    )
    for i in range(n):
        prob += pulp.lpSum(x[i, a] for a in range(k) if (i, a) in x) == 1
    for (_i, a), var in x.items():
        prob += var <= used[a]
    prob += pulp.lpSum(used) <= p.max_apps
    for a in range(k):
        f = p.fees[a]
        if f.free_at is None:
            prob += pays_delivery[a] == used[a]
        else:
            # A used app either pays delivery or its subtotal reaches the threshold.
            prob += subtotal[a] >= f.free_at * (used[a] - pays_delivery[a])
        if f.small_fee and f.small_below:
            prob += subtotal[a] >= f.small_below * (used[a] - pays_small[a])

    status = prob.solve(pulp.PULP_CBC_CMD(msg=False, timeLimit=20))
    if pulp.LpStatus[status] != "Optimal":
        return None
    assignment = [-1] * n
    for (i, a), var in x.items():
        if (var.value() or 0) > 0.5:
            assignment[i] = a
    return assignment if all(a >= 0 for a in assignment) else None


def _ilp_available() -> bool:
    try:
        import pulp

        return bool(pulp.PULP_CBC_CMD(msg=False).available())
    except Exception:
        return False


ILP_AVAILABLE = _ilp_available()


def _build_carts(p: _Problem, assignment: list[int]) -> tuple[list[AppCart], int]:
    carts: list[AppCart] = []
    grand = 0
    for a, app in enumerate(p.apps):
        idx = [i for i, chosen in enumerate(assignment) if chosen == a]
        if not idx:
            continue
        lines = []
        for i in idx:
            item, offer = p.items[i], p.items[i].offers[app]
            lines.append(
                CartLine(
                    item_id=item.item_id,
                    name=item.name,
                    product_id=offer.product_id,
                    product_name=offer.name,
                    size_text=offer.size_text,
                    quantity=item.quantity,
                    unit_price=offer.unit_price,
                    line_total=_rupees(p.cost[i][a]),  # type: ignore[arg-type]
                )
            )
        f = p.fees[a]
        subtotal = sum(p.cost[i][a] for i in idx)  # type: ignore[misc]
        delivery, small = f.delivery_for(subtotal), f.small_for(subtotal)
        total = subtotal + f.handling + delivery + small
        grand += total
        gap = f.free_at - subtotal if (f.free_at is not None and delivery > 0) else None
        carts.append(
            AppCart(
                app=app,
                lines=lines,
                subtotal=_rupees(subtotal),
                delivery_fee=_rupees(delivery),
                handling_fee=_rupees(f.handling),
                small_cart_fee=_rupees(small),
                total=_rupees(total),
                free_delivery_gap=_rupees(gap) if gap is not None else None,
            )
        )
    return carts, grand


def optimize(request: OptimizeRequest, settings: Settings | None = None) -> OptimizeResponse:
    settings = settings or get_settings()
    apps = sorted(request.fees)
    fees = [_Fees.of(request.fees[a]) for a in apps]
    fulfillable = [i for i in request.items if i.offers]
    unfulfilled = [i.item_id for i in request.items if not i.offers]
    notes: list[str] = []

    if not fulfillable:
        return OptimizeResponse(
            assignment={}, carts=[], total=0, unfulfilled=unfulfilled, baselines=[], best_single=None,
            savings=None, savings_pct=None, method="none", notes=["No item is available on any app."],
        )

    cost = [[_paise(i.offers[a].unit_price) * i.quantity if a in i.offers else None for a in apps] for i in fulfillable]
    problem = _Problem(apps=apps, fees=fees, items=fulfillable, cost=cost, max_apps=request.max_apps or len(apps))

    # Single-app baselines: everything that app carries, bought there.
    baselines: list[Baseline] = []
    single_assignments: dict[str, list[int]] = {}
    for a, app in enumerate(apps):
        carried = [i for i in range(len(fulfillable)) if cost[i][a] is not None]
        if not carried:
            continue
        subtotal = sum(cost[i][a] for i in carried)  # type: ignore[misc]
        missing = [fulfillable[i].item_id for i in range(len(fulfillable)) if cost[i][a] is None]
        baselines.append(Baseline(app=app, total=_rupees(fees[a].total_for(subtotal)), complete=not missing, missing=missing))
        if not missing:
            single_assignments[app] = [a] * len(fulfillable)
    baselines.sort(key=lambda b: (not b.complete, b.total, b.app))
    best_single = next((b for b in baselines if b.complete), None)

    # Pruned exhaustive search is instant for almost every real basket, so try it first with a
    # node budget. Only when prices are so close that pruning cannot bite does the ILP take over.
    assignment: list[int] | None = None
    method = "exhaustive"
    try:
        assignment = _solve_exhaustive(problem, settings.exhaustive_limit if ILP_AVAILABLE else None)
    except _BudgetExceeded:
        assignment, method = _solve_ilp(problem), "ilp"
        if assignment is None:
            log.warning("ILP did not reach an optimal solution; finishing with exhaustive search")
            assignment, method = _solve_exhaustive(problem), "exhaustive"
    if not ILP_AVAILABLE and len(fulfillable) > 25:
        notes.append("ILP solver unavailable; used exhaustive search, which may be slow for long lists.")
    if assignment is None:
        return OptimizeResponse(
            assignment={}, carts=[], total=0, unfulfilled=[i.item_id for i in request.items], baselines=baselines,
            best_single=best_single, savings=None, savings_pct=None, method=method,
            notes=[f"No split fits within {problem.max_apps} app(s); raise the app limit."],
        )

    split_total = problem.total(assignment)
    kept_single = False
    if best_single is not None and request.min_split_saving > 0:
        single_total = _paise(best_single.total)
        if len(set(assignment)) > 1 and single_total - split_total < _paise(request.min_split_saving):
            assignment, kept_single = single_assignments[best_single.app], True
            notes.append(
                f"Splitting would save only ₹{_rupees(single_total - split_total):g}, below your "
                f"₹{request.min_split_saving:g} minimum, so everything stays on one app."
            )

    carts, total = _build_carts(problem, assignment)
    savings = savings_pct = None
    if best_single is not None:
        single_total = _paise(best_single.total)
        savings = _rupees(single_total - total)
        savings_pct = round(100 * (single_total - total) / single_total, 1) if single_total else 0.0
    else:
        notes.append("No single app carries every item, so there is no one-app total to compare against.")
    if unfulfilled:
        notes.append(f"{len(unfulfilled)} item(s) are not available on any app and were left out.")

    return OptimizeResponse(
        assignment={fulfillable[i].item_id: apps[a] for i, a in enumerate(assignment)},
        carts=carts,
        total=_rupees(total),
        unfulfilled=unfulfilled,
        baselines=baselines,
        best_single=best_single,
        savings=savings,
        savings_pct=savings_pct,
        method=method,  # type: ignore[arg-type]
        kept_single_app=kept_single,
        split_total=_rupees(split_total),
        notes=notes,
    )
