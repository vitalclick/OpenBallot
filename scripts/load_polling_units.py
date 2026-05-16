#!/usr/bin/env python3
"""Load polling units scraped by Polling-Units/scraper.js into Postgres.

The scraper writes one JSON per state to ``Polling-Units/results/<state>.json``
with this shape (see ``Polling-Units/scraper.js`` ``saveStateResult``)::

    {
      "state_name": "ABIA",
      "summary": {...},
      "lgas": [{
        "lga_id":   "ABA NORTH",
        "lga_name": "ABA NORTH",
        "wards":    [{
          "ward_id":       "EZIAMA",
          "ward_name":     "EZIAMA",
          "polling_units": [{
            "pu_id":   "1",
            "pu_code": "ABIA-01-01-01-001",
            "pu_name": "RAILWAY QUARTERS - RAILWAY QUARTERS I",
            "delim":   "01-01-01-001",
            "registration_area": "EXISTING PU"
          }]
        }]
      }]
    }

INEC ``delim`` is the canonical hierarchy code ``SS-LL-WW-PPP`` (state /
LGA / ward / polling unit). We derive the database codes from it::

    state_code = 2-letter postal abbreviation (from STATES below)
    lga_code   = "<state_code>-<seg2>"   e.g. "AB-01"
    ward_code  = "<lga_code>-<seg3>"     e.g. "AB-01-01"
    pu_code    = bare delim              e.g. "01-01-01-001"

A pre-flight pass over all state files verifies that ``delim`` values are
globally unique before any DB writes happen. If two states claim the same
delim, the loader aborts with the offending codes rather than silently
overwriting rows under ``ON CONFLICT (pu_code) DO UPDATE``.

INEC's published roster carries neither GPS coordinates nor registered
voter counts; ``geog`` and ``registered_voters`` are left NULL and can be
enriched from another source later.

Usage::

    DATABASE_URL=postgresql://... python scripts/load_polling_units.py
    # or with an explicit results directory:
    DATABASE_URL=... python scripts/load_polling_units.py /path/to/results
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

import psycopg2
import psycopg2.extras


# 37 states + FCT. Key is the upper-case name INEC publishes; value is
# (2-letter code, display name for the `states.name` column, zone code).
# Zones use the same vocabulary as db/migrations/0001_core_schema.sql:
#   NW | NE | NC | SW | SE | SS | FCT
STATES: dict[str, tuple[str, str, str]] = {
    "ABIA":        ("AB", "Abia",        "SE"),
    "ADAMAWA":     ("AD", "Adamawa",     "NE"),
    "AKWA IBOM":   ("AK", "Akwa Ibom",   "SS"),
    "ANAMBRA":     ("AN", "Anambra",     "SE"),
    "BAUCHI":      ("BA", "Bauchi",      "NE"),
    "BAYELSA":     ("BY", "Bayelsa",     "SS"),
    "BENUE":       ("BE", "Benue",       "NC"),
    "BORNO":       ("BO", "Borno",       "NE"),
    "CROSS RIVER": ("CR", "Cross River", "SS"),
    "DELTA":       ("DE", "Delta",       "SS"),
    "EBONYI":      ("EB", "Ebonyi",      "SE"),
    "EDO":         ("ED", "Edo",         "SS"),
    "EKITI":       ("EK", "Ekiti",       "SW"),
    "ENUGU":       ("EN", "Enugu",       "SE"),
    "FCT":         ("FC", "FCT",         "FCT"),
    "GOMBE":       ("GO", "Gombe",       "NE"),
    "IMO":         ("IM", "Imo",         "SE"),
    "JIGAWA":      ("JI", "Jigawa",      "NW"),
    "KADUNA":      ("KD", "Kaduna",      "NW"),
    "KANO":        ("KN", "Kano",        "NW"),
    "KATSINA":     ("KT", "Katsina",     "NW"),
    "KEBBI":       ("KE", "Kebbi",       "NW"),
    "KOGI":        ("KO", "Kogi",        "NC"),
    "KWARA":       ("KW", "Kwara",       "NC"),
    "LAGOS":       ("LA", "Lagos",       "SW"),
    "NASARAWA":    ("NA", "Nasarawa",    "NC"),
    "NIGER":       ("NI", "Niger",       "NC"),
    "OGUN":        ("OG", "Ogun",        "SW"),
    "ONDO":        ("ON", "Ondo",        "SW"),
    "OSUN":        ("OS", "Osun",        "SW"),
    "OYO":         ("OY", "Oyo",         "SW"),
    "PLATEAU":     ("PL", "Plateau",     "NC"),
    "RIVERS":      ("RI", "Rivers",      "SS"),
    "SOKOTO":      ("SO", "Sokoto",      "NW"),
    "TARABA":      ("TA", "Taraba",      "NE"),
    "YOBE":        ("YO", "Yobe",        "NE"),
    "ZAMFARA":     ("ZA", "Zamfara",     "NW"),
}

NON_STATE_FILES = {"summary.json", "all-polling-units.json", "probe.json"}

_WS = re.compile(r"\s+")


def clean(s: str) -> str:
    return _WS.sub(" ", s or "").strip()


def title_case(s: str) -> str:
    return clean(s).title()


def parse_delim(delim: str) -> tuple[str, str, str, str] | None:
    parts = (delim or "").split("-")
    if len(parts) != 4 or not all(p.strip() for p in parts):
        return None
    return parts[0], parts[1], parts[2], parts[3]


def state_file_paths(root: Path) -> list[Path]:
    return sorted(p for p in root.glob("*.json") if p.name not in NON_STATE_FILES)


# ─── Pre-flight: verify delim is globally unique ──────────────────────────
def preflight_delim_uniqueness(state_files: list[Path]) -> int:
    """Scan every PU across every state file. Abort if any delim is claimed
    by more than one state, since pu_code is the bare delim and a collision
    would silently overwrite rows."""
    claimants: dict[str, set[str]] = defaultdict(set)
    unknown_states: list[str] = []
    total = 0

    for path in state_files:
        with path.open() as f:
            payload = json.load(f)
        state_name = clean(payload.get("state_name", ""))
        if state_name not in STATES:
            unknown_states.append(f"{path.name}: {state_name!r}")
            continue
        for lga in payload.get("lgas", []):
            for ward in lga.get("wards", []):
                for pu in ward.get("polling_units", []):
                    delim = clean(pu.get("delim", ""))
                    if not parse_delim(delim):
                        continue
                    claimants[delim].add(state_name)
                    total += 1

    if unknown_states:
        print(
            "Unknown state names (add to STATES map in this loader):\n  "
            + "\n  ".join(unknown_states),
            file=sys.stderr,
        )
        return 1

    collisions = {d: sorted(s) for d, s in claimants.items() if len(s) > 1}
    if collisions:
        print(
            f"\nDelim collisions across states ({len(collisions)} of {total} PUs):",
            file=sys.stderr,
        )
        for delim, states in list(collisions.items())[:10]:
            print(f"  {delim} claimed by {states}", file=sys.stderr)
        if len(collisions) > 10:
            print(f"  ... and {len(collisions) - 10} more", file=sys.stderr)
        print(
            "\nABORTING: bare delim is not safe as pu_code. Change pu_code"
            " derivation to include state_code prefix.",
            file=sys.stderr,
        )
        return 2

    print(f"Pre-flight OK: {total} PUs, {len(claimants)} unique delims, no collisions.")
    return 0


# ─── Upserts ──────────────────────────────────────────────────────────────
def upsert_state(cur, code: str, name: str, zone: str) -> None:
    cur.execute(
        "INSERT INTO states (code, name, zone) VALUES (%s, %s, %s) "
        "ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, zone = EXCLUDED.zone",
        (code, name, zone),
    )


def upsert_lga(cur, code: str, name: str, state_code: str) -> None:
    cur.execute(
        "INSERT INTO lgas (code, name, state_code) VALUES (%s, %s, %s) "
        "ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name",
        (code, name, state_code),
    )


def upsert_ward(cur, code: str, name: str, lga_code: str) -> None:
    cur.execute(
        "INSERT INTO wards (code, name, lga_code) VALUES (%s, %s, %s) "
        "ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name",
        (code, name, lga_code),
    )


def upsert_pu_batch(cur, rows: list[tuple]) -> None:
    """rows: (pu_code, pu_name, ward_code, lga_code, state_code)."""
    psycopg2.extras.execute_batch(
        cur,
        """
        INSERT INTO polling_units (
            pu_code, pu_name, ward_code, lga_code, state_code, source, scraped_at
        ) VALUES (%s, %s, %s, %s, %s, 'inec_scrape', NOW())
        ON CONFLICT (pu_code) DO UPDATE
          SET pu_name    = EXCLUDED.pu_name,
              ward_code  = EXCLUDED.ward_code,
              lga_code   = EXCLUDED.lga_code,
              state_code = EXCLUDED.state_code,
              scraped_at = EXCLUDED.scraped_at
        """,
        rows,
        page_size=500,
    )


# ─── Per-state load ───────────────────────────────────────────────────────
def load_state_file(cur, payload: dict) -> tuple[int, int, int, int]:
    """Returns (lgas, wards, pus, skipped_pus)."""
    state_name = clean(payload.get("state_name", ""))
    state_code, display_name, zone = STATES[state_name]
    upsert_state(cur, state_code, display_name, zone)

    lgas = wards = pus = skipped = 0

    for lga in payload.get("lgas", []):
        lga_name = title_case(lga.get("lga_name") or lga.get("lga_id") or "")
        if not lga_name:
            continue

        # Find first valid delim under this LGA to derive lga_code.
        lga_seg = None
        for ward in lga.get("wards", []):
            for pu in ward.get("polling_units", []):
                segs = parse_delim(pu.get("delim", ""))
                if segs:
                    lga_seg = segs[1]
                    break
            if lga_seg:
                break
        if not lga_seg:
            print(
                f"  skip LGA {state_code}/{lga_name}: no valid delim in any PU",
                file=sys.stderr,
            )
            continue

        lga_code = f"{state_code}-{lga_seg}"
        upsert_lga(cur, lga_code, lga_name, state_code)
        lgas += 1

        for ward in lga.get("wards", []):
            ward_name = title_case(ward.get("ward_name") or ward.get("ward_id") or "")
            if not ward_name:
                continue

            ward_seg = None
            for pu in ward.get("polling_units", []):
                segs = parse_delim(pu.get("delim", ""))
                if segs:
                    ward_seg = segs[2]
                    break
            if not ward_seg:
                print(
                    f"  skip ward {lga_code}/{ward_name}: no valid delim",
                    file=sys.stderr,
                )
                continue

            ward_code = f"{lga_code}-{ward_seg}"
            upsert_ward(cur, ward_code, ward_name, lga_code)
            wards += 1

            batch: list[tuple] = []
            for pu in ward.get("polling_units", []):
                segs = parse_delim(pu.get("delim", ""))
                if not segs:
                    skipped += 1
                    continue
                pu_code = "-".join(segs)
                pu_name = clean(pu.get("pu_name", "")) or pu_code
                batch.append((pu_code, pu_name, ward_code, lga_code, state_code))

            if batch:
                upsert_pu_batch(cur, batch)
                pus += len(batch)

    return lgas, wards, pus, skipped


def main(results_dir: str) -> int:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL not set", file=sys.stderr)
        return 2

    root = Path(results_dir)
    if not root.is_dir():
        print(f"results dir not found: {root}", file=sys.stderr)
        return 2

    files = state_file_paths(root)
    if not files:
        print(f"no state JSON files in {root}", file=sys.stderr)
        return 2
    if len(files) != len(STATES):
        print(
            f"warning: expected {len(STATES)} state files, found {len(files)}",
            file=sys.stderr,
        )

    rc = preflight_delim_uniqueness(files)
    if rc != 0:
        return rc

    conn = psycopg2.connect(url)
    conn.autocommit = False
    cur = conn.cursor()

    totals = {"lgas": 0, "wards": 0, "pus": 0, "skipped": 0}
    try:
        for path in files:
            with path.open() as f:
                payload = json.load(f)
            lc, wc, pc, sk = load_state_file(cur, payload)
            conn.commit()
            totals["lgas"] += lc
            totals["wards"] += wc
            totals["pus"] += pc
            totals["skipped"] += sk
            note = f" ({sk} skipped)" if sk else ""
            print(f"  {path.name}: {lc} LGAs, {wc} wards, {pc} PUs{note}")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()

    skipped_note = (
        f"; {totals['skipped']} PUs skipped (malformed delim)"
        if totals["skipped"] else ""
    )
    print(
        f"\nDone: {totals['lgas']} LGAs, {totals['wards']} wards, "
        f"{totals['pus']} polling units{skipped_note}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "Polling-Units/results"))
