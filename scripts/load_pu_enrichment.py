#!/usr/bin/env python3
"""Enrich the polling-unit registry from an external roster (issues #65, #66).

``scripts/load_polling_units.py`` builds the registry from INEC's own roster
and leaves two columns NULL, for the reason stated in its docstring::

    INEC's published roster carries neither GPS coordinates nor registered
    voter counts; ``geog`` and ``registered_voters`` are left NULL and can be
    enriched from another source later.

This is that later. It does two jobs against one source:

  **Geo enrichment (#65)** - populate ``geog`` + ``registered_voters`` for
  polling units we already have. Until this runs, ``geog`` is NULL for every
  row, which means ``app/ingestion/geofence.py`` never makes a real decision:
  the GPS anti-fraud control exists in code and does nothing in production.

  **Gap fill (#66)** - insert wards and polling units that INEC's API does not
  return at all. ``Polling-Units/reconciliation/RECONCILIATION-2023.md``
  records a 2,671-PU (1.51%) deficit against INEC's own published count, and
  the 2026-06-20 re-scrape recovered none of it: those wards return zero
  polling units from INEC's API. The deficit is real and upstream.

Both passes are idempotent. Re-running changes nothing that has not changed
in the source.

Input format
------------
A roster CSV keyed by polling-unit code, with coordinates and geography::

    polling_unit_code,status,state_name,lga_name,ward_name,unit_name,lat,lng
    01/01/01/001,exist and not blur,ABIA,ABA NORTH,EZIAMA,RAILWAY QUARTERS I,5.124,7.3702

and a voter CSV keyed by the same code::

    polling_unit_code,Registered_num,Accredited_num
    01/01/01/001,968.0,85.0

Codes arrive as ``SS/LL/WW/PPP`` and are normalised to the bare ``delim`` form
``SS-LL-WW-PPP`` that ``polling_units.pu_code`` uses.

What this loader deliberately does not do
-----------------------------------------
* **Accredited voters are read but not stored.** Accreditation is a fact about
  one election, not about a polling unit, so it belongs with the per-election
  baseline (#67) rather than in the election-agnostic registry.
* **Vote tallies are ignored entirely**, for the same reason.
* **No LGA is created without ``--create-missing-lgas``.** One is legitimately
  missing: INEC's published count of 774 includes Borno / Abadam, but its
  polling-unit roster returns nothing for it, so the registry holds 773. A
  roster supplying Abadam's units fills a real hole. Creating an LGA is still
  opt-in and logged. A polling unit in an unknown *state* is never accommodated
  at all -- that aborts.

Provenance
----------
Every row this loader touches is stamped with ``--source`` (default
``ccij_2023``). A coordinate INEC never published must not become
indistinguishable from one it did.

Usage::

    # Inspect the input and report what would change, touching nothing:
    python scripts/load_pu_enrichment.py --roster roster.csv \\
        --voter-info voters.csv --dry-run --report /tmp/rejects.csv

    # Geo enrichment only:
    DATABASE_URL=postgresql://... python scripts/load_pu_enrichment.py \\
        --roster roster.csv --voter-info voters.csv --no-gap-fill

    # Both passes:
    DATABASE_URL=postgresql://... python scripts/load_pu_enrichment.py \\
        --roster roster.csv --voter-info voters.csv

Requires migration 0017.
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from math import isnan
from pathlib import Path

# ─── Constants ────────────────────────────────────────────────────────────

# Nigeria's bounding box, generously padded. Coordinates outside it are not
# imprecise, they are wrong - null island, a foreign point, or a parsing
# artifact - and are rejected rather than loaded.
#
# Note what this cannot catch: the latitude range (3.5-14.5) and longitude
# range (2.0-15.5) overlap almost entirely, so a transposed lat/lng pair
# usually lands back inside the box. Detecting transposition needs a
# different signal - agreement with the polling unit's known state, say -
# and is not attempted here.
NIGERIA_BBOX = (3.5, 14.5, 2.0, 15.5)  # (lat_min, lat_max, lng_min, lng_max)

# pu_code as stored: four dash-separated numeric segments.
PU_CODE_RE = re.compile(r"^\d{1,3}-\d{1,3}-\d{1,3}-\d{1,4}$")

_WS = re.compile(r"\s+")

# Precision labels, mirroring the CHECK constraint in migration 0017.
PRECISION_EXACT = "exact"
PRECISION_SHARED = "shared_site"
PRECISION_APPROX = "approximate"


def clean(s: str | None) -> str:
    return _WS.sub(" ", s or "").strip()


def title_case(s: str | None) -> str:
    return clean(s).title()


# ─── Pure parsing and validation ──────────────────────────────────────────


def normalise_pu_code(raw: str | None) -> str | None:
    """``"01/01/01/001"`` -> ``"01-01-01-001"``. None if not a PU code.

    Accepts either separator so the loader is indifferent to which form the
    source uses. Returns None rather than raising: a malformed code is a row
    to report, not a run to abort.
    """
    code = clean(raw).replace("/", "-")
    if not code or not PU_CODE_RE.match(code):
        return None
    return code


def parse_coordinate(lat_raw: str | None, lng_raw: str | None) -> tuple[float, float] | None:
    """Parse a lat/lng pair. None if either value is absent or unparseable."""
    try:
        lat = float(clean(lat_raw))
        lng = float(clean(lng_raw))
    except (TypeError, ValueError):
        return None
    # NaN parses as a float and compares false against every bound, so the
    # bbox test below would not catch it. Exclude it explicitly.
    if isnan(lat) or isnan(lng):
        return None
    return lat, lng


def in_nigeria_bbox(lat: float, lng: float) -> bool:
    lat_min, lat_max, lng_min, lng_max = NIGERIA_BBOX
    return lat_min <= lat <= lat_max and lng_min <= lng <= lng_max


def parse_count(raw: str | None) -> int | None:
    """Parse a voter count. Source writes them as floats (``968.0``).

    Negative counts are rejected: ``polling_units.registered_voters`` carries
    a ``CHECK (registered_voters >= 0)`` and a loader should not discover that
    constraint by tripping it mid-batch.
    """
    text = clean(raw)
    if not text:
        return None
    try:
        value = float(text)
    except ValueError:
        return None
    if isnan(value) or value < 0:
        return None
    return int(value)


@dataclass(frozen=True)
class RosterRow:
    pu_code: str
    pu_name: str
    ward_name: str
    lga_name: str
    state_name: str
    lat: float
    lng: float


@dataclass
class Rejects:
    """Rows the loader refused, kept so they can be reported rather than
    silently dropped. A loader that quietly discards 300 rows looks exactly
    like a loader that had nothing to discard."""

    rows: list[tuple[str, str, str]] = field(default_factory=list)  # (code, reason, detail)

    def add(self, code: str, reason: str, detail: str = "") -> None:
        self.rows.append((code, reason, detail))

    def by_reason(self) -> Counter:
        return Counter(reason for _, reason, _ in self.rows)

    def __len__(self) -> int:
        return len(self.rows)


def read_roster(path: Path) -> tuple[list[RosterRow], Rejects]:
    """Parse the roster CSV. Returns (usable rows, rejects).

    A row is usable when it has a well-formed code and a coordinate inside
    Nigeria. Rows failing either test are rejected with a reason; rows with a
    good code but no usable coordinate are still returned as gap-fill
    candidates by ``read_roster_geography``.
    """
    rows: list[RosterRow] = []
    rejects = Rejects()
    seen: set[str] = set()

    with path.open(newline="") as f:
        for raw in csv.DictReader(f):
            code = normalise_pu_code(raw.get("polling_unit_code"))
            if code is None:
                rejects.add(clean(raw.get("polling_unit_code")), "malformed_pu_code")
                continue
            if code in seen:
                rejects.add(code, "duplicate_pu_code")
                continue
            seen.add(code)

            coord = parse_coordinate(raw.get("lat"), raw.get("lng"))
            if coord is None:
                rejects.add(code, "missing_coordinate")
                continue
            lat, lng = coord
            if not in_nigeria_bbox(lat, lng):
                rejects.add(code, "coordinate_outside_nigeria", f"{lat},{lng}")
                continue

            rows.append(
                RosterRow(
                    pu_code=code,
                    pu_name=clean(raw.get("unit_name")) or code,
                    ward_name=title_case(raw.get("ward_name")),
                    lga_name=title_case(raw.get("lga_name")),
                    state_name=clean(raw.get("state_name")),
                    lat=lat,
                    lng=lng,
                )
            )

    return rows, rejects


def read_roster_geography(path: Path) -> dict[str, tuple[str, str, str, str]]:
    """Every well-formed code in the roster mapped to its names, coordinate or
    not: ``code -> (pu_name, ward_name, lga_name, state_name)``.

    Gap fill needs this separately from ``read_roster``: a polling unit absent
    from our registry is worth inserting even when its coordinate is unusable.
    Losing the unit entirely because we could not place it on a map would be
    the wrong trade.
    """
    out: dict[str, tuple[str, str, str, str]] = {}
    with path.open(newline="") as f:
        for raw in csv.DictReader(f):
            code = normalise_pu_code(raw.get("polling_unit_code"))
            if code is None or code in out:
                continue
            out[code] = (
                clean(raw.get("unit_name")) or code,
                title_case(raw.get("ward_name")),
                title_case(raw.get("lga_name")),
                clean(raw.get("state_name")),
            )
    return out


def read_voter_info(path: Path) -> tuple[dict[str, int], Rejects]:
    """Parse registered-voter counts. Returns (code -> registered, rejects).

    Accredited voters and party tallies in this file are election facts and
    are not read here; they belong to the per-election baseline (#67).
    """
    out: dict[str, int] = {}
    rejects = Rejects()

    with path.open(newline="") as f:
        for raw in csv.DictReader(f):
            code = normalise_pu_code(raw.get("polling_unit_code"))
            if code is None:
                rejects.add(clean(raw.get("polling_unit_code")), "malformed_pu_code")
                continue
            registered = parse_count(raw.get("Registered_num"))
            if registered is None:
                rejects.add(code, "missing_registered_voters")
                continue
            out[code] = registered

    return out, rejects


def classify_precision(rows: list[RosterRow]) -> dict[str, str]:
    """Label each coordinate ``exact`` or ``shared_site``.

    Co-located polling units - several PUs in one school, market or town hall
    - resolve to a single point in every roster we have seen. In the CCIJ 2023
    roster that is 20,542 polling units, 11.6% of the 176,526 with a usable
    coordinate.

    ``exact`` here means *unique within this source*, not survey-grade. It is
    the strongest claim the input supports, and the geofence treats it as the
    only precision on which a hard reject may be based.
    """
    counts: Counter = Counter((r.lat, r.lng) for r in rows)
    return {
        r.pu_code: (PRECISION_EXACT if counts[(r.lat, r.lng)] == 1 else PRECISION_SHARED)
        for r in rows
    }


def ward_prefix(pu_code: str) -> str:
    """``"01-08-10-004"`` -> ``"01-08-10"``."""
    return pu_code.rsplit("-", 1)[0]


def lga_prefix(pu_code: str) -> str:
    """``"01-08-10-004"`` -> ``"01-08"``."""
    return "-".join(pu_code.split("-")[:2])


def state_prefix(pu_code: str) -> str:
    """``"01-08-10-004"`` -> ``"01"``."""
    return pu_code.split("-")[0]


# ─── Database access ──────────────────────────────────────────────────────
#
# psycopg2 is imported lazily inside these functions. It is not a worker
# dependency (see worker/pyproject.toml), so a module-level import would make
# the pure functions above untestable in CI.


def connect(url: str):
    import psycopg2

    # Matches load_polling_units.py: keepalives stop the Supabase pooler
    # treating idle gaps between batches as a dead connection.
    return psycopg2.connect(
        url,
        keepalives=1,
        keepalives_idle=30,
        keepalives_interval=10,
        keepalives_count=5,
        connect_timeout=15,
    )


def fetch_registry(cur) -> tuple[set[str], dict[str, str], dict[str, str], dict[str, str]]:
    """Read what the registry already holds.

    Returns (pu codes, ward-prefix -> ward_code, lga-prefix -> lga_code,
    state-prefix -> state_code).

    The prefix maps are built from existing polling units rather than by
    re-deriving codes from the delim, because ``load_polling_units.py`` merges
    LGAs and wards that collide on ``UNIQUE (parent, name)`` and the resulting
    code is not always the one string construction would predict.
    """
    cur.execute("SELECT pu_code, ward_code, lga_code, state_code FROM polling_units")
    pu_codes: set[str] = set()
    ward_by_prefix: dict[str, str] = {}
    lga_by_prefix: dict[str, str] = {}
    state_by_prefix: dict[str, str] = {}

    for pu_code, ward_code, lga_code, state_code in cur.fetchall():
        pu_codes.add(pu_code)
        ward_by_prefix.setdefault(ward_prefix(pu_code), ward_code)
        lga_by_prefix.setdefault(lga_prefix(pu_code), lga_code)
        state_by_prefix.setdefault(state_prefix(pu_code), state_code)

    return pu_codes, ward_by_prefix, lga_by_prefix, state_by_prefix


def upsert_lga(cur, code: str, name: str, state_code: str) -> str:
    """Insert an LGA, returning its effective code.

    Only reachable under ``--create-missing-lgas``. Mirrors
    ``load_polling_units.upsert_lga``: on a ``UNIQUE (state_code, name)``
    collision the existing row wins and its code comes back.
    """
    cur.execute(
        """
        INSERT INTO lgas (code, name, state_code) VALUES (%s, %s, %s)
        ON CONFLICT (state_code, name) DO UPDATE SET name = EXCLUDED.name
        RETURNING code
        """,
        (code, name, state_code),
    )
    return cur.fetchone()[0]


def upsert_ward(cur, code: str, name: str, lga_code: str, source: str) -> str:
    """Insert a ward, returning its effective code.

    Mirrors ``load_polling_units.upsert_ward``: on a ``UNIQUE (lga_code,
    name)`` collision the existing row wins and its code comes back, so
    callers must re-parent under the returned value rather than the requested
    one. ``source`` is only applied on insert - an existing INEC-scraped ward
    is not relabelled by a later enrichment run.
    """
    cur.execute(
        """
        INSERT INTO wards (code, name, lga_code, source) VALUES (%s, %s, %s, %s)
        ON CONFLICT (lga_code, name) DO UPDATE SET name = EXCLUDED.name
        RETURNING code
        """,
        (code, name, lga_code, source),
    )
    return cur.fetchone()[0]


def insert_pus(cur, rows: list[tuple], source: str) -> None:
    """rows: (pu_code, pu_name, ward_code, lga_code, state_code).

    ``DO NOTHING`` rather than ``DO UPDATE``: gap fill is strictly additive.
    A polling unit INEC did enumerate keeps its INEC-scraped identity even if
    the enrichment roster describes it differently.
    """
    import psycopg2.extras

    psycopg2.extras.execute_batch(
        cur,
        """
        INSERT INTO polling_units (
            pu_code, pu_name, ward_code, lga_code, state_code, source, scraped_at
        ) VALUES (%s, %s, %s, %s, %s, %s, NOW())
        ON CONFLICT (pu_code) DO NOTHING
        """,
        [(*r, source) for r in rows],
        page_size=500,
    )


def enrich_registered_only_batch(cur, rows: list[tuple]) -> None:
    """rows: (registered, source, pu_code).

    Registered voters and coordinates are independent facts about a polling
    unit, and the roster supplies plenty of units with one and not the other.
    Writing the count only where a coordinate happened to parse would silently
    drop it for the rest - 320 polling units and 120,988 registered voters in
    the CCIJ roster, which is exactly the sort of quiet shortfall that later
    reads as a data-quality problem in the totals.
    """
    import psycopg2.extras

    psycopg2.extras.execute_batch(
        cur,
        """
        UPDATE polling_units SET
            registered_voters = %s,
            registered_voters_source = %s
        WHERE pu_code = %s
        """,
        rows,
        page_size=500,
    )


def enrich_batch(cur, rows: list[tuple]) -> None:
    """rows: (lng, lat, precision, registered, source, pu_code).

    ``registered`` may be None, in which case the existing value is kept -
    a roster without a voter count must not blank a count we already have.
    """
    import psycopg2.extras

    psycopg2.extras.execute_batch(
        cur,
        """
        UPDATE polling_units SET
            geog = ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
            geog_precision = %s,
            registered_voters = COALESCE(%s, registered_voters),
            registered_voters_source =
                CASE WHEN %s IS NULL THEN registered_voters_source ELSE %s END,
            geog_source = %s
        WHERE pu_code = %s
        """,
        [(lng, lat, prec, reg, reg, src, src, code) for lng, lat, prec, reg, src, code in rows],
        page_size=500,
    )


# ─── Passes ───────────────────────────────────────────────────────────────


def plan_gap_fill(
    roster_geo: dict[str, tuple[str, str, str, str]],
    known_pus: set[str],
    ward_by_prefix: dict[str, str],
    lga_by_prefix: dict[str, str],
    state_by_prefix: dict[str, str] | None = None,
) -> tuple[dict[str, list[str]], dict[str, tuple[str, str]], list[str]]:
    """Work out what gap fill would insert.

    Returns (ward prefix -> missing PU codes,
             lga prefix -> (lga_name, state_code) for LGAs we could create,
             orphan PU codes).

    An LGA absent from the registry is not automatically an error. Borno /
    Abadam is the known case: INEC's published count of 774 includes it, but
    its polling-unit roster returns nothing for it, so
    ``load_polling_units.py`` never created the row and we hold 773. A roster
    that supplies Abadam's polling units is filling a real hole.

    What is never acceptable is inventing an LGA in a *state* we cannot place.
    Those stay orphans and abort the run. So the two cases are separated here:
    a creatable LGA needs a state we already know; anything else is a
    disagreement about the shape of the country and belongs with a human.

    Creating even a placeable LGA still requires ``--create-missing-lgas``.
    """
    state_by_prefix = state_by_prefix or {}
    missing_by_ward: dict[str, list[str]] = defaultdict(list)
    creatable_lgas: dict[str, tuple[str, str]] = {}
    orphans: list[str] = []

    for code in sorted(set(roster_geo) - known_pus):
        lga_pfx = lga_prefix(code)
        if lga_pfx not in lga_by_prefix:
            state_code = state_by_prefix.get(state_prefix(code))
            if state_code is None:
                orphans.append(code)
                continue
            _, _, lga_name, _ = roster_geo[code]
            creatable_lgas.setdefault(lga_pfx, (lga_name, state_code))
        missing_by_ward[ward_prefix(code)].append(code)

    return dict(missing_by_ward), creatable_lgas, orphans


def abort_on_orphans(orphans: list[str]) -> None:
    """Refuse to run when polling units sit in a state the registry lacks.

    A missing LGA can be legitimate (see ``plan_gap_fill``), but a missing
    *state* means the input and the registry disagree about the shape of the
    country. Accommodating that silently would bury the disagreement in the
    geography table, where nobody would find it again.
    """
    if not orphans:
        return
    print(
        f"\nABORTING: {len(orphans)} polling unit(s) sit in a state that is not in"
        " the registry.\nThis loader will not invent one. Investigate before"
        " re-running:",
        file=sys.stderr,
    )
    for code in orphans[:10]:
        print(f"  {code}  (state prefix {state_prefix(code)})", file=sys.stderr)
    if len(orphans) > 10:
        print(f"  ... and {len(orphans) - 10} more", file=sys.stderr)
    raise SystemExit(3)


def abort_on_uncreated_lgas(creatable: dict[str, tuple[str, str]]) -> None:
    """Refuse to proceed when LGAs are missing and ``--create-missing-lgas``
    was not given.

    Creating an LGA changes the shape of the geography table, so it is an
    opt-in act with a name attached, not a side effect of an enrichment run.
    """
    if not creatable:
        return
    print(
        f"\nABORTING: {len(creatable)} LGA(s) in the roster are absent from the"
        " registry.\nThis is legitimate for Borno / Abadam, whose polling units"
        " INEC's roster omits\nentirely (we hold 773 LGAs against INEC's published"
        " 774). Re-run with\n--create-missing-lgas if these are the LGAs you expect:",
        file=sys.stderr,
    )
    for pfx, (name, state_code) in sorted(creatable.items()):
        print(f"  {pfx} -> {state_code}: {name}", file=sys.stderr)
    raise SystemExit(4)


def run_gap_fill(
    cur,
    roster_geo: dict[str, tuple[str, str, str, str]],
    missing_by_ward: dict[str, list[str]],
    creatable_lgas: dict[str, tuple[str, str]],
    ward_by_prefix: dict[str, str],
    lga_by_prefix: dict[str, str],
    source: str,
    dry_run: bool,
) -> dict[str, int]:
    stats = {"lgas_created": 0, "wards_created": 0, "pus_inserted": 0}

    # LGAs first: wards reference them.
    for pfx, (lga_name, state_code) in sorted(creatable_lgas.items()):
        requested = f"{state_code}-{pfx.split('-')[-1]}"
        if dry_run:
            lga_by_prefix[pfx] = requested
        else:
            effective = upsert_lga(cur, requested, lga_name, state_code)
            if effective != requested:
                print(
                    f"  merged LGA {state_code}/{lga_name}: {requested} ->"
                    f" {effective} (existing row with same name)",
                    file=sys.stderr,
                )
            lga_by_prefix[pfx] = effective
        print(f"  created LGA {lga_by_prefix[pfx]}: {lga_name} ({state_code})")
        stats["lgas_created"] += 1

    for prefix in sorted(missing_by_ward):
        codes = sorted(missing_by_ward[prefix])
        _, ward_name, _, _ = roster_geo[codes[0]]
        lga_code = lga_by_prefix[lga_prefix(codes[0])]
        state_code = lga_code.split("-")[0]

        ward_code = ward_by_prefix.get(prefix)
        if ward_code is None:
            requested = f"{lga_code}-{prefix.split('-')[-1]}"
            if dry_run:
                ward_code = requested
            else:
                ward_code = upsert_ward(cur, requested, ward_name, lga_code, source)
                if ward_code != requested:
                    print(
                        f"  merged ward {lga_code}/{ward_name}: {requested} ->"
                        f" {ward_code} (existing row with same name)",
                        file=sys.stderr,
                    )
            ward_by_prefix[prefix] = ward_code
            stats["wards_created"] += 1

        batch = [
            (code, roster_geo[code][0], ward_code, lga_code, state_code) for code in codes
        ]
        if not dry_run:
            insert_pus(cur, batch, source)
        stats["pus_inserted"] += len(batch)

    return stats


def run_enrichment(
    cur,
    rows: list[RosterRow],
    precision: dict[str, str],
    registered: dict[str, int],
    known_pus: set[str],
    source: str,
    dry_run: bool,
) -> dict[str, int]:
    stats = {
        "enriched": 0,
        "skipped_unknown_pu": 0,
        "with_registered": 0,
        "registered_only": 0,
        PRECISION_EXACT: 0,
        PRECISION_SHARED: 0,
    }

    batch: list[tuple] = []
    for r in rows:
        if r.pu_code not in known_pus:
            stats["skipped_unknown_pu"] += 1
            continue
        prec = precision[r.pu_code]
        reg = registered.get(r.pu_code)
        stats[prec] += 1
        if reg is not None:
            stats["with_registered"] += 1
        stats["enriched"] += 1
        batch.append((r.lng, r.lat, prec, reg, source, r.pu_code))

        if len(batch) >= 5_000:
            if not dry_run:
                enrich_batch(cur, batch)
            batch = []

    if batch and not dry_run:
        enrich_batch(cur, batch)

    # Second pass: polling units with a voter count but no usable coordinate.
    # The count is a fact in its own right and does not depend on our being
    # able to place the unit on a map.
    mapped = {r.pu_code for r in rows}
    reg_only: list[tuple] = []
    for pu_code, reg in registered.items():
        if pu_code in mapped or pu_code not in known_pus:
            continue
        stats["registered_only"] += 1
        stats["with_registered"] += 1
        reg_only.append((reg, source, pu_code))

        if len(reg_only) >= 5_000:
            if not dry_run:
                enrich_registered_only_batch(cur, reg_only)
            reg_only = []

    if reg_only and not dry_run:
        enrich_registered_only_batch(cur, reg_only)

    return stats


# ─── Reporting ────────────────────────────────────────────────────────────


def write_report(path: Path, rejects: Rejects) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["pu_code", "reason", "detail"])
        w.writerows(rejects.rows)


def print_rejects(label: str, rejects: Rejects) -> None:
    if not rejects:
        print(f"{label}: no rejected rows")
        return
    print(f"{label}: {len(rejects)} rejected row(s)")
    for reason, count in sorted(rejects.by_reason().items()):
        print(f"    {reason:32s} {count:>7,}")


# ─── Entry point ──────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--roster", required=True, type=Path, help="roster CSV with coordinates")
    p.add_argument("--voter-info", type=Path, help="CSV with Registered_num per PU")
    p.add_argument(
        "--source",
        default="ccij_2023",
        help="provenance label stamped on every row touched (default: ccij_2023)",
    )
    p.add_argument("--report", type=Path, help="write rejected rows to this CSV")
    p.add_argument("--dry-run", action="store_true", help="report only; write nothing")
    p.add_argument(
        "--no-gap-fill",
        dest="gap_fill",
        action="store_false",
        help="skip inserting wards/PUs absent from the registry (#66)",
    )
    p.add_argument(
        "--no-enrich",
        dest="enrich",
        action="store_false",
        help="skip populating geog/registered_voters (#65)",
    )
    p.add_argument(
        "--create-missing-lgas",
        action="store_true",
        help=(
            "create LGAs present in the roster but absent from the registry."
            " Needed for Borno / Abadam, whose polling units INEC's roster omits"
            " entirely. Off by default: creating an LGA is a deliberate act."
        ),
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if not args.roster.is_file():
        print(f"roster not found: {args.roster}", file=sys.stderr)
        return 2
    if args.voter_info and not args.voter_info.is_file():
        print(f"voter info not found: {args.voter_info}", file=sys.stderr)
        return 2

    url = os.environ.get("DATABASE_URL")
    if not url and not args.dry_run:
        print("DATABASE_URL not set (use --dry-run to parse without a database)", file=sys.stderr)
        return 2

    # ── Parse ─────────────────────────────────────────────────────────────
    print(f"Reading roster: {args.roster}")
    rows, rejects = read_roster(args.roster)
    roster_geo = read_roster_geography(args.roster)
    precision = classify_precision(rows)

    print(f"  {len(roster_geo):,} well-formed polling-unit codes")
    print(f"  {len(rows):,} with a usable coordinate")
    print_rejects("  roster", rejects)

    shared = sum(1 for p in precision.values() if p == PRECISION_SHARED)
    print(
        f"  precision: {len(precision) - shared:,} exact, {shared:,} shared_site"
        f" ({shared / len(precision):.1%} sit on a point shared with another PU)"
        if precision
        else "  precision: no coordinates"
    )

    registered: dict[str, int] = {}
    if args.voter_info:
        print(f"Reading voter info: {args.voter_info}")
        registered, voter_rejects = read_voter_info(args.voter_info)
        print(f"  {len(registered):,} registered-voter counts")
        print_rejects("  voter info", voter_rejects)
        rejects.rows.extend(voter_rejects.rows)

    if args.report:
        write_report(args.report, rejects)
        print(f"Rejected rows written to {args.report}")

    if args.dry_run and not url:
        print("\nDry run without DATABASE_URL: parsed input only, no registry comparison.")
        return 0

    # ── Apply ─────────────────────────────────────────────────────────────
    conn = connect(url)
    conn.autocommit = False
    try:
        cur = conn.cursor()
        known_pus, ward_by_prefix, lga_by_prefix, state_by_prefix = fetch_registry(cur)
        print(f"\nRegistry holds {len(known_pus):,} polling units")

        if args.gap_fill:
            missing_by_ward, creatable_lgas, orphans = plan_gap_fill(
                roster_geo, known_pus, ward_by_prefix, lga_by_prefix, state_by_prefix
            )
            missing_count = sum(len(v) for v in missing_by_ward.values())
            new_wards = sum(1 for p in missing_by_ward if p not in ward_by_prefix)
            print(
                f"Gap fill: {missing_count:,} polling units absent from the registry,"
                f" across {len(missing_by_ward):,} wards ({new_wards:,} of them new)"
                + (f", {len(creatable_lgas):,} LGAs missing" if creatable_lgas else "")
                + (f"; {len(orphans):,} in an unknown state" if orphans else "")
            )
            # Reported before aborting, so the operator sees the whole picture
            # rather than only the reason for stopping.
            abort_on_orphans(orphans)
            if not args.create_missing_lgas:
                abort_on_uncreated_lgas(creatable_lgas)

            stats = run_gap_fill(
                cur, roster_geo, missing_by_ward, creatable_lgas, ward_by_prefix,
                lga_by_prefix, args.source, args.dry_run,
            )
            print(
                f"  LGAs created: {stats['lgas_created']:,}"
                f"   wards created: {stats['wards_created']:,}"
                f"   polling units inserted: {stats['pus_inserted']:,}"
            )
            # Newly inserted PUs are enrichable in the same run.
            known_pus |= set(roster_geo)

        if args.enrich:
            stats = run_enrichment(
                cur, rows, precision, registered, known_pus, args.source, args.dry_run
            )
            print(
                f"Enrichment: {stats['enriched']:,} polling units"
                f" ({stats[PRECISION_EXACT]:,} exact, {stats[PRECISION_SHARED]:,} shared_site);"
                f" {stats['with_registered']:,} with registered-voter counts"
                + (
                    f" (of which {stats['registered_only']:,} have a count but no"
                    " usable coordinate)"
                    if stats["registered_only"]
                    else ""
                )
            )
            if stats["skipped_unknown_pu"]:
                print(
                    f"  {stats['skipped_unknown_pu']:,} roster rows skipped:"
                    " polling unit not in the registry"
                    + (" (run with gap fill to insert them)" if not args.gap_fill else "")
                )

        if args.dry_run:
            conn.rollback()
            print("\nDry run: rolled back, nothing written.")
        else:
            conn.commit()
            print("\nCommitted.")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
