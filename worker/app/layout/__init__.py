"""Document layout: geometry, orientation, and what the elements mean.

Split from the vision model deliberately. Everything in `geometry.py` and
`authentication.py` is pure functions over element boxes, so the parts that
encode judgement -- which way is up, where the presiding officer signs, what
a valid result sheet looks like -- are testable without a GPU, a model
download, or torch in the worker's dependency set.

`detector.py` is the only module that touches a model, and it imports it
lazily.
"""

from .geometry import (
    LayoutBox,
    document_roi,
    infer_orientation,
    layout_summary,
    nms_classwise,
    polygon_iou,
)

__all__ = [
    "LayoutBox",
    "document_roi",
    "infer_orientation",
    "layout_summary",
    "nms_classwise",
    "polygon_iou",
]
