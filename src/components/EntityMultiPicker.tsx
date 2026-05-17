import { useEffect, useState } from "react";
import {
  Entity,
  EntityKind,
  NamedRef,
  createEntity,
  fetchEntities,
} from "../lib/api";

interface Props {
  kind: EntityKind;
  label: string; // e.g. "Scenes"
  selected: NamedRef[];
  onChange: (next: NamedRef[]) => void;
  onCatalogChanged?: () => void;
  /** Reload trigger; bumped from outside when the catalog changes elsewhere. */
  reloadKey?: number;
  /** Tone for chip background — sky for scenes, fuchsia for objects. */
  tone?: "sky" | "fuchsia";
}

/**
 * Compact multi-select picker for Scenes / Objects on the Editor metadata
 * form. Shows currently-selected items as removable chips, lets the user pick
 * an existing one from a dropdown, or type a name + Enter to create + select
 * a new catalog entry in one step.
 */
export default function EntityMultiPicker({
  kind,
  label,
  selected,
  onChange,
  onCatalogChanged,
  reloadKey,
  tone = "sky",
}: Props) {
  const [all, setAll] = useState<Entity[]>([]);
  const [creatingName, setCreatingName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      const r = await fetchEntities(kind);
      setAll(r.items);
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    reload();
  }, [kind, reloadKey]);

  function add(e: Entity) {
    if (selected.some((s) => s.id === e.id)) return;
    onChange([...selected, { id: e.id, name: e.name }]);
  }

  function remove(id: string) {
    onChange(selected.filter((s) => s.id !== id));
  }

  async function handleCreate() {
    const name = creatingName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const e = await createEntity(kind, { name });
      add(e);
      setCreatingName("");
      await reload();
      onCatalogChanged?.();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  const selectedIds = new Set(selected.map((s) => s.id));
  const addable = all.filter((e) => !selectedIds.has(e.id));

  const chipTone =
    tone === "fuchsia"
      ? "bg-fuchsia-500/15 text-fuchsia-200"
      : "bg-sky-500/15 text-sky-200";
  const removeTone =
    tone === "fuchsia"
      ? "text-fuchsia-200/60 hover:text-fuchsia-100"
      : "text-sky-200/60 hover:text-sky-100";

  return (
    <div className="grid grid-cols-[5rem_1fr] items-start gap-2">
      <span className="pt-1.5 text-xs text-ink-400">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.map((s) => (
          <span
            key={s.id}
            className={
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs " +
              chipTone
            }
          >
            {s.name}
            <button
              type="button"
              onClick={() => remove(s.id)}
              className={removeTone}
              aria-label={`Remove ${s.name}`}
            >
              ×
            </button>
          </span>
        ))}
        {addable.length > 0 && (
          <select
            className="rounded bg-ink-800 px-2 py-1 text-xs text-ink-200 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
            value=""
            onChange={(e) => {
              const found = addable.find((x) => x.id === e.target.value);
              if (found) add(found);
              e.target.value = "";
            }}
          >
            <option value="">+ add existing…</option>
            {addable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        <input
          className="w-44 rounded bg-ink-800 px-2 py-1 text-xs text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
          value={creatingName}
          onChange={(e) => setCreatingName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && creatingName.trim()) {
              e.preventDefault();
              handleCreate();
            }
          }}
          placeholder={`+ new ${kind === "scenes" ? "scene" : "object"}…`}
          disabled={busy}
        />
        {error && (
          <span
            className="ml-1 truncate text-[11px] text-red-300"
            title={error}
          >
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
