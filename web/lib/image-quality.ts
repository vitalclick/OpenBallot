// Capture-time image quality checks (issue #70).
//
// The same two checks the worker runs (worker/app/ingestion/image_quality.py),
// run here first — because this is the only moment where a bad photograph is
// cheaply fixable. An agent standing in front of the form can retake it. The
// same agent, two hours later and three polling units away, cannot.
//
// From the CCIJ 2023 analysis: many illegible IReV papers shared one exact
// size, 192x256, and that single observation identified over 10,000 election
// papers too small for a human to read. Around 8% of all documents on INEC's
// portal were classified blurred or sent for blur crowdsourcing. Those are
// results nobody could verify afterwards.
//
// ADVISORY, NEVER BLOCKING. An agent who cannot get a sharper photo — bad
// light, a damaged form, a crowd, a hostile polling unit — must still be able
// to submit. A marginal image of a real result is worth far more than no
// image, and an agent who stops trusting the app stops submitting. The result
// carries a suggestion; the caller decides what to show, and submission always
// remains available.

/** Dimensions CCIJ found on illegible IReV papers. */
export const ILLEGIBLE_WIDTH = 192;
export const ILLEGIBLE_HEIGHT = 256;

/** Comfortable floor for a phone photograph of an A4 form. */
export const MIN_LEGIBLE_LONG_EDGE = 1000;

/**
 * Mean of the log magnitude spectrum below which an image reads as blurred.
 *
 * Not yet calibrated against real EC8A photographs — CCIJ say as much about
 * their own value. Deliberately lenient: a false "too blurry" on a usable
 * photo costs an agent's trust, which is worth more than the marginal image.
 */
export const DEFAULT_BLUR_THRESHOLD = 130;

export interface QualityReport {
  width: number;
  height: number;
  /** null when it could not be measured — not the same as "blurred". */
  blurScore: number | null;
  belowLegibleDimensions: boolean;
  likelyBlurred: boolean;
  /** Short, actionable message, or null when the image looks fine. */
  suggestion: string | null;
}

export function belowLegibleDimensions(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return true;
  if (width <= ILLEGIBLE_WIDTH && height <= ILLEGIBLE_HEIGHT) return true;
  return Math.max(width, height) < MIN_LEGIBLE_LONG_EDGE;
}

/**
 * Mean of the log magnitude spectrum. Higher is sharper.
 *
 * A full 2D FFT in the browser would be slow enough to notice on a mid-range
 * phone, so this uses a variance-of-Laplacian estimate — the standard cheap
 * proxy for the same property, scaled to sit on a comparable range to the
 * worker's spectral score. The worker recomputes authoritatively from the
 * bytes it receives; this only has to be good enough to prompt a retake.
 *
 * Returns null when it cannot be measured (no canvas, tainted context).
 */
export async function blurScore(blob: Blob): Promise<number | null> {
  try {
    const bitmap = await createImageBitmap(blob);

    // Fixed working size keeps the score comparable across cameras.
    const scale = Math.min(512 / bitmap.width, 512 / bitmap.height, 1);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const { data } = ctx.getImageData(0, 0, w, h);

    // Greyscale, Rec. 601 luma.
    const grey = new Float64Array(w * h);
    for (let i = 0; i < grey.length; i++) {
      const p = i * 4;
      grey[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }

    // 4-neighbour Laplacian; its variance collapses on a blurred image.
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const lap =
          4 * grey[i] - grey[i - 1] - grey[i + 1] - grey[i - w] - grey[i + w];
        sum += lap;
        sumSq += lap * lap;
        n++;
      }
    }
    if (n === 0) return null;

    const variance = sumSq / n - (sum / n) ** 2;
    // Map onto the same rough range as the worker's spectral score so one
    // threshold reads sensibly in both places.
    return 20 * Math.log10(Math.max(variance, 1e-9) + 1);
  } catch {
    return null;
  }
}

export async function evaluateImageQuality(
  blob: Blob,
  width: number,
  height: number,
  blurThreshold: number = DEFAULT_BLUR_THRESHOLD,
): Promise<QualityReport> {
  const tooSmall = belowLegibleDimensions(width, height);
  const score = await blurScore(blob);
  const blurred = score !== null && score < blurThreshold;

  let suggestion: string | null = null;
  if (tooSmall) {
    suggestion = 'This photo is too small to read. Please retake it closer to the form.';
  } else if (blurred) {
    suggestion = 'This photo looks blurry. Please hold steady and retake it if you can.';
  }

  return {
    width,
    height,
    blurScore: score,
    belowLegibleDimensions: tooSmall,
    likelyBlurred: blurred,
    suggestion,
  };
}
