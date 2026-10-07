import dataclasses
import itertools
import random

import pytest

from cartpilot import optimizer
from cartpilot.config import get_settings
from cartpilot.models import FeeConfig, Offer, OptimizeItem, OptimizeRequest
from cartpilot.optimizer import ILP_AVAILABLE, optimize

APPS = ["blinkit", "instamart", "zepto"]


def fees(delivery=30, free=200, handling=5, small=0, small_below=0):
    return FeeConfig(delivery_fee=delivery, free_delivery_threshold=free, handling_fee=handling,
                     small_cart_fee=small, small_cart_threshold=small_below)


def item(i, qty=1, **prices):
    return OptimizeItem(item_id=f"i{i}", name=f"item {i}", quantity=qty,
                        offers={a: Offer(product_id=f"{a}-{i}", name=f"p{i}", unit_price=p) for a, p in prices.items()})


def cart_cost(subtotal, f: FeeConfig):
    free = f.free_delivery_threshold is not None and subtotal >= f.free_delivery_threshold
    return subtotal + f.handling_fee + (0 if free else f.delivery_fee) + (f.small_cart_fee if subtotal < f.small_cart_threshold else 0)


def reference(items, fee_map, max_apps=None):
    """Plain brute force over every assignment, written independently of the solver."""
    live = [i for i in items if i.offers]
    best = None
    for combo in itertools.product(*[sorted(i.offers) for i in live]):
        if max_apps and len(set(combo)) > max_apps:
            continue
        subtotals = {}
        for it, app in zip(live, combo):
            subtotals[app] = subtotals.get(app, 0) + it.offers[app].unit_price * it.quantity
        total = round(sum(cart_cost(s, fee_map[a]) for a, s in subtotals.items()), 2)
        best = total if best is None else min(best, total)
    return best


def force(method, monkeypatch=None):
    return dataclasses.replace(get_settings(), exhaustive_limit=0 if method == "ilp" else 10**12)


def test_single_app_when_fees_dominate():
    req = OptimizeRequest(items=[item(1, zepto=50, blinkit=49), item(2, zepto=60, blinkit=61)],
                          fees={"zepto": fees(), "blinkit": fees()})
    res = optimize(req)
    assert len(res.carts) == 1 and res.total == 145.0  # 110 + 30 delivery + 5 handling on either app
    assert res.savings == 0 and res.method == "exhaustive"
    assert res.best_single.total == 145.0


def test_split_when_it_really_saves():
    req = OptimizeRequest(
        items=[item(1, zepto=300, blinkit=400), item(2, zepto=400, blinkit=300)],
        fees={"zepto": fees(), "blinkit": fees()},
    )
    res = optimize(req)
    assert res.assignment == {"i1": "zepto", "i2": "blinkit"}
    assert res.total == 610.0 and res.best_single.total == 705.0
    assert res.savings == 95.0 and res.savings_pct == 13.5
    assert [c.app for c in res.carts] == ["blinkit", "zepto"]
    assert all(c.delivery_fee == 0 and c.free_delivery_gap is None for c in res.carts)


def test_pays_more_for_an_item_to_reach_free_delivery():
    # Moving the 30-rupee item to zepto costs 5 more but lifts zepto over the free-delivery line
    # and avoids opening a second cart.
    req = OptimizeRequest(
        items=[item(1, zepto=180), item(2, zepto=35, blinkit=30)],
        fees={"zepto": fees(delivery=40, free=200), "blinkit": fees(delivery=40, free=200)},
    )
    res = optimize(req)
    assert res.assignment == {"i1": "zepto", "i2": "zepto"} and res.total == 220.0


def test_cart_breakdown_and_gap():
    req = OptimizeRequest(items=[item(1, qty=3, zepto=20.5)],
                          fees={"zepto": fees(delivery=25, free=100, handling=4, small=15, small_below=99)})
    cart = optimize(req).carts[0]
    assert cart.subtotal == 61.5 and cart.lines[0].line_total == 61.5 and cart.lines[0].quantity == 3
    assert (cart.delivery_fee, cart.handling_fee, cart.small_cart_fee) == (25, 4, 15)
    assert cart.total == 105.5 and cart.free_delivery_gap == 38.5


def test_threshold_is_inclusive_and_none_means_never_free():
    at = OptimizeRequest(items=[item(1, zepto=200)], fees={"zepto": fees(free=200)})
    assert optimize(at).carts[0].delivery_fee == 0
    never = OptimizeRequest(items=[item(1, zepto=5000)], fees={"zepto": fees(free=None)})
    cart = optimize(never).carts[0]
    assert cart.delivery_fee == 30 and cart.free_delivery_gap is None


def test_unfulfilled_and_incomplete_baselines():
    req = OptimizeRequest(
        items=[item(1, zepto=100), item(2, blinkit=100), item(3)],
        fees={"zepto": fees(), "blinkit": fees(), "instamart": fees()},
    )
    res = optimize(req)
    assert res.unfulfilled == ["i3"] and res.assignment == {"i1": "zepto", "i2": "blinkit"}
    assert res.best_single is None and res.savings is None and res.savings_pct is None
    assert {b.app: (b.complete, b.missing) for b in res.baselines} == {
        "zepto": (False, ["i2"]), "blinkit": (False, ["i1"])}
    assert any("No single app" in n for n in res.notes)


def test_nothing_available():
    res = optimize(OptimizeRequest(items=[item(1), item(2)], fees={"zepto": fees()}))
    assert res.method == "none" and res.carts == [] and res.unfulfilled == ["i1", "i2"] and res.total == 0


def test_max_apps():
    items = [item(1, zepto=300, blinkit=400), item(2, zepto=400, blinkit=300)]
    f = {"zepto": fees(), "blinkit": fees()}
    res = optimize(OptimizeRequest(items=items, fees=f, max_apps=1))
    assert len(res.carts) == 1 and res.total == 705.0 and res.savings == 0
    impossible = optimize(OptimizeRequest(items=[item(1, zepto=1), item(2, blinkit=1)], fees=f, max_apps=1))
    assert impossible.carts == [] and "app limit" in impossible.notes[0]


def test_min_split_saving_keeps_one_app():
    items = [item(1, zepto=300, blinkit=310), item(2, zepto=310, blinkit=300)]
    f = {"zepto": fees(), "blinkit": fees()}
    free = optimize(OptimizeRequest(items=items, fees=f))
    assert len(free.carts) == 2 and free.savings == 5.0
    kept = optimize(OptimizeRequest(items=items, fees=f, min_split_saving=20))
    assert len(kept.carts) == 1 and kept.kept_single_app and kept.savings == 0 and kept.split_total == free.total
    still = optimize(OptimizeRequest(items=items, fees=f, min_split_saving=5))
    assert len(still.carts) == 2 and not still.kept_single_app


def test_validation():
    with pytest.raises(ValueError):
        OptimizeRequest(items=[item(1, zepto=1)], fees={"blinkit": fees()})
    with pytest.raises(ValueError):
        OptimizeRequest(items=[item(1, zepto=1), item(1, zepto=2)], fees={"zepto": fees()})
    with pytest.raises(ValueError):
        OptimizeRequest(items=[], fees={"zepto": fees()})


def random_problem(rng, n):
    fee_map = {
        a: fees(delivery=rng.choice([0, 15, 25, 40]), free=rng.choice([None, 99, 199, 299, 499]),
                handling=rng.choice([0, 4, 9]), small=rng.choice([0, 10, 20]), small_below=rng.choice([0, 49, 99]))
        for a in APPS
    }
    items = []
    for i in range(n):
        base = rng.choice([12, 28, 45, 60, 99, 150, 240])
        prices = {a: round(base * rng.uniform(0.85, 1.15), 2) for a in APPS if rng.random() > 0.2}
        items.append(item(i, qty=rng.choice([1, 1, 1, 2, 3]), **prices))
    return items, fee_map


@pytest.mark.parametrize("seed", range(60))
def test_exhaustive_matches_brute_force(seed):
    rng = random.Random(seed)
    items, fee_map = random_problem(rng, rng.randint(1, 8))
    max_apps = rng.choice([None, None, 1, 2])
    res = optimize(OptimizeRequest(items=items, fees=fee_map, max_apps=max_apps), force("exhaustive"))
    expected = reference(items, fee_map, max_apps)
    if expected is None:
        assert res.carts == []
    else:
        assert res.total == expected
        assert round(sum(c.total for c in res.carts), 2) == res.total
        assert sorted(res.assignment) == sorted(i.item_id for i in items if i.offers)


@pytest.mark.skipif(not ILP_AVAILABLE, reason="CBC solver not available")
@pytest.mark.parametrize("seed", range(40))
def test_ilp_matches_brute_force(seed):
    rng = random.Random(1000 + seed)
    items, fee_map = random_problem(rng, rng.randint(1, 8))
    max_apps = rng.choice([None, None, 1, 2])
    res = optimize(OptimizeRequest(items=items, fees=fee_map, max_apps=max_apps), force("ilp"))
    expected = reference(items, fee_map, max_apps)
    if expected is None:
        assert res.carts == []
    else:
        assert res.method == "ilp" and res.total == expected


def near_tie_problem(n):
    """Almost identical prices everywhere: the worst case for pruning."""
    fee_map = {a: fees(delivery=30, free=10_000, handling=5) for a in APPS}
    rng = random.Random(42)
    return [item(i, **{a: 100 + rng.choice([0, 0.5, 1]) for a in APPS}) for i in range(n)], fee_map


@pytest.mark.skipif(not ILP_AVAILABLE, reason="CBC solver not available")
def test_big_easy_basket_stays_on_the_fast_path():
    rng = random.Random(7)
    items, fee_map = random_problem(rng, 40)
    req = OptimizeRequest(items=items, fees=fee_map)
    auto = optimize(req)
    assert auto.method == "exhaustive"
    assert optimize(req, force("ilp")).total == auto.total


@pytest.mark.skipif(not ILP_AVAILABLE, reason="CBC solver not available")
def test_hard_basket_runs_out_of_budget_and_ilp_takes_over():
    items, fee_map = near_tie_problem(22)
    res = optimize(OptimizeRequest(items=items, fees=fee_map))
    assert res.method == "ilp" and len(res.carts) == 1  # one cart: a second delivery fee never pays here
    cheapest_single = min(b.total for b in res.baselines)
    assert res.total == cheapest_single


@pytest.mark.skipif(not ILP_AVAILABLE, reason="CBC solver not available")
def test_sixty_items_finishes():
    rng = random.Random(3)
    items, fee_map = random_problem(rng, 60)
    res = optimize(OptimizeRequest(items=items, fees=fee_map))
    assert len(res.assignment) == sum(1 for i in items if i.offers)
    assert res.best_single is None or res.total <= res.best_single.total
    assert optimize(OptimizeRequest(items=items, fees=fee_map), force("ilp")).total == res.total


def test_without_solver_exhaustive_runs_to_the_end(monkeypatch):
    monkeypatch.setattr(optimizer, "ILP_AVAILABLE", False)
    rng = random.Random(11)
    items, fee_map = random_problem(rng, 9)
    res = optimize(OptimizeRequest(items=items, fees=fee_map), force("ilp"))  # budget 0, but no ILP to fall to
    assert res.method == "exhaustive" and res.total == reference(items, fee_map)


def test_never_worse_than_best_single_app():
    for seed in range(30):
        rng = random.Random(500 + seed)
        items, fee_map = random_problem(rng, rng.randint(2, 9))
        res = optimize(OptimizeRequest(items=items, fees=fee_map))
        if res.best_single:
            assert res.savings >= 0
