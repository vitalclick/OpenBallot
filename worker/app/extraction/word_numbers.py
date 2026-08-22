"""Figures-vs-words reconciliation for EC8A vote counts (issue #68).

Form EC8A records every party's votes **twice**: once in figures, once in
words. That redundancy is not decoration -- it exists so a tampered or
misread digit can be caught against its written form. Until now the platform
read the figures column and ignored the words entirely, which threw away a
free second channel on an image we had already paid to process.

What this buys, concretely: if OCR reads ``183`` as ``783``, the arithmetic
check either fails (and we cannot tell which field caused it) or, worse,
happens to stay consistent and we publish the wrong number with high
confidence. Agreement with the written form localises the doubt to one party's
figure instead of condemning the whole extraction.

Method, following the CCIJ 2023 pipeline:

  1. A **closed vocabulary** of number words. Closed is the point -- a general
     English dictionary would happily "correct" ``sixty`` into something else.
  2. **Fuzzy correction** of each OCR'd word against that vocabulary, plus
     segmentation for words OCR ran together (``onehundredtwo``).
  3. **Word-to-integer** conversion, handling both the spoken form
     (``one hundred twenty three`` -> 123) and the digit-dictation form
     (``one two three`` -> 123) that appears on hand-filled forms.
  4. **Digit candidates** from the figures field, applying the OCR confusions
     that actually occur on these scans, and treating a split reading
     (``1 23``) as candidates 1, 23 and 123.
  5. **Agreement**: accept the value the two channels agree on.

No third-party dependency. CCIJ used num2words + symspellpy + pyspellchecker;
generating a closed 0-1000 vocabulary and doing bounded edit-distance over it
is a few dozen lines, and the worker is an election-critical service where
every added dependency is a supply-chain question. The behaviour is pinned by
tests instead.
"""

from __future__ import annotations

from dataclasses import dataclass

# ─── Number words ─────────────────────────────────────────────────────────

UNITS = (
    "zero", "one", "two", "three", "four",
    "five", "six", "seven", "eight", "nine",
)
TEENS = (
    "ten", "eleven", "twelve", "thirteen", "fourteen",
    "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
)
TENS = (
    "twenty", "thirty", "forty", "fifty",
    "sixty", "seventy", "eighty", "ninety",
)

# Handwritten forms for "no votes". Both spellings appear on real EC8As.
ZERO_WORDS = frozenset({"nil", "nill", "none", "zero"})

WORD_VALUE: dict[str, int] = {}
for _i, _w in enumerate(UNITS):
    WORD_VALUE[_w] = _i
for _i, _w in enumerate(TEENS):
    WORD_VALUE[_w] = 10 + _i
for _i, _w in enumerate(TENS):
    WORD_VALUE[_w] = 10 * (_i + 2)
WORD_VALUE["hundred"] = 100
WORD_VALUE["thousand"] = 1000

# The closed vocabulary. Everything the corrector is allowed to produce.
VOCABULARY: frozenset[str] = frozenset(WORD_VALUE) | ZERO_WORDS | {"and"}


# ─── Fuzzy correction ─────────────────────────────────────────────────────


def _edit_distance(a: str, b: str, cap: int) -> int:
    """Levenshtein distance, abandoned once it provably exceeds ``cap``.

    The cap matters: without it a long OCR smear could be "corrected" into a
    short number word on the strength of nothing.
    """
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i]
        for j, cb in enumerate(b, start=1):
            current.append(
                min(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + (ca != cb),
                )
            )
        if min(current) > cap:
            return cap + 1
        previous = current
    return previous[-1]


def correct_word(word: str, max_distance: int = 2) -> str | None:
    """Snap one OCR'd token to the closest number word, or None.

    Returns None rather than a guess when nothing is close enough. A wrong
    correction here becomes a wrong vote count, so silence is the safer
    failure.
    """
    token = "".join(ch for ch in word.lower() if ch.isalpha())
    if not token:
        return None
    if token in VOCABULARY:
        return token

    # Distance scales down for short words: "six" and "ten" are two edits
    # apart, so an unbounded 2 would make them interchangeable.
    cap = min(max_distance, max(1, len(token) // 3))

    best: str | None = None
    best_distance = cap + 1
    for candidate in VOCABULARY:
        d = _edit_distance(token, candidate, cap)
        if d < best_distance:
            best, best_distance = candidate, d
        elif d == best_distance and best is not None and candidate != best:
            # Ambiguous between two vocabulary words - refuse rather than
            # pick by iteration order, which is not a reason.
            best = None
    return best


def segment_words(text: str) -> list[str]:
    """Split a run-together string into number words: ``onehundredtwo``.

    Greedy longest-match from the left. Returns [] when the string cannot be
    fully consumed, so a partial parse never becomes a partial number.
    """
    token = "".join(ch for ch in text.lower() if ch.isalpha())
    if not token:
        return []

    by_length = sorted(VOCABULARY, key=len, reverse=True)
    out: list[str] = []
    i = 0
    while i < len(token):
        for candidate in by_length:
            if token.startswith(candidate, i):
                out.append(candidate)
                i += len(candidate)
                break
        else:
            return []
    return out


def normalise_words(text: str) -> list[str]:
    """Clean an OCR'd words field into vocabulary tokens.

    Tries per-word correction first (the common case, where OCR kept the
    spaces), then whole-string segmentation (where it did not).
    """
    if not text:
        return []

    raw = text.replace("-", " ").split()
    corrected = [c for c in (correct_word(w) for w in raw) if c]

    # Per-word correction lost tokens -> the spacing itself may be wrong.
    if len(corrected) < len(raw):
        segmented = segment_words(text)
        if segmented:
            return [w for w in segmented if w != "and"]

    return [w for w in corrected if w != "and"]


# ─── Words to integer ─────────────────────────────────────────────────────


def words_to_int(text: str) -> int | None:
    """Convert an OCR'd words field to an integer, or None.

    Handles the two forms that appear on hand-filled EC8As:

      * spoken     -- "one hundred twenty three"  -> 123
      * dictated   -- "one two three"             -> 123

    The dictated form is why this cannot simply be a standard word-to-number
    routine: a polling officer writing digits out one at a time is common, and
    reading it as 1 + 2 + 3 would be badly wrong.
    """
    words = normalise_words(text)
    if not words:
        return None

    if all(w in ZERO_WORDS for w in words):
        return 0

    # Dictated digits: every token is a single digit word, and there are at
    # least two of them ("one" alone is just 1).
    if len(words) >= 2 and all(w in UNITS for w in words):
        return int("".join(str(WORD_VALUE[w]) for w in words))

    total = 0
    current = 0
    seen_value = False
    for w in words:
        if w in ZERO_WORDS and w != "zero":
            continue
        if w not in WORD_VALUE:
            return None
        value = WORD_VALUE[w]
        seen_value = True
        if value == 100:
            current = (current or 1) * 100
        elif value == 1000:
            total += (current or 1) * 1000
            current = 0
        else:
            current += value

    return total + current if seen_value else None


# ─── Figures to integer candidates ────────────────────────────────────────

# OCR confusions that actually occur on these scans. Applied only when the
# raw text does not already parse as a number, so a clean "0" is never
# rewritten.
DIGIT_CONFUSIONS = {
    "I": "1", "l": "1", "|": "1", "/": "1", "\\": "1",
    "O": "0", "o": "0", "Q": "0", "D": "0",
    "S": "5", "s": "5",
    "Z": "2", "z": "2",
    "B": "8", "&": "8",
    "G": "6",
}


def figure_candidates(text: str) -> list[int]:
    """Plausible readings of the figures field, best first.

    A split reading is real: OCR frequently sees ``1 23`` where the form says
    ``123``, so the concatenation is offered alongside the parts. The words
    column then decides between them -- which is the entire point of having
    two channels.
    """
    if not text:
        return []

    substituted = "".join(DIGIT_CONFUSIONS.get(ch, ch) for ch in text)

    runs: list[str] = []
    current = ""
    for ch in substituted:
        if ch.isdigit():
            current += ch
        else:
            if current:
                runs.append(current)
            current = ""
    if current:
        runs.append(current)

    if not runs:
        return []

    candidates: list[int] = []
    joined = int("".join(runs))
    if len(runs) > 1:
        candidates.append(joined)          # "1 23" -> 123
    for run in runs:
        value = int(run)
        if value not in candidates:
            candidates.append(value)
    return candidates


# ─── Agreement ────────────────────────────────────────────────────────────


def numbers_match(a: int, b: int) -> bool:
    """Are two readings close enough to be the same number?

    Three tolerances, each earning its place on real scans:

      * exact
      * within 2 -- a single misread digit in the units place
      * differing by a whole multiple of 100 -- a dropped or added hundreds
        digit, the most common OCR failure on these forms

    The 100 rule is the loosest and deliberately so: it accepts 183 vs 283.
    That is safe only because it is used to *choose between* candidate
    readings of the same cell, never to accept a lone reading.
    """
    if a == b:
        return True
    if abs(a - b) <= 2:
        return True
    return abs(a - b) % 100 == 0


@dataclass(frozen=True)
class Reconciled:
    """One cell, read twice."""

    value: int | None          # agreed reading, None when they disagree
    figures: int | None        # best reading of the figures column
    words: int | None          # reading of the words column
    agreed: bool
    confidence: float          # 0-1, feeds per_field_confidence

    @property
    def needs_review(self) -> bool:
        return not self.agreed


def reconcile_cell(
    figures_text: str | None,
    words_text: str | None,
) -> Reconciled:
    """Reconcile one party's figure against its written form.

    Confidence, and why:

      0.99  both channels read and agree
      0.60  only one channel is legible -- usable, unverified
      0.20  both legible and they disagree; this is the case that most needs
            a human, so it must sink below any sane confidence floor
    """
    candidates = figure_candidates(figures_text or "")
    words_value = words_to_int(words_text or "")

    if words_value is None:
        best = candidates[0] if candidates else None
        return Reconciled(
            value=best,
            figures=best,
            words=None,
            agreed=False,
            confidence=0.60 if best is not None else 0.0,
        )

    if not candidates:
        return Reconciled(
            value=words_value,
            figures=None,
            words=words_value,
            agreed=False,
            confidence=0.60,
        )

    for candidate in candidates:
        if numbers_match(words_value, candidate):
            return Reconciled(
                value=candidate,
                figures=candidate,
                words=words_value,
                agreed=True,
                confidence=0.99,
            )

    # Both legible, neither agrees. Prefer the figures -- the words column is
    # more often left blank or scrawled -- but say plainly that this is
    # unresolved rather than quietly picking a winner at full confidence.
    return Reconciled(
        value=candidates[0],
        figures=candidates[0],
        words=words_value,
        agreed=False,
        confidence=0.20,
    )


def reconcile_votes(
    figures: dict[str, int | str | None],
    words: dict[str, str | None] | None,
) -> tuple[dict[str, int], dict[str, Reconciled], float]:
    """Reconcile a whole candidate-votes map.

    Returns (values, per-party detail, overall confidence). Overall confidence
    is the **minimum** across parties, not the mean: one unresolved party is
    enough to make the form worth a second look, and averaging would let five
    clean rows bury it.
    """
    words = words or {}
    values: dict[str, int] = {}
    detail: dict[str, Reconciled] = {}

    for party, figure in figures.items():
        result = reconcile_cell(
            None if figure is None else str(figure),
            words.get(party),
        )
        detail[party] = result
        values[party] = result.value if result.value is not None else 0

    confidence = min((r.confidence for r in detail.values()), default=0.0)
    return values, detail, confidence
