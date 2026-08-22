#!/usr/bin/env python3
"""Score authentication detection against labelled ground truth (issue #72).

`ExtractedEC8A` carries three fields that decide whether a result sheet is
validly completed:

    presiding_officer_signed
    agent_signatures_detected
    official_stamp_present

Until now nothing measured whether we get them right. They were produced by
asking a vision model, in prose, to count signatures -- with a single shared
confidence value covering all three and no test anywhere exercising them
against a real form.

`data/pu-enrichment-2023/authentication_labels.csv` gives 22,681 polling units
labelled for exactly these elements, and crucially it is rich in negatives --
13,000 missing the black stamp, 3,955 missing the presiding officer's
signature. An evaluation set of all-positives would tell us nothing.

Why the metrics are reported per class
--------------------------------------
Accuracy alone would be actively misleading here. 83% of labelled forms carry
a presiding officer's signature, so a detector that answers "signed" every
single time scores 83% and has learned nothing -- while being exactly wrong in
the case that matters, the unsigned form. Recall on the NEGATIVE class is the
number to watch: of the forms genuinely missing an element, how many do we
catch?

Usage::

    # What the ground truth contains:
    python scripts/eval_authentication.py --labels data/pu-enrichment-2023/authentication_labels.csv

    # Score a predictions CSV against it:
    python scripts/eval_authentication.py \\
        --labels data/pu-enrichment-2023/authentication_labels.csv \\
        --predictions /tmp/predictions.csv

The predictions CSV needs a `polling_unit_code` column plus any of
`presiding_officer_signature_present`, `polling_agent_signature_present`,
`black_stamp`, as 0/1. Produce it from whichever detector you are testing --
the positional detector in `worker/app/layout/authentication.py`, or a
baseline run of the current GPT-4o prompt, so the two are comparable.
"""

from __future__ import annotations

import argparse
import csv
import sys
from dataclasses import dataclass
from pathlib import Path

FIELDS = (
    "presiding_officer_signature_present",
    "polling_agent_signature_present",
    "black_stamp",
)

# Shorter names for reporting.
FIELD_LABELS = {
    "presiding_officer_signature_present": "presiding officer signature",
    "polling_agent_signature_present": "polling agent signatures",
    "black_stamp": "official (black) stamp",
}


def parse_bool(raw: str | None) -> bool | None:
    """Parse a 0/1 (or 0.0/1.0) label. None when absent or unreadable."""
    text = (raw or "").strip()
    if not text:
        return None
    try:
        return bool(int(float(text)))
    except ValueError:
        return None


def normalise_pu_code(raw: str | None) -> str | None:
    code = (raw or "").strip().replace("/", "-")
    return code or None


def read_labels(path: Path) -> dict[str, dict[str, bool]]:
    """pu_code -> {field: present}. Fields that are unreadable are omitted."""
    out: dict[str, dict[str, bool]] = {}
    with path.open(newline="") as f:
        for row in csv.DictReader(f):
            code = normalise_pu_code(row.get("polling_unit_code"))
            if code is None:
                continue
            values = {
                field: parsed
                for field in FIELDS
                if (parsed := parse_bool(row.get(field))) is not None
            }
            if values:
                out[code] = values
    return out


@dataclass
class ConfusionMatrix:
    """Counts for one binary field."""

    true_positive: int = 0
    false_positive: int = 0
    true_negative: int = 0
    false_negative: int = 0

    @property
    def total(self) -> int:
        return (
            self.true_positive + self.false_positive
            + self.true_negative + self.false_negative
        )

    @property
    def accuracy(self) -> float:
        return (self.true_positive + self.true_negative) / self.total if self.total else 0.0

    @property
    def precision(self) -> float:
        denom = self.true_positive + self.false_positive
        return self.true_positive / denom if denom else 0.0

    @property
    def recall(self) -> float:
        denom = self.true_positive + self.false_negative
        return self.true_positive / denom if denom else 0.0

    @property
    def negative_recall(self) -> float:
        """Of the forms genuinely MISSING this element, how many we caught.

        The number that matters. A detector that always answers "present"
        scores well on accuracy and zero here, while being wrong in precisely
        the case worth detecting.
        """
        denom = self.true_negative + self.false_positive
        return self.true_negative / denom if denom else 0.0

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 2 * p * r / (p + r) if (p + r) else 0.0

    def observe(self, predicted: bool, actual: bool) -> None:
        if predicted and actual:
            self.true_positive += 1
        elif predicted and not actual:
            self.false_positive += 1
        elif not predicted and actual:
            self.false_negative += 1
        else:
            self.true_negative += 1


def score(
    labels: dict[str, dict[str, bool]],
    predictions: dict[str, dict[str, bool]],
) -> tuple[dict[str, ConfusionMatrix], int]:
    """Score predictions against labels. Returns (per-field matrices, overlap).

    Only polling units present in both are scored. A missing prediction is not
    counted as a wrong answer -- it is a gap in coverage, reported separately,
    and silently scoring it as "absent" would flatter or punish a detector for
    something it never claimed.
    """
    matrices = {field: ConfusionMatrix() for field in FIELDS}
    overlap = 0

    for code, actual_fields in labels.items():
        predicted_fields = predictions.get(code)
        if predicted_fields is None:
            continue
        overlap += 1
        for field, actual in actual_fields.items():
            predicted = predicted_fields.get(field)
            if predicted is None:
                continue
            matrices[field].observe(predicted, actual)

    return matrices, overlap


def describe_labels(labels: dict[str, dict[str, bool]]) -> None:
    print(f"Ground truth: {len(labels):,} polling units\n")
    print(f"  {'element':30s} {'present':>9s} {'absent':>9s} {'absent %':>9s}")
    for field in FIELDS:
        values = [v[field] for v in labels.values() if field in v]
        present = sum(values)
        absent = len(values) - present
        pct = absent / len(values) * 100 if values else 0.0
        print(f"  {FIELD_LABELS[field]:30s} {present:>9,} {absent:>9,} {pct:>8.1f}%")

    print(
        "\n  Negatives are what make this set useful. A detector that answers\n"
        "  'present' every time would score well on accuracy and catch none of\n"
        "  the forms that are actually missing an element."
    )


def report(matrices: dict[str, ConfusionMatrix], overlap: int) -> None:
    print(f"\nScored {overlap:,} polling units present in both sets\n")
    header = (
        f"  {'element':30s} {'n':>7s} {'acc':>7s} {'prec':>7s} "
        f"{'recall':>7s} {'F1':>7s} {'neg.rec':>8s}"
    )
    print(header)
    print("  " + "-" * (len(header) - 2))
    for field in FIELDS:
        m = matrices[field]
        if not m.total:
            print(f"  {FIELD_LABELS[field]:30s} {'-':>7s}  (no predictions)")
            continue
        print(
            f"  {FIELD_LABELS[field]:30s} {m.total:>7,} {m.accuracy:>7.3f} "
            f"{m.precision:>7.3f} {m.recall:>7.3f} {m.f1:>7.3f} "
            f"{m.negative_recall:>8.3f}"
        )

    print(
        "\n  neg.rec (negative recall) is the headline number: of the forms\n"
        "  genuinely missing an element, the fraction we detected. An unsigned\n"
        "  EC8A that reads as signed is the failure this platform exists to\n"
        "  prevent."
    )


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--labels", required=True, type=Path)
    p.add_argument("--predictions", type=Path, help="CSV to score against the labels")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if not args.labels.is_file():
        print(f"labels not found: {args.labels}", file=sys.stderr)
        return 2

    labels = read_labels(args.labels)
    if not labels:
        print("no usable labels", file=sys.stderr)
        return 2

    describe_labels(labels)

    if args.predictions is None:
        print("\nNo --predictions given; nothing scored.")
        return 0

    if not args.predictions.is_file():
        print(f"predictions not found: {args.predictions}", file=sys.stderr)
        return 2

    predictions = read_labels(args.predictions)
    print(f"\nPredictions: {len(predictions):,} polling units")

    matrices, overlap = score(labels, predictions)
    if overlap == 0:
        print(
            "\nNo polling units in common. Check that the prediction codes use"
            " the same form as the labels.",
            file=sys.stderr,
        )
        return 3

    missing = len(labels) - overlap
    if missing:
        print(
            f"  {missing:,} labelled units have no prediction -- reported as a"
            " coverage gap, not scored as wrong answers"
        )

    report(matrices, overlap)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
