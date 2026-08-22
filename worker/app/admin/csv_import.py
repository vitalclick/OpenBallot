"""Party-admin CSV roster import.

Expected CSV header (case-insensitive, any order):

  name, phone, pu_code, language

The parser:
  * Trims whitespace
  * Normalises phone numbers to E.164 via app.auth.phone
  * Validates pu_code is non-empty (foreign key into polling_units;
    enforced at the DB layer)
  * Validates language ∈ {en, ha, yo, ig, pcm}
  * Returns structured rows + a list of parse errors. The router
    refuses to apply ANY rows if there's a single error - we never
    half-import a roster.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass

from ..auth.phone import normalise_phone

_VALID_LANGS = {"en", "ha", "yo", "ig", "pcm"}


@dataclass
class RosterRow:
    line: int
    full_name: str
    phone_e164: str
    pu_code: str
    language: str


class RosterImportError(Exception):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors[:5]))
        self.errors = errors


def parse_roster_csv(content: str) -> list[RosterRow]:
    """Parse a CSV roster into validated RosterRow objects.

    Raises RosterImportError when any row has any problem. The error
    object carries every problem found, not just the first - operators
    can fix the whole file before re-uploading.
    """
    reader = csv.DictReader(io.StringIO(content))
    if reader.fieldnames is None:
        raise RosterImportError(["CSV is empty"])

    # Normalise header names so 'Phone' / 'PHONE' / 'phone_e164' all work.
    fieldnames = {f.lower().strip(): f for f in reader.fieldnames}
    required = {"name", "phone", "pu_code"}
    missing = required - set(fieldnames)
    if missing:
        raise RosterImportError([f"missing required column(s): {sorted(missing)}"])

    rows: list[RosterRow] = []
    errors: list[str] = []
    seen_phones: set[str] = set()

    for line_no, raw in enumerate(reader, start=2):
        name = (raw.get(fieldnames["name"]) or "").strip()
        phone = (raw.get(fieldnames["phone"]) or "").strip()
        pu_code = (raw.get(fieldnames["pu_code"]) or "").strip()
        language = (
            (raw.get(fieldnames.get("language", "language")) or "en").strip().lower()
        )

        if not name:
            errors.append(f"line {line_no}: name is empty")
            continue
        if not pu_code:
            errors.append(f"line {line_no}: pu_code is empty")
            continue
        if language and language not in _VALID_LANGS:
            errors.append(
                f"line {line_no}: language '{language}' is not one of {sorted(_VALID_LANGS)}"
            )
            continue

        try:
            normalised = normalise_phone(phone)
        except ValueError as e:
            errors.append(f"line {line_no}: phone '{phone}' is invalid ({e})")
            continue

        if normalised in seen_phones:
            errors.append(f"line {line_no}: phone {normalised} is duplicated within this file")
            continue
        seen_phones.add(normalised)

        rows.append(
            RosterRow(
                line=line_no,
                full_name=name,
                phone_e164=normalised,
                pu_code=pu_code,
                language=language or "en",
            )
        )

    if errors:
        raise RosterImportError(errors)
    if not rows:
        raise RosterImportError(["CSV produced zero rows"])

    return rows
