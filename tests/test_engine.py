"""Guarantees the website and the deck rely on."""

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from engine import bars as B, data, indicators as I, labels as L, model as M

DATA = Path(__file__).resolve().parents[1] / "data"


@pytest.fixture(scope="module")
def reliance():
    sess = data.session(data.load_minutes(DATA / "RELIANCE.csv"))
    sizes = B.daily_bar_sizes(sess)
    bars = I.add_indicators(B.build_bars(sess, sizes))
    return sess, sizes, bars


def test_every_bar_reaches_its_share_target(reliance):
    _, sizes, bars = reliance
    assert (bars["volume"] == bars["date"].map(sizes)).all()


def test_bar_volume_is_conserved(reliance):
    """Shares in completed bars never exceed the shares that actually traded that day."""
    sess, _, bars = reliance
    traded = sess.groupby("date")["volume"].sum()
    in_bars = bars.groupby("date")["volume"].sum()
    assert (in_bars <= traded[in_bars.index] + 1e-6).all()
    assert ((traded[in_bars.index] - in_bars) < bars.groupby("date")["volume"].first()).all()


def test_no_bar_crosses_a_trading_day(reliance):
    _, _, bars = reliance
    start_day = pd.to_datetime(bars["start"], unit="s", utc=True).dt.tz_convert("Asia/Kolkata").dt.strftime("%Y-%m-%d")
    end_day = pd.to_datetime(bars["end"], unit="s", utc=True).dt.tz_convert("Asia/Kolkata").dt.strftime("%Y-%m-%d")
    assert (start_day == bars["date"]).all() and (end_day == bars["date"]).all()


def test_bars_are_in_time_order_with_positive_fill(reliance):
    _, _, bars = reliance
    assert (bars["fill_min"] > 0).all()
    assert (bars.groupby("date")["end"].diff().dropna() > 0).all()


def test_bar_size_uses_previous_days_only(reliance):
    """Changing today's and later volumes must not change today's bar size."""
    sess, sizes, _ = reliance
    day = sorted(sizes)[len(sizes) // 2]
    tampered = sess.copy()
    tampered.loc[tampered["date"] >= day, "volume"] *= 10
    assert B.daily_bar_sizes(tampered)[day] == sizes[day]


def test_indicators_never_use_future_bars(reliance):
    """Rewriting the second half of the history must leave first-half indicators identical."""
    _, _, bars = reliance
    raw = bars[["date", "start", "end", "open", "high", "low", "close", "volume", "buy_vol", "fill_min"]].copy()
    cut = len(raw) // 2
    tampered = raw.copy()
    tampered.loc[cut:, ["close", "high", "low"]] *= 1.5
    tampered.loc[cut:, "fill_min"] *= 0.1
    tampered.loc[cut:, "buy_vol"] = tampered.loc[cut:, "volume"]
    a = I.add_indicators(raw).iloc[:cut]
    b = I.add_indicators(tampered).iloc[:cut]
    for col in ["baseline_min", "pace", "speed", "vpin", "aai", "vol_regime"]:
        pd.testing.assert_series_equal(a[col], b[col], check_names=False)


def test_vpin_and_absorption_ranges(reliance):
    _, _, bars = reliance
    v = bars["vpin"].dropna()
    assert ((v >= 0) & (v <= 1)).all()
    assert (bars["aai"].dropna() <= 1).all()


def test_labels_only_look_forward_within_the_day(reliance):
    sess, _, bars = reliance
    labelled = L.add_labels(bars.head(300), sess)
    late = labelled["end"] % 86400 > (15 * 3600 + 10 * 60 - 19800)   # after ~15:10 IST
    assert labelled.loc[late, "big_move"].isna().all()


def test_auc_matches_known_values():
    y = np.array([0, 0, 1, 1])
    assert M.auc(y, np.array([0.1, 0.2, 0.8, 0.9])) == 1.0
    assert M.auc(y, np.array([0.9, 0.8, 0.2, 0.1])) == 0.0
    assert M.auc(y, np.array([0.5, 0.5, 0.5, 0.5])) == 0.5
