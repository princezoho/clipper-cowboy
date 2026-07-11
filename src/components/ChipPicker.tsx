import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NamedRef } from "../lib/api";
import { useFloatingMenuPosition } from "../lib/useFloatingMenuPosition";

export type ChipTone = "emerald" | "sky" | "fuchsia" | "neutral";

interface CommonProps {
  /** Visible "+ Add tag" / "+ Add scene" label on the closed pill. */
  placeholder: string;
  /** Tone for the rendered chip pills. */
  tone?: ChipTone;
  /** Title for each existing chip — controls the on-hover hint. */
  chipTitle?: (value: NamedRef | string) => string;
  /** Optional className passthrough for the row. */
  className?: string;
}

interface TagModeProps extends CommonProps {
  mode: "tag";
  current: string[];
  selected?: Set<string>;
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
  onChipClick?: (tag: string) => void;
}

interface EntityModeProps extends CommonProps {
  mode: "entity";
  current: NamedRef[];
  options: NamedRef[];
  /** Should we POST a new entity if no option matches the typed text? */
  allowCreate?: boolean;
  onAdd: (value: NamedRef) => void;
  onRemove: (id: string) => void;
  onCreate?: (name: string) => Promise<NamedRef>;
  selected?: Set<string>;
  onChipClick?: (id: string) => void;
}

type Props = TagModeProps | EntityModeProps;

const TONE_INACTIVE: Record<ChipTone, string> = {
  emerald: "bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25",
  sky: "bg-sky-500/15 text-sky-200 hover:bg-sky-500/25",
  fuchsia: "bg-fuchsia-500/15 text-fuchsia-200 hover:bg-fuchsia-500/25",
  neutral: "bg-ink-800 text-ink-300 hover:bg-ink-700 hover:text-ink-100",
};

const TONE_ACTIVE: Record<ChipTone, string> = {
  emerald: "bg-accent-500 text-black",
  sky: "bg-sky-400 text-black",
  fuchsia: "bg-fuchsia-400 text-black",
  neutral: "bg-accent-500 text-black",
};

const TONE_REMOVE: Record<ChipTone, string> = {
  emerald: "text-black/55 hover:text-black",
  sky: "text-black/55 hover:text-black",
  fuchsia: "text-black/55 hover:text-black",
  neutral: "text-black/55 hover:text-black",
};

/**
 * Generic chip row + inline "+ Add" picker. Two modes:
 * - `tag` (free-form): typing creates a new tag on Enter/blur.
 * - `entity` (catalog): typing filters an existing-options dropdown;
 *   Enter creates a new entity (when `allowCreate` and no exact match).
 *
 * The popover is implemented as a small inline expansion (not an
 * absolute-positioned overlay) so it works gracefully inside grid cards
 * without escaping the card bounds.
 */
function isEntityMode(props: Props): props is EntityModeProps {
  return props.mode === "entity";
}

export default function ChipPicker(props: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuStyle = useFloatingMenuPosition(inputRef, open, 208);

  const tone = props.tone ?? "neutral";
  const isEntity = isEntityMode(props);
  const entityOptions = isEntity ? props.options : [];
  const entityCurrent = isEntity ? props.current : [];

  // Auto-focus the input when opening.
  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => inputRef.current?.focus(), 10);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  // Click-outside closes the inline picker.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) {
        commitOnBlur();
        setOpen(false);
        setText("");
        setError(null);
      }
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, text]);

  const filteredOptions = useMemo(() => {
    if (!isEntity) return [];
    const q = text.trim().toLowerCase();
    const has = new Set(entityCurrent.map((c) => c.id));
    const all = entityOptions.filter((o) => !has.has(o.id));
    if (!q) return all.slice(0, 12);
    return all
      .filter((o) => o.name.toLowerCase().includes(q))
      .slice(0, 12);
  }, [entityCurrent, entityOptions, isEntity, text]);

  const exactEntityMatch = useMemo(() => {
    if (!isEntity) return null;
    const q = text.trim().toLowerCase();
    if (!q) return null;
    return entityOptions.find((o) => o.name.toLowerCase() === q) ?? null;
  }, [entityOptions, isEntity, text]);


  function commitOnBlur() {
    const q = text.trim();
    if (!q) return;
    if (props.mode === "tag") {
      void addTag(q);
    }
    // For entity mode, blur-without-Enter does nothing (avoid surprise creates).
  }

  async function addTag(raw: string) {
    const t = raw.trim().toLowerCase();
    if (!t) return;
    if (props.mode !== "tag") return;
    if (props.current.some((c) => c.toLowerCase() === t)) {
      setText("");
      return;
    }
    props.onAdd(t);
    setText("");
  }

  async function addEntityFromText() {
    if (props.mode !== "entity") return;
    const q = text.trim();
    if (!q) return;
    if (exactEntityMatch) {
      props.onAdd(exactEntityMatch);
      setText("");
      return;
    }
    if (filteredOptions.length > 0 && activeIdx < filteredOptions.length) {
      props.onAdd(filteredOptions[activeIdx]);
      setText("");
      return;
    }
    if (props.allowCreate && props.onCreate) {
      setBusy(true);
      setError(null);
      try {
        const created = await props.onCreate(q);
        props.onAdd(created);
        setText("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setText("");
      setError(null);
      return;
    }
    if (props.mode === "entity") {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) =>
          Math.min(i + 1, Math.max(filteredOptions.length - 1, 0))
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
        return;
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (props.mode === "tag") void addTag(text);
      else void addEntityFromText();
    }
  }

  const inactive = TONE_INACTIVE[tone];
  const active = TONE_ACTIVE[tone];
  const removeBtn = TONE_REMOVE[tone];

  return (
    <div ref={wrapRef} className={"flex flex-wrap items-center gap-1 " + (props.className ?? "")}>
      {props.mode === "tag"
        ? props.current.map((t) => {
            const isActive = props.selected?.has(t.toLowerCase()) ?? false;
            return (
              <Chip
                key={`tag-${t}`}
                label={t}
                title={
                  props.chipTitle
                    ? props.chipTitle(t)
                    : isActive
                      ? "Click to remove from filter"
                      : `Filter by tag "${t}"`
                }
                onClick={() => props.onChipClick?.(t)}
                onRemove={() => props.onRemove(t)}
                className={isActive ? active : inactive}
                removeClassName={isActive ? removeBtn : "text-ink-500 hover:text-ink-100"}
              />
            );
          })
        : props.current.map((ref) => {
            const isActive = props.selected?.has(ref.id) ?? false;
            return (
              <Chip
                key={`ent-${ref.id}`}
                label={ref.name}
                title={
                  props.chipTitle
                    ? props.chipTitle(ref)
                    : isActive
                      ? "Click to remove from filter"
                      : `Filter by ${ref.name}`
                }
                onClick={() => props.onChipClick?.(ref.id)}
                onRemove={() => props.onRemove(ref.id)}
                className={isActive ? active : inactive}
                removeClassName={isActive ? removeBtn : "text-ink-500 hover:text-ink-100"}
              />
            );
          })}

      {!open && (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setActiveIdx(0);
          }}
          className="rounded-full border border-dashed border-ink-700 px-2 py-0.5 text-[11px] text-ink-400 hover:border-ink-500 hover:text-ink-200"
        >
          {props.placeholder}
        </button>
      )}

      {open && (
        <div className="relative inline-flex flex-col">
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setActiveIdx(0);
            }}
            onKeyDown={onKeyDown}
            onBlur={() => {
              // Delay so option-click can land before we close.
              window.setTimeout(() => {
                if (!wrapRef.current?.contains(document.activeElement)) {
                  commitOnBlur();
                  setOpen(false);
                  setText("");
                  setError(null);
                }
              }, 120);
            }}
            placeholder={props.placeholder.replace(/^\+ ?/, "")}
            disabled={busy}
            className="w-32 rounded-full bg-ink-800 px-2 py-0.5 text-[11px] text-ink-100 outline-none ring-1 ring-ink-700 placeholder:text-ink-500 focus:ring-accent-500"
          />
          {props.mode === "entity" &&
            open &&
            menuStyle &&
            (filteredOptions.length > 0 || (props.allowCreate && text.trim())) &&
            createPortal(
              <div
                style={menuStyle}
                className="max-h-52 overflow-y-auto rounded-md border border-ink-700 bg-ink-800 shadow-lg"
              >
                {filteredOptions.map((o, i) => (
                  <button
                    key={o.id}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      props.onAdd(o);
                      setText("");
                    }}
                    onMouseEnter={() => setActiveIdx(i)}
                    className={
                      "block w-full truncate px-2.5 py-1.5 text-left text-[11px] " +
                      (i === activeIdx
                        ? "bg-ink-700 text-ink-100"
                        : "text-ink-200 hover:bg-ink-700")
                    }
                  >
                    {o.name}
                  </button>
                ))}
                {props.allowCreate &&
                  text.trim() &&
                  !exactEntityMatch && (
                    <button
                      type="button"
                      disabled={busy}
                      onMouseDown={async (e) => {
                        e.preventDefault();
                        await addEntityFromText();
                      }}
                      className="block w-full truncate border-t border-ink-700 px-2.5 py-1.5 text-left text-[11px] text-emerald-200 hover:bg-ink-700 disabled:opacity-50"
                    >
                      {busy ? "Creating…" : `+ Create "${text.trim()}"`}
                    </button>
                  )}
              </div>,
              document.body
            )}
          {error && (
            <span
              className="mt-1 max-w-[10rem] truncate text-[10px] text-red-300"
              title={error}
            >
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function Chip({
  label,
  title,
  onClick,
  onRemove,
  className,
  removeClassName,
}: {
  label: string;
  title?: string;
  onClick?: () => void;
  onRemove: () => void;
  className: string;
  removeClassName: string;
}) {
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition " +
        className
      }
    >
      <button
        type="button"
        onClick={onClick}
        title={title}
        className="outline-none"
      >
        {label}
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        title={`Remove ${label}`}
        className={"ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-[10px] " + removeClassName}
      >
        ×
      </button>
    </span>
  );
}
