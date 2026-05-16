#!/usr/bin/env python3
"""Reconcile GRID3 ward names to INEC ward codes.

GRID3 / OCHA COD-AB ward features carry the local ward name (e.g.
"Itire Ikate") and an OCHA P-code (e.g. NGA009007003), but no INEC
ward code. The portal's `wards` table is keyed on INEC codes, so we
need a name-based join keyed on (state, LGA, ward).

Strategy:
  1. Normalise names (strip diacritics, lowercase, collapse whitespace,
     drop punctuation, drop common noise tokens like "ward").
  2. Exact match on (state, LGA, ward) within a per-LGA bucket.
  3. Fuzzy fallback: difflib.SequenceMatcher ratio within the same LGA,
     accept if >= FUZZY_ACCEPT, flag in [FUZZY_REVIEW, FUZZY_ACCEPT).
  4. Anything below FUZZY_REVIEW is left unmatched for operator review.

Operators can override matches by maintaining a CSV at
  data/ward_boundaries/overrides.csv
with columns:  source_ward_id,inec_ward_code,note
Overrides win unconditionally and get confidence 1.000.

This script is importable (used by load_ward_boundaries.py) and also
runs standalone to produce a reconciliation report:

    python scripts/reconcile_ward_names.py \\
        data/ward_boundaries/nga_admbnda_adm3.geojson \\
        > data/ward_boundaries/reconciliation.csv

Standalone mode reads INEC wards from the Polling-Units scraper output
(no DB connection required) so it can be run on a fresh clone before
loading the full dataset.
"""

from __future__ import annotations

import csv
import json
import os
import sys
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Iterable

FUZZY_ACCEPT = 0.90    # >= this -> accept, marked low-confidence below 1.0
FUZZY_REVIEW = 0.75    # >= this -> emit as needs-review, do not auto-apply
NOISE_TOKENS = {"ward", "district", "area", "council"}


@dataclass(frozen=True)
class InecWard:
    state_code: str
    state_name: str
    lga_code: str
    lga_name: str
    ward_code: str
    ward_name: str


@dataclass
class Match:
    source_ward_id: str
    source_state: str
    source_lga: str
    source_ward: str
    inec_ward_code: str | None
    confidence: float
    reason: str   # "exact" | "fuzzy" | "override" | "no_lga" | "no_ward" | "ambiguous"


# ---------------------------------------------------------------------------
# Normalisation
# ---------------------------------------------------------------------------

def _strip_diacritics(value: str) -> str:
    nfkd = unicodedata.normalize("NFKD", value)
    return "".join(ch for ch in nfkd if not unicodedata.combining(ch))


def normalise(value: str | None) -> str:
    if not value:
        return ""
    s = _strip_diacritics(str(value)).lower()
    out_chars = []
    for ch in s:
        if ch.isalnum() or ch.isspace():
            out_chars.append(ch)
        else:
            out_chars.append(" ")
    tokens = [t for t in "".join(out_chars).split() if t and t not in NOISE_TOKENS]
    return " ".join(tokens)


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

# GRID3 / OCHA COD-AB property names vary across vintages; try them all.
SOURCE_PROPS = {
    "ward_name": ("ADM3_EN", "ward_name", "WARD_NAME", "name", "NAME"),
    "lga_name":  ("ADM2_EN", "lga_name", "LGA_NAME"),
    "state_name": ("ADM1_EN", "state_name", "STATE_NAME"),
    "ward_id":   ("ADM3_PCODE", "ward_pcode", "WARD_PCODE", "pcode", "id"),
}


def _first(props: dict, keys: tuple[str, ...]) -> str | None:
    for k in keys:
        v = props.get(k)
        if v not in (None, ""):
            return str(v)
    return None


def iter_source_features(geojson_path: Path) -> Iterable[tuple[dict, dict]]:
    """Yield (properties, geometry) tuples from a GeoJSON FeatureCollection."""
    payload = json.loads(geojson_path.read_text())
    if payload.get("type") != "FeatureCollection":
        raise ValueError("expected a GeoJSON FeatureCollection")
    for feature in payload["features"]:
        yield feature.get("properties") or {}, feature.get("geometry") or {}


def load_inec_from_scraper(results_dir: Path) -> list[InecWard]:
    """Load INEC wards from the Polling-Units scraper output."""
    wards: list[InecWard] = []
    for path in sorted(results_dir.glob("*.json")):
        if path.name == "all-polling-units.json":
            continue
        try:
            payload = json.loads(path.read_text())
        except json.JSONDecodeError:
            continue
        state = payload.get("state") or {}
        state_code = state.get("code") or ""
        state_name = state.get("name") or payload.get("state_name") or ""
        if not state_code:
            continue
        for lga in payload.get("lgas", []):
            for ward in lga.get("wards", []):
                wards.append(
                    InecWard(
                        state_code=state_code,
                        state_name=state_name,
                        lga_code=lga["code"],
                        lga_name=lga["name"],
                        ward_code=ward["code"],
                        ward_name=ward["name"],
                    )
                )
    return wards


def load_inec_from_db(conn) -> list[InecWard]:
    cur = conn.cursor()
    cur.execute(
        """
        SELECT s.code, s.name, l.code, l.name, w.code, w.name
        FROM wards w
        JOIN lgas l ON l.code = w.lga_code
        JOIN states s ON s.code = l.state_code
        """
    )
    rows = cur.fetchall()
    cur.close()
    return [InecWard(*r) for r in rows]


def load_overrides(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    overrides: dict[str, str] = {}
    with path.open() as f:
        reader = csv.DictReader(f)
        for row in reader:
            src = (row.get("source_ward_id") or "").strip()
            inec = (row.get("inec_ward_code") or "").strip()
            if src and inec:
                overrides[src] = inec
    return overrides


# ---------------------------------------------------------------------------
# Reconciliation
# ---------------------------------------------------------------------------

def _bucket_by_lga(wards: list[InecWard]) -> dict[tuple[str, str], list[InecWard]]:
    buckets: dict[tuple[str, str], list[InecWard]] = {}
    for w in wards:
        key = (normalise(w.state_name), normalise(w.lga_name))
        buckets.setdefault(key, []).append(w)
    return buckets


def reconcile(
    source_features: Iterable[tuple[dict, dict]],
    inec_wards: list[InecWard],
    overrides: dict[str, str] | None = None,
) -> list[Match]:
    overrides = overrides or {}
    by_lga = _bucket_by_lga(inec_wards)
    inec_by_code = {w.ward_code: w for w in inec_wards}
    matches: list[Match] = []

    for props, _geom in source_features:
        src_state = _first(props, SOURCE_PROPS["state_name"]) or ""
        src_lga   = _first(props, SOURCE_PROPS["lga_name"])   or ""
        src_ward  = _first(props, SOURCE_PROPS["ward_name"])  or ""
        src_id    = _first(props, SOURCE_PROPS["ward_id"])    or f"{src_state}|{src_lga}|{src_ward}"

        # 1. Overrides win.
        if src_id in overrides:
            target = overrides[src_id]
            if target in inec_by_code:
                matches.append(Match(src_id, src_state, src_lga, src_ward, target, 1.0, "override"))
                continue

        n_state = normalise(src_state)
        n_lga   = normalise(src_lga)
        n_ward  = normalise(src_ward)

        bucket = by_lga.get((n_state, n_lga))
        if not bucket:
            matches.append(Match(src_id, src_state, src_lga, src_ward, None, 0.0, "no_lga"))
            continue

        # 2. Exact ward match within the LGA bucket.
        exact = [w for w in bucket if normalise(w.ward_name) == n_ward]
        if len(exact) == 1:
            matches.append(Match(src_id, src_state, src_lga, src_ward, exact[0].ward_code, 1.0, "exact"))
            continue
        if len(exact) > 1:
            matches.append(Match(src_id, src_state, src_lga, src_ward, None, 0.0, "ambiguous"))
            continue

        # 3. Fuzzy fallback within the same LGA.
        best: tuple[float, InecWard] | None = None
        for w in bucket:
            ratio = SequenceMatcher(None, n_ward, normalise(w.ward_name)).ratio()
            if best is None or ratio > best[0]:
                best = (ratio, w)
        if best and best[0] >= FUZZY_ACCEPT:
            matches.append(Match(src_id, src_state, src_lga, src_ward, best[1].ward_code, round(best[0], 3), "fuzzy"))
        elif best and best[0] >= FUZZY_REVIEW:
            matches.append(Match(src_id, src_state, src_lga, src_ward, best[1].ward_code, round(best[0], 3), "needs_review"))
        else:
            matches.append(Match(src_id, src_state, src_lga, src_ward, None, round(best[0], 3) if best else 0.0, "no_ward"))

    return matches


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _summarise(matches: list[Match]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for m in matches:
        counts[m.reason] = counts.get(m.reason, 0) + 1
    return counts


def main(geojson_path: str, inec_source: str | None = None) -> int:
    src = Path(geojson_path)
    if not src.exists():
        print(f"GeoJSON not found: {src}", file=sys.stderr)
        return 2

    inec_dir = Path(inec_source or "Polling-Units/results")
    inec_wards = load_inec_from_scraper(inec_dir)
    if not inec_wards:
        print(
            f"No INEC wards loaded from {inec_dir}. Run the scraper first, "
            "or point at a populated results directory.",
            file=sys.stderr,
        )
        return 2

    overrides = load_overrides(Path("data/ward_boundaries/overrides.csv"))
    matches = reconcile(iter_source_features(src), inec_wards, overrides)

    writer = csv.writer(sys.stdout)
    writer.writerow([
        "source_ward_id", "source_state", "source_lga", "source_ward",
        "inec_ward_code", "confidence", "reason",
    ])
    for m in matches:
        writer.writerow([
            m.source_ward_id, m.source_state, m.source_lga, m.source_ward,
            m.inec_ward_code or "", f"{m.confidence:.3f}", m.reason,
        ])

    summary = _summarise(matches)
    print(
        "summary: " + ", ".join(f"{k}={v}" for k, v in sorted(summary.items())),
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None))
