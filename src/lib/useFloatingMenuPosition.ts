import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

/**
 * Fixed-position coords for a menu anchored to a button/input, flipping
 * upward when there isn't enough space below the viewport fold.
 */
export function useFloatingMenuPosition(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  menuMaxHeight = 208
): CSSProperties | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setStyle(null);
      return;
    }
    const el = anchorRef.current;
    if (!el) return;

    const update = () => {
      const r = el.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      const openUp =
        below < menuMaxHeight + 12 && r.top > menuMaxHeight + 12;
      setStyle({
        position: "fixed",
        left: r.left,
        width: Math.max(r.width, 176),
        zIndex: 9999,
        ...(openUp
          ? { bottom: window.innerHeight - r.top + 4 }
          : { top: r.bottom + 4 }),
      });
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, anchorRef, menuMaxHeight]);

  return open ? style : null;
}
