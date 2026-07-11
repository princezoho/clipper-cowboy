import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IMAGE_CATEGORIES, type ImageCategory } from "../lib/api";
import { useFloatingMenuPosition } from "../lib/useFloatingMenuPosition";

const LABELS: Record<ImageCategory, string> = {
  "": "Uncategorized",
  storyboard: "Storyboard",
  shot: "Shot",
  "character-ref": "Character ref",
  "object-ref": "Object ref",
  background: "Background",
};

interface Props {
  value: ImageCategory;
  onChange: (v: ImageCategory) => void;
  className?: string;
}

export default function CategorySelect({ value, onChange, className }: Props) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuStyle = useFloatingMenuPosition(btnRef, open, 240);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      const menu = document.getElementById("category-select-menu");
      if (menu?.contains(t)) return;
      setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const options: ImageCategory[] = ["", ...IMAGE_CATEGORIES];

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          (className ??
            "w-full rounded bg-ink-800 px-2 py-1 text-left text-xs text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500") +
          " flex items-center justify-between gap-2"
        }
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{LABELS[value]}</span>
        <span className="text-ink-500">{open ? "▴" : "▾"}</span>
      </button>
      {open &&
        menuStyle &&
        createPortal(
          <div
            id="category-select-menu"
            role="listbox"
            style={menuStyle}
            className="max-h-60 overflow-y-auto rounded-md border border-ink-700 bg-ink-800 py-1 shadow-xl"
          >
            {options.map((c) => (
              <button
                key={c || "uncategorized"}
                type="button"
                role="option"
                aria-selected={c === value}
                onClick={() => {
                  onChange(c);
                  setOpen(false);
                }}
                className={
                  "block w-full px-2.5 py-1.5 text-left text-xs transition " +
                  (c === value
                    ? "bg-accent-500/20 text-accent-200"
                    : "text-ink-200 hover:bg-ink-700")
                }
              >
                {LABELS[c]}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
