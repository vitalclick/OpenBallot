#!/usr/bin/env python3
"""Extract the 2023 General Election *official* results from the INEC report PDF.

Source: ``documents/2023-GENERAL-ELECTION-REPORT.pdf`` — *Report of the 2023
General Election*, Independent National Electoral Commission (INEC), Feb 2024
(526 pages). The same document the polling-unit scrape is reconciled against
(see ``Polling-Units/reconciliation/RECONCILIATION-2023.md``).

What this script extracts and what it deliberately does NOT
-----------------------------------------------------------
The report carries results at three different grains. This extractor pulls
every machine-readable one and writes reviewable data files; nothing is
invented.

  * Presidential — national totals for all 18 candidates + a turnout summary.
    These live in Annexure 2 (printed p418) as an INFOGRAPHIC IMAGE, not text,
    so they are transcribed by hand into ``PRESIDENTIAL_NATIONAL`` below and
    checksummed (votes for the four front-runners are widely published). There
    is NO per-state presidential breakdown anywhere in the report.

  * Declared winners — the WINNING PARTY of every constituency for the four
    other races, parsed from the annexure tables:
        Annexure 3  Governorship          28 states   (PDF p458)
        Annexure 4  Senate               109 districts (PDF p459-462)
        Annexure 5  House of Reps        360 consts.   (PDF p463-479)
        Annexure 6  State Assembly       993 consts.   (PDF p480-523)
    The tables give the party only (Annex 3-5) plus the elected candidate
    name (Annex 6). They do NOT contain per-candidate vote tallies.

  * Registration — registered voters per state by gender, Table 8.9 (PDF p153).

Per-polling-unit results are NOT in this document (they live in INEC IReV);
this extractor cannot and does not produce them.

Usage::

    python scripts/extract_2023_results.py \
        --pdf documents/2023-GENERAL-ELECTION-REPORT.pdf \
        --out data/election-results-2023

Requires the ``pdftotext`` binary (poppler-utils) on PATH. No Python deps.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
import sys
from pathlib import Path

# ─────────────────────────────────────────────────────────────────────────────
# State code maps
#
# INEC embeds a 2-3 letter state suffix in every constituency code
# (e.g. SD/004/AD, FC/109/EK, SC/993/ZF). That suffix is the authoritative
# state key in the annexures. We map it to the platform's own state_code
# (the 2-letter postal abbreviation used in db/migrations/0001 and
# scripts/load_polling_units.py), which differs for several states
# (INEC "BN" Benue vs DB "BE", INEC "DT" Delta vs DB "DE", etc.).
# ─────────────────────────────────────────────────────────────────────────────

# INEC annexure suffix -> (display name, platform state_code)
INEC_SUFFIX = {
    "AB": ("Abia", "AB"),        "AD": ("Adamawa", "AD"),
    "AK": ("Akwa Ibom", "AK"),   "AN": ("Anambra", "AN"),
    "BA": ("Bauchi", "BA"),      "BY": ("Bayelsa", "BY"),
    "BN": ("Benue", "BE"),       "BO": ("Borno", "BO"),
    "CR": ("Cross River", "CR"), "DT": ("Delta", "DE"),
    "EB": ("Ebonyi", "EB"),      "ED": ("Edo", "ED"),
    "EK": ("Ekiti", "EK"),       "EN": ("Enugu", "EN"),
    "FCT": ("FCT", "FC"),        "GM": ("Gombe", "GO"),
    "IM": ("Imo", "IM"),         "JG": ("Jigawa", "JI"),
    "KD": ("Kaduna", "KD"),      "KN": ("Kano", "KN"),
    "KT": ("Katsina", "KT"),     "KB": ("Kebbi", "KE"),
    "KG": ("Kogi", "KO"),        "KW": ("Kwara", "KW"),
    "LA": ("Lagos", "LA"),       "NW": ("Nasarawa", "NA"),
    "NG": ("Niger", "NI"),       "OG": ("Ogun", "OG"),
    "OD": ("Ondo", "ON"),        "OS": ("Osun", "OS"),
    "OY": ("Oyo", "OY"),         "PL": ("Plateau", "PL"),
    "RV": ("Rivers", "RI"),      "SO": ("Sokoto", "SO"),
    "TR": ("Taraba", "TA"),      "YB": ("Yobe", "YO"),
    "ZF": ("Zamfara", "ZA"),
}

# Gov annexure uses bare 2-letter codes in its own Code column (not SD/FC/SC
# form). Those are the same INEC suffixes, so INEC_SUFFIX covers them too.

# ─────────────────────────────────────────────────────────────────────────────
# Presidential national result — Annexure 2 (printed p418), an infographic
# image transcribed by hand. votes verified to sum to the report's stated
# total valid votes (24,025,940).
# ─────────────────────────────────────────────────────────────────────────────

PRESIDENTIAL_NATIONAL = {
    "election_id": "2023-presidential",
    "source": "Annexure 2 (printed p418) infographic, transcribed",
    "candidates": [
        # party, candidate, votes, elected
        ("A",    "Imumolen Irene Christopher",      61014,   False),
        ("AA",   "Almustapha Hamza",                14542,   False),
        ("AAC",  "Sowore Omoyele Stephen",          14608,   False),
        ("ADC",  "Kachikwu Dumebi",                 81919,   False),
        ("ADP",  "Sani Yabagi Yusuf",               43924,   False),
        ("APC",  "Tinubu Bola Ahmed",               8794726, True),
        ("APGA", "Umeadi Peter Nnanna Chukwudi",    61966,   False),
        ("APM",  "Ojei Princess Chichi",            25961,   False),
        ("APP",  "Nnadi Charles Osita",             12839,   False),
        ("BP",   "Adenuga Sunday Oluwafemi",        16156,   False),
        ("LP",   "Obi Peter Gregory",               6101533, False),
        ("NNPP", "Musa Mohammed Rabiu Kwankwaso",   1496687, False),
        ("NRM",  "Osakwe Felix Johnson",            24869,   False),
        ("PDP",  "Abubakar Atiku",                  6984520, False),
        ("PRP",  "Abiola Latifu Kolawole",          72144,   False),
        ("SDP",  "Adebayo Adewole Ebenezer",        80267,   False),
        ("YPP",  "Ado-Ibrahim Abdulmalik",          60600,   False),
        ("ZLP",  "Nwanyanwu Daniel Daberechukwu",   77665,   False),
    ],
    "summary": {
        "registered_voters": 93469008,
        "collected_pvcs":    87209007,
        "accredited_voters": 25286616,
        "votes_cast":        24965218,
        "valid_votes":       24025940,
        "rejected_votes":    939278,
        "turnout_pct":       27.05,
    },
}

# Annexure page ranges (1-based PDF page numbers, inclusive).
PAGES = {
    "governorship": (458, 458),
    "senate":       (459, 462),
    "reps":         (463, 479),
    "stha":         (480, 523),
}
RACE_ELECTION_ID = {
    "governorship": "2023-governorship",
    "senate":       "2023-senate",
    "reps":         "2023-reps",
    "stha":         "2023-stha",
}
EXPECTED_ROWS = {"governorship": 28, "senate": 109, "reps": 360, "stha": 993}

REG_TABLE_PAGES = (153, 154)  # Table 8.9 — registered voters by state/gender

_INT = lambda s: int(s.replace(",", "").strip())  # noqa: E731


def pdftotext(pdf: Path, first: int, last: int) -> str:
    out = subprocess.run(
        ["pdftotext", "-f", str(first), "-l", str(last), "-layout", str(pdf), "-"],
        capture_output=True, text=True, check=True,
    )
    return out.stdout


def state_for_suffix(suffix: str) -> tuple[str, str]:
    if suffix not in INEC_SUFFIX:
        raise KeyError(f"unknown INEC state suffix {suffix!r}")
    return INEC_SUFFIX[suffix]


# ─── Governorship (Annexure 3) ───────────────────────────────────────────────
# Row: "1  Abia  Governor  AB  17  184  4,062  LP"
GOV_RE = re.compile(
    r"^\s*\d+\s+(?P<state>.+?)\s+Governor\s+(?P<code>[A-Z]{2,3})\s+"
    r"(?P<lgas>\d+)\s+(?P<ras>[\d,]+)\s+(?P<pus>[\d,]+)\s+(?P<party>[A-Z]{1,5})\s*$"
)


def parse_governorship(text: str) -> list[dict]:
    rows = []
    for line in text.splitlines():
        m = GOV_RE.match(line)
        if not m:
            continue
        name, code = state_for_suffix(m["code"])
        rows.append({
            "race": "governorship",
            "election_id": RACE_ELECTION_ID["governorship"],
            "constituency_code": f"GOV/{m['code']}",
            "constituency_name": f"{name} Governor",
            "state_code": code,
            "state_name": name,
            "n_lgas": _INT(m["lgas"]),
            "n_ras": _INT(m["ras"]),
            "n_pus": _INT(m["pus"]),
            "party_code": m["party"],
            "candidate_name": "",
        })
    return rows


# The 18 parties INEC registered for 2023 — the complete set any winner can
# belong to. Sourced from the presidential slate (Annexure 2), which lists all
# 18. Used to detect the party column robustly across OCR noise (blank LGA
# columns, parties wrapped to the next line, misspelled/absent "Elected"
# remarks like "Electec"/"Elelcted"/"Court").
VALID_PARTIES = frozenset(p for p, *_ in PRESIDENTIAL_NATIONAL["candidates"])


def _strip_head(line: str, upto: int, name: str) -> str:
    """Constituency name = text before the code, minus the leading S/N number,
    a trailing "(8)" seat count, and any state-name words bleeding in from the
    grouping column."""
    head = re.sub(r"\(\d+\)\s*$", "", line[:upto]).strip()  # drop "(8)" seat count
    # The leading columns (state name, seat-count, S/N) can appear in any order
    # depending on the row; strip them repeatedly until only the name remains.
    words = name.split()
    changed = True
    while changed:
        changed = False
        new = re.sub(r"^\d+\s+", "", head)            # leading S/N or seat count
        if new != head:
            head, changed = new, True
        for word in words:
            new = re.sub(rf"^{re.escape(word)}\s+", "", head)
            if new != head:
                head, changed = new, True
    return head.strip()


# Unambiguous OCR repairs for the party column: no registered party is named
# "PC", and the only constituency where it appears reads "...448 PC" where APC
# is the obvious intended value. Applied only as a fallback when no clean party
# token is found, so it can never override a correctly-read row.
OCR_PARTY_FIX = {"PC": "APC"}


def _party_in(tokens: list[str]) -> str | None:
    """Rightmost token that is a registered party code (with OCR fallback)."""
    for tok in reversed(tokens):
        if tok in VALID_PARTIES:
            return tok
    for tok in reversed(tokens):
        if tok in OCR_PARTY_FIX:
            return OCR_PARTY_FIX[tok]
    return None


def _normalise_codes(line: str, prefix: str) -> str:
    """Repair OCR damage to constituency codes so the regex can find them:
    a stray leading slash ("/SC/20AB") and a dropped separator slash
    ("SC/076GM" -> "SC/076/GM"). The numeric/state parts are left untouched;
    genuine source typos in the printed number (e.g. row 251 labelled
    SC/252/DT) are NOT silently "fixed" — rows are keyed by a per-race
    sequence instead (see assign in main)."""
    line = line.replace(f"/{prefix}/", f"{prefix}/")
    return re.sub(rf"{prefix}/(\d+)([A-Z]{{2,3}})\b", rf"{prefix}/\1/\2", line)


# ─── Senate (Annex 4) and Reps (Annex 5): same shape ─────────────────────────
# "...North East   SD/007/AK   9   94   1,571 PDP"   (LGAs RAs PUs Party)
# Some rows omit the LGA count, and some wrap the party onto the next line.
def parse_legislative(text: str, race: str, prefix: str) -> list[dict]:
    code_rx = re.compile(rf"(?P<code>{prefix}/\d+/[A-Z]{{2,3}})")
    lines = [_normalise_codes(ln, prefix) for ln in text.splitlines()]
    rows = []
    for i, line in enumerate(lines):
        m = code_rx.search(line)
        if not m:
            continue
        suffix = m["code"].split("/")[-1]
        if suffix not in INEC_SUFFIX:
            continue
        name, code = state_for_suffix(suffix)
        rest = line[m.end():].split()
        party = _party_in(rest)
        nums = [t for t in rest if re.fullmatch(r"[\d,]+", t)]
        if party is None:  # party wrapped to the next non-empty line
            for j in range(i + 1, min(i + 3, len(lines))):
                nxt = lines[j].strip()
                if not nxt:
                    continue
                if code_rx.search(nxt):
                    break  # next data row — don't steal its party
                party = _party_in(nxt.split())
                break
        # counts: only trust them when all three columns are present
        lgas, ras, pus = "", "", ""
        if len(nums) >= 3:
            lgas, ras, pus = _INT(nums[0]), _INT(nums[1]), _INT(nums[2])
        elif nums:
            pus = _INT(nums[-1])
        rows.append({
            "race": race,
            "election_id": RACE_ELECTION_ID[race],
            "constituency_code": m["code"],
            "constituency_name": _strip_head(line, m.start(), name),
            "state_code": code,
            "state_name": name,
            "n_lgas": lgas,
            "n_ras": ras,
            "n_pus": pus,
            "party_code": party or "",
            "candidate_name": "",
        })
    return rows


# ─── State Assembly (Annexure 6) ─────────────────────────────────────────────
# "1  Aba North  SC/01/AB  Nwagwu Destiny Akarka  LP  M  Elected"
# Columns: Code  Candidate  Party  Gender  Remarks. Remarks are OCR-noisy
# ("Electec", "Elelcted", "Court") or absent, so we anchor on the party set,
# not the word "Elected".
def parse_stha(text: str) -> list[dict]:
    code_rx = re.compile(r"(SC/\d+/[A-Z]{2,3})")
    lines = [_normalise_codes(ln, "SC") for ln in text.splitlines()]
    rows = []
    for i, line in enumerate(lines):
        m = code_rx.search(line)
        if not m:
            continue
        suffix = m.group(1).split("/")[-1]
        if suffix not in INEC_SUFFIX:
            continue
        name, code = state_for_suffix(suffix)
        rest = line[m.end():].split()
        party = _party_in(rest)
        if party is not None:
            cand = " ".join(rest[: rest.index(party)])
        else:  # party absent or wrapped to next line
            cand = " ".join(t for t in rest if t not in ("M", "F"))
            cand = re.sub(r"\s+(Elect\w*|Court|Tribunal).*$", "", cand).strip()
            for j in range(i + 1, min(i + 3, len(lines))):
                nxt = lines[j].strip()
                if not nxt:
                    continue
                if code_rx.search(nxt):
                    break
                first = nxt.split()[0]
                if first in VALID_PARTIES:
                    party = first
                break
        rows.append({
            "race": "stha",
            "election_id": RACE_ELECTION_ID["stha"],
            "constituency_code": m.group(1),
            "constituency_name": _strip_head(line, m.start(), name),
            "state_code": code,
            "state_name": name,
            "n_lgas": "",
            "n_ras": "",
            "n_pus": "",
            "party_code": party or "",
            "candidate_name": cand.strip(),
        })
    return rows


# ─── Registration (Table 8.9) ────────────────────────────────────────────────
# "1   Abia   1,063,424   1,057,384   2,120,808   50.14   49.86"
REG_RE = re.compile(
    r"^\s*\d+\s+(?P<state>[A-Za-z' ]+?)\s+(?P<male>[\d,]+)\s+(?P<female>[\d,]+)\s+"
    r"(?P<total>[\d,]+)\s+\d+\.\d+\s+\d+\.\d+\s*$"
)
# state-name (upper-keyed) -> platform code, reusing the suffix map's names
_NAME_TO_CODE = {name.upper(): code for name, code in INEC_SUFFIX.values()}


def parse_registration(text: str) -> list[dict]:
    rows = []
    for line in text.splitlines():
        m = REG_RE.match(line)
        if not m:
            continue
        name = m["state"].strip()
        code = _NAME_TO_CODE.get(name.upper())
        if not code:
            continue
        rows.append({
            "state_code": code,
            "state_name": name,
            "male": _INT(m["male"]),
            "female": _INT(m["female"]),
            "total": _INT(m["total"]),
        })
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pdf", default="documents/2023-GENERAL-ELECTION-REPORT.pdf")
    ap.add_argument("--out", default="data/election-results-2023")
    args = ap.parse_args()

    pdf = Path(args.pdf)
    out = Path(args.out)
    if not pdf.exists():
        print(f"ERROR: PDF not found at {pdf} (it lives on the main branch under "
              "documents/). Check it out first.", file=sys.stderr)
        return 2
    out.mkdir(parents=True, exist_ok=True)

    # ── Declared winners ──
    winners: list[dict] = []
    winners += parse_governorship(pdftotext(pdf, *PAGES["governorship"]))
    winners += parse_legislative(pdftotext(pdf, *PAGES["senate"]), "senate", "SD")
    winners += parse_legislative(pdftotext(pdf, *PAGES["reps"]), "reps", "FC")
    winners += parse_stha(pdftotext(pdf, *PAGES["stha"]))

    # group by race, assign a stable per-race sequence (rows are emitted in
    # printed order), and validate the row counts.
    by_race: dict[str, list[dict]] = {}
    for w in winners:
        by_race.setdefault(w["race"], []).append(w)

    problems, warnings = [], []
    for race, exp in EXPECTED_ROWS.items():
        got = len(by_race.get(race, []))
        if got != exp:
            problems.append(f"{race}: expected {exp} rows, parsed {got}")
    if problems:
        print("EXTRACTION VALIDATION FAILED:", file=sys.stderr)
        for p in problems:
            print("  -", p, file=sys.stderr)
        return 1

    for race, rws in by_race.items():
        for seq, w in enumerate(rws, start=1):
            w["seq"] = seq
        codes = [w["constituency_code"] for w in rws]
        dups = {c for c in codes if codes.count(c) > 1}
        if dups:
            warnings.append(f"{race}: source-typo duplicate code(s) {sorted(dups)} "
                            "(rows kept, keyed by seq)")
        blanks = [w["seq"] for w in rws if not w["party_code"]]
        if blanks:
            warnings.append(f"{race}: party not printed in source for seq {blanks}")

    win_csv = out / "declared_winners.csv"
    with win_csv.open("w", newline="") as fh:
        cols = ["race", "election_id", "seq", "constituency_code",
                "constituency_name", "state_code", "state_name",
                "n_lgas", "n_ras", "n_pus", "party_code", "candidate_name"]
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for race in ("governorship", "senate", "reps", "stha"):
            w.writerows(by_race.get(race, []))

    # ── Presidential national ──
    pres = {
        "election_id": PRESIDENTIAL_NATIONAL["election_id"],
        "source": PRESIDENTIAL_NATIONAL["source"],
        "summary": PRESIDENTIAL_NATIONAL["summary"],
        "candidates": [
            {"party_code": p, "candidate_name": c, "votes": v, "elected": e,
             "display_order": i + 1}
            for i, (p, c, v, e) in enumerate(
                sorted(PRESIDENTIAL_NATIONAL["candidates"],
                       key=lambda r: -r[2]))
        ],
    }
    vote_sum = sum(c["votes"] for c in pres["candidates"])
    if vote_sum != pres["summary"]["valid_votes"]:
        print(f"WARNING: presidential votes sum {vote_sum:,} != stated valid "
              f"votes {pres['summary']['valid_votes']:,}", file=sys.stderr)
    (out / "presidential_national.json").write_text(
        json.dumps(pres, indent=2) + "\n")

    # ── Registration ──
    reg = parse_registration(pdftotext(pdf, *REG_TABLE_PAGES))
    if len(reg) != 37:
        print(f"WARNING: registration table parsed {len(reg)} states (expected 37)",
              file=sys.stderr)
    reg.sort(key=lambda r: r["state_code"])
    with (out / "state_registration.csv").open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["state_code", "state_name", "male",
                                           "female", "total"])
        w.writeheader()
        w.writerows(reg)

    # ── Report ──
    seats = {r: len(by_race[r]) for r in by_race}
    print("Extraction OK")
    print(f"  presidential : {len(pres['candidates'])} candidates, "
          f"valid-vote checksum {'OK' if vote_sum == pres['summary']['valid_votes'] else 'MISMATCH'}")
    print(f"  governorship : {seats.get('governorship', 0)} states")
    print(f"  senate       : {seats.get('senate', 0)} districts")
    print(f"  reps         : {seats.get('reps', 0)} constituencies")
    print(f"  stha         : {seats.get('stha', 0)} constituencies")
    print(f"  registration : {len(reg)} states")
    for warn in warnings:
        print(f"  note: {warn}")
    print(f"  -> {win_csv}")
    print(f"  -> {out / 'presidential_national.json'}")
    print(f"  -> {out / 'state_registration.csv'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
