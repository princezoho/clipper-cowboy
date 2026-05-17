/**
 * Clamp an [in, out] selection into a video's [0, duration] range.
 *
 * Tolerates non-finite inputs and negative durations. When the file duration
 * is unknown (<= 0) we leave the upper bound alone so callers can still use
 * the original selection.
 */
export function clampSegmentToDuration(
  inT: number,
  outT: number,
  fileDur: number,
): { inT: number; outT: number } {
  let a = Number.isFinite(inT) ? Math.max(0, inT) : 0;
  let b = Number.isFinite(outT) ? Math.max(0, outT) : 0;
  if (Number.isFinite(fileDur) && fileDur > 0) {
    a = Math.min(a, fileDur);
    b = Math.min(b, fileDur);
  }
  if (b < a) {
    const tmp = a;
    a = b;
    b = tmp;
  }
  return { inT: a, outT: b };
}
