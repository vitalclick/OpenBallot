"""Phone number normalisation.

Always store E.164. The PWA UI accepts any of:
  +234 803 555 0101
  234 803 555 0101
  0803 555 0101
  08035550101

and we normalise to "+2348035550101" at the auth boundary so the DB row
has exactly one canonical form per agent.
"""

from __future__ import annotations

import phonenumbers


def normalise_phone(raw: str, default_region: str = "NG") -> str:
    """Returns +E.164. Raises ValueError when the number is unparseable
    or fails phonenumbers' is_valid_number check."""
    try:
        parsed = phonenumbers.parse(raw, default_region)
    except phonenumbers.NumberParseException as e:
        raise ValueError(f"unparseable phone: {e}")
    if not phonenumbers.is_valid_number(parsed):
        raise ValueError("invalid phone number")
    return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)
