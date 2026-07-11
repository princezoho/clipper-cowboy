import type { ImageItem } from "./api";

/** CSS aspect-ratio value for the preview frame (e.g. "768 / 202"). */
export function imagePreviewAspectRatio(item: Pick<ImageItem, "width" | "height">): string {
  if (item.width && item.height && item.width > 0 && item.height > 0) {
    return `${item.width} / ${item.height}`;
  }
  return "4 / 3";
}

/** Wide banners and tall strips should not be center-cropped in the grid. */
export function imagePreviewObjectFit(
  item: Pick<ImageItem, "width" | "height" | "category">
): "contain" | "cover" {
  if (
    item.category === "object-ref" ||
    item.category === "character-ref" ||
    item.category === "background"
  ) {
    return "contain";
  }
  if (item.width && item.height && item.height > 0) {
    const ratio = item.width / item.height;
    if (ratio > 1.75 || ratio < 0.58) return "contain";
  }
  return "cover";
}
