"""Ward boundary reconciliation (GRID3 -> INEC) - matching logic.

The script lives under repo `scripts/` rather than the worker package
(it is a one-off operator tool, not part of the running service), so
this test pulls it in via a sys.path tweak. Kept here so it runs in CI
alongside the rest of the Python suite.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from reconcile_ward_names import InecWard, normalise, reconcile  # noqa: E402


INEC = [
    InecWard("LA", "Lagos", "LA-SUR", "Surulere", "LA-SUR-04", "Itire Ikate"),
    InecWard("LA", "Lagos", "LA-SUR", "Surulere", "LA-SUR-05", "Coker Aguda"),
    InecWard("LA", "Lagos", "LA-IKJ", "Ikeja",    "LA-IKJ-02", "Onigbongbo"),
    InecWard("FC", "FCT",   "FC-AMA", "AMAC",     "FC-AMA-09", "Garki"),
]


def _feature(state: str, lga: str, ward: str, pcode: str) -> tuple[dict, dict]:
    return ({"ADM1_EN": state, "ADM2_EN": lga, "ADM3_EN": ward, "ADM3_PCODE": pcode}, {})


def test_normalise_handles_diacritics_punctuation_and_noise():
    assert normalise("Garki Ward") == "garki"
    assert normalise("Itire-Ikate WARD") == "itire ikate"
    assert normalise("Ìjèbú") == "ijebu"
    assert normalise(None) == ""
    assert normalise("  Multi   Space  ") == "multi space"


def test_exact_match_inside_lga_bucket():
    [m] = reconcile([_feature("Lagos", "Surulere", "Itire-Ikate", "NGA1")], INEC)
    assert m.inec_ward_code == "LA-SUR-04"
    assert m.reason == "exact"
    assert m.confidence == 1.0


def test_noise_token_removal_still_matches():
    # "Coker-Aguda Ward" should match "Coker Aguda" after noise strip.
    [m] = reconcile([_feature("Lagos", "Surulere", "Coker-Aguda Ward", "NGA2")], INEC)
    assert m.inec_ward_code == "LA-SUR-05"
    assert m.reason == "exact"


def test_fuzzy_match_within_lga():
    # "Onigbomgbo" (typo) vs "Onigbongbo".
    [m] = reconcile([_feature("Lagos", "Ikeja", "Onigbomgbo", "NGA3")], INEC)
    assert m.inec_ward_code == "LA-IKJ-02"
    assert m.reason == "fuzzy"
    assert 0.85 <= m.confidence < 1.0


def test_unknown_lga_is_not_matched():
    [m] = reconcile([_feature("FCT", "Bwari", "Kubwa", "NGA4")], INEC)
    assert m.inec_ward_code is None
    assert m.reason == "no_lga"


def test_override_wins_unconditionally():
    feature = _feature("FCT", "AMAC", "XYZ Garbage", "NGA5")
    [m] = reconcile([feature], INEC, overrides={"NGA5": "FC-AMA-09"})
    assert m.inec_ward_code == "FC-AMA-09"
    assert m.reason == "override"
    assert m.confidence == 1.0


def test_override_pointing_at_missing_inec_code_is_ignored():
    feature = _feature("Lagos", "Surulere", "Itire-Ikate", "NGA1")
    [m] = reconcile([feature], INEC, overrides={"NGA1": "DOES-NOT-EXIST"})
    # Override is dropped; falls back to exact match.
    assert m.inec_ward_code == "LA-SUR-04"
    assert m.reason == "exact"
