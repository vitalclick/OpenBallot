"""The one module that touches a vision model (issue #69).

Everything else under `app/layout/` is pure geometry. This is the boundary,
and it is deliberately thin.

Why the model does not live in the worker
-----------------------------------------
The reference implementation pins `torch==1.11.0`, `torchvision==0.12.0` and
`ultralytics==8.2.22` -- old, CUDA-flavoured, and together far larger than the
entire rest of this service. `worker/` is a FastAPI process that must stay
responsive during an election, and adding a multi-gigabyte ML stack to it
would change its memory profile, its cold-start time and its attack surface
all at once.

So the detector runs as a **separate service** (`infra/` compose profile
`vision`), and this module speaks to it over HTTP. `LocalDetector` exists for
the case where someone genuinely wants in-process inference; it imports
ultralytics lazily, inside the call, so importing this module never pulls it
in and the pure-geometry tests keep running without it.

Weights are not in git -- `rotation_22may.pt` is 53 MB and `rect_model.pkl`
is 32 MB. They are fetched from object storage on container start; see
`docs/RECTIFICATION.md`.

Failure is never fatal
----------------------
Every path here degrades to "no detections" rather than raising. Rectification
is an enhancement to extraction, not a precondition for it: a document we
cannot analyse structurally is still a document we can send to Document AI,
and dropping a real EC8A because a vision service was down would be the worst
possible trade.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass

from .geometry import LABELS, LayoutBox, nms_classwise

log = logging.getLogger(__name__)


@dataclass
class DetectionResult:
    boxes: list[LayoutBox]
    page_width: float
    page_height: float
    backend: str
    # None when detection failed. Distinguished from an empty box list, which
    # means the model ran and found nothing -- a real and different finding.
    failed_reason: str | None = None

    @property
    def ok(self) -> bool:
        return self.failed_reason is None


class LayoutDetector(ABC):
    name: str = "abstract"

    @abstractmethod
    async def detect(self, image_bytes: bytes) -> DetectionResult: ...


class NullDetector(LayoutDetector):
    """Detects nothing, successfully.

    The default when no vision service is configured. Downstream code treats
    "no boxes" as "no structural evidence", which makes every consumer degrade
    gracefully: form classification returns UNKNOWN (and still extracts),
    orientation returns None (and the page is not rotated), the crop falls
    back to the whole page.
    """

    name = "null"

    async def detect(self, image_bytes: bytes) -> DetectionResult:
        return DetectionResult(boxes=[], page_width=0, page_height=0, backend=self.name)


class HTTPDetector(LayoutDetector):
    """Calls the vision service over HTTP.

    The service returns oriented boxes in the schema `parse_detections`
    expects. Timeouts are short by design: on election night a slow vision
    service must not become a queue of stalled extractions, and the fallback
    (no detections) costs us structure, not evidence.
    """

    name = "http"

    def __init__(self, base_url: str, timeout_seconds: float = 8.0):
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    async def detect(self, image_bytes: bytes) -> DetectionResult:
        import httpx

        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.post(
                    f"{self.base_url}/detect",
                    content=image_bytes,
                    headers={"content-type": "application/octet-stream"},
                )
                response.raise_for_status()
                payload = response.json()
        except Exception as e:
            # Any failure degrades to "no detections". An EC8A must never be
            # lost because a vision service was unavailable.
            log.warning("layout.detect.failed", extra={"error": str(e)})
            return DetectionResult(
                boxes=[],
                page_width=0,
                page_height=0,
                backend=self.name,
                failed_reason=str(e),
            )

        return parse_detections(payload, backend=self.name)


class LocalDetector(LayoutDetector):
    """In-process inference. Imports ultralytics lazily, inside the call.

    Provided for offline batch work -- scoring the evaluation set, tuning
    thresholds -- not for the request path. See the module docstring.
    """

    name = "local"

    def __init__(self, weights_path: str, image_size: int = 800, confidence: float = 0.05):
        self.weights_path = weights_path
        self.image_size = image_size
        self.confidence = confidence
        self._model = None

    def _load(self):
        if self._model is None:
            # Imported here, not at module scope: importing this module must
            # never pull in ultralytics/torch. See the module docstring.
            from ultralytics import YOLO

            self._model = YOLO(self.weights_path)
        return self._model

    async def detect(self, image_bytes: bytes) -> DetectionResult:
        try:
            import io

            from PIL import Image

            model = self._load()
            with Image.open(io.BytesIO(image_bytes)) as img:
                image = img.convert("RGB")
                width, height = image.size
                predictions = model(
                    image,
                    imgsz=self.image_size,
                    conf=self.confidence,
                    max_det=10_000,
                    verbose=False,
                )
        except Exception as e:
            log.warning("layout.detect.local_failed", extra={"error": str(e)})
            return DetectionResult(
                boxes=[], page_width=0, page_height=0,
                backend=self.name, failed_reason=str(e),
            )

        return parse_detections(
            _ultralytics_to_payload(predictions[0], width, height),
            backend=self.name,
        )


def _ultralytics_to_payload(prediction, width: int, height: int) -> dict:
    """Convert an ultralytics OBB result into our wire schema."""
    obb = getattr(prediction, "obb", None)
    if obb is None:
        return {"page_width": width, "page_height": height, "boxes": []}

    corners = obb.xyxyxyxy.tolist()
    classes = obb.cls.tolist()
    confidences = obb.conf.tolist()
    angles = [row[4] for row in obb.xywhr.tolist()]

    boxes = []
    for i, quad in enumerate(corners):
        label_index = int(classes[i])
        boxes.append(
            {
                "label": LABELS[label_index] if label_index < len(LABELS) else "box",
                "confidence": float(confidences[i]),
                "corners": [[float(x), float(y)] for x, y in quad],
                "angle_degrees": float(angles[i]) * 180.0 / 3.141592653589793,
            }
        )

    return {"page_width": width, "page_height": height, "boxes": boxes}


def parse_detections(payload: dict, *, backend: str = "http") -> DetectionResult:
    """Turn a detection payload into LayoutBoxes, discarding malformed entries.

    Individual bad boxes are skipped rather than failing the whole page: a
    detector emitting one unusable entry should not cost us the other forty.
    """
    boxes: list[LayoutBox] = []

    for raw in payload.get("boxes") or []:
        try:
            corners = tuple((float(x), float(y)) for x, y in raw["corners"])
            if len(corners) != 4:
                continue
            boxes.append(
                LayoutBox(
                    label=str(raw["label"]),
                    confidence=float(raw.get("confidence", 0.0)),
                    corners=corners,
                    angle_degrees=float(raw.get("angle_degrees", 0.0)),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue

    return DetectionResult(
        boxes=nms_classwise(boxes),
        page_width=float(payload.get("page_width") or 0),
        page_height=float(payload.get("page_height") or 0),
        backend=backend,
    )


def build_from_settings() -> LayoutDetector:
    """Pick a detector from configuration. Never raises."""
    from ..config import settings

    url = getattr(settings(), "layout_service_url", None)
    if url:
        return HTTPDetector(url)
    return NullDetector()
