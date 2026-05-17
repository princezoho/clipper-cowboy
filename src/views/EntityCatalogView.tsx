import { useEffect, useMemo, useState } from "react";
import {
  Entity,
  EntityKind,
  LibraryItem,
  createEntity,
  deleteEntity,
  fetchEntities,
  patchEntity,
} from "../lib/api";
import { fireToast } from "../lib/toast";

const PREVIEW_CLIP_MAX = 3;

interface Props {
  kind: EntityKind;
  /** Plural Title-Case label, e.g. "Scenes". */
  label: string;
  /** Singular lowercase noun, e.g. "scene". */
  singular: string;
  /** Optional helper text shown above the input. */
  hint?: string;
  reloadKey?: number;
  onChanged?: () => void;
  selectedIds: Set<string>;
  onSelect: (id: string) => void;
  /** Used to display "N clips" badges on each card. */
  library: LibraryItem[];
}

/**
 * Generic catalog view used by both the Scenes and Objects tabs. Mirrors the
 * Characters tab pattern: card grid, click-to-filter (selecting jumps to the
 * Library tab), inline edit/delete. Empty cards still clickable so the user
 * can inspect / use them as filters even before any clips are tagged.
 */
export default function EntityCatalogView({
  kind,
  label,
  singular,
  hint,
  reloadKey,
  onChanged,
  selectedIds,
  onSelect,
  library,
}: Props) {
  const [items, setItems] = useState<Entity[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchEntities(kind);
      setItems(r.items);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, [reloadKey, kind]);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createEntity(kind, {
        name: newName.trim(),
        description: newDesc.trim(),
      });
      setNewName("");
      setNewDesc("");
      await reload();
      onChanged?.();
      fireToast({
        kind: "success",
        title: `${singular[0].toUpperCase()}${singular.slice(1)} added`,
        body: created?.name ?? newName.trim(),
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  }

  // O(items*library) is fine for typical catalogue sizes; precompute counts.
  const countsById = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of library) {
      const arr = kind === "scenes" ? it.scenes : it.objects;
      if (!arr) continue;
      for (const e of arr) m.set(e.id, (m.get(e.id) ?? 0) + 1);
    }
    return m;
  }, [library, kind]);

  /** Up to PREVIEW_CLIP_MAX recent library clips per entity (newest exports first). */
  const previewsByEntityId = useMemo(() => {
    const m = new Map<string, LibraryItem[]>();
    const sorted = [...library].sort((a, b) => b.created - a.created);
    for (const clip of sorted) {
      const arr = kind === "scenes" ? clip.scenes : clip.objects;
      if (!arr?.length) continue;
      for (const e of arr) {
        const list = m.get(e.id);
        if (!list) {
          m.set(e.id, [clip]);
        } else if (
          list.length < PREVIEW_CLIP_MAX &&
          !list.some((c) => c.id === clip.id)
        ) {
          list.push(clip);
        }
      }
    }
    return m;
  }, [library, kind]);

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="rounded-xl border border-ink-800 bg-ink-900 p-4">
        <div className="mb-3 text-sm font-medium text-ink-200">
          {/^[aeiou]/i.test(singular) ? "Add an" : "Add a"} {singular}
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_2fr_auto]">
          <input
            className="rounded bg-ink-800 px-3 py-2 text-sm text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={
              kind === "scenes"
                ? "Name (e.g. Saloon Brawl, Desert Showdown)"
                : "Name (e.g. Rose, Apple, Wagon)"
            }
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleCreate();
              }
            }}
          />
          <input
            className="rounded bg-ink-800 px-3 py-2 text-sm text-ink-200 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Optional description"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleCreate();
              }
            }}
          />
          <button
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
            className="rounded-md bg-accent-500 px-4 py-2 text-sm font-semibold text-black hover:bg-accent-400 disabled:opacity-40"
          >
            {creating ? "Adding…" : "Add"}
          </button>
        </div>
        {hint && (
          <div className="mt-2 text-[11px] text-ink-500">{hint}</div>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="text-sm text-ink-400">Loading {label.toLowerCase()}…</div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ink-800 bg-ink-900/40 p-8 text-center text-sm text-ink-400">
          No {label.toLowerCase()} yet. Add one above to start tagging clips.
        </div>
      ) : (
        <>
          <div className="text-xs text-ink-400">
            Click a card to filter the Library to clips tagged with this{" "}
            {singular}. Each card shows up to {PREVIEW_CLIP_MAX} recent clip
            thumbnails; open the Library for the full set. Multi-select narrows
            further (clips must include <em>all</em> selected {label.toLowerCase()}
            ).
          </div>
          <div
            data-testid={`${kind}-grid`}
            className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4"
          >
            {items.map((e) => (
              <EntityCard
                key={e.id}
                kind={kind}
                entity={e}
                count={countsById.get(e.id) ?? 0}
                previews={previewsByEntityId.get(e.id) ?? []}
                selected={selectedIds.has(e.id)}
                onSelect={() => onSelect(e.id)}
                onChanged={() => {
                  reload();
                  onChanged?.();
                }}
                onError={setError}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function EntityCard({
  kind,
  entity,
  count,
  previews,
  selected,
  onSelect,
  onChanged,
  onError,
}: {
  kind: EntityKind;
  entity: Entity;
  count: number;
  previews: LibraryItem[];
  selected: boolean;
  onSelect: () => void;
  onChanged: () => void;
  onError: (s: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(entity.name);
  const [description, setDescription] = useState(entity.description);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await patchEntity(kind, entity.id, { name, description });
      setEditing(false);
      onChanged();
    } catch (err) {
      onError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (
      !confirm(
        `Delete ${kind === "scenes" ? "scene" : "object"} "${entity.name}"? Existing clip tags pointing at it will become orphaned (they keep the cached name but won't filter anymore).`
      )
    )
      return;
    try {
      await deleteEntity(kind, entity.id);
      onChanged();
      fireToast({
        kind: "warn",
        title: `${kind === "scenes" ? "Scene" : "Object"} deleted`,
        body: entity.name,
      });
    } catch (err) {
      onError(String(err));
    }
  }

  const cardClasses =
    "relative flex flex-col overflow-hidden rounded-xl border bg-ink-900 transition " +
    (selected
      ? "border-accent-500 ring-2 ring-accent-500/60"
      : "border-ink-800 hover:border-ink-700");

  return (
    <div className={cardClasses}>
      {selected && (
        <div className="pointer-events-none absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-accent-500 text-black shadow-md">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4 w-4"
          >
            <path
              fillRule="evenodd"
              d="M16.704 5.296a1 1 0 010 1.408l-7.5 7.5a1 1 0 01-1.408 0l-3.5-3.5a1 1 0 011.408-1.408L8.5 12.09l6.796-6.794a1 1 0 011.408 0z"
              clipRule="evenodd"
            />
          </svg>
        </div>
      )}

      <button
        type="button"
        onClick={onSelect}
        disabled={editing}
        title={
          editing
            ? undefined
            : selected
              ? `Click to remove "${entity.name}" from the Library filter`
              : `Click to filter the Library by "${entity.name}"`
        }
        className="flex w-full flex-col items-stretch gap-2 px-4 pt-4 pb-2 text-left transition hover:bg-ink-800/60 disabled:cursor-default"
      >
        <div className="flex flex-col items-start gap-1">
          <span className="text-base font-semibold text-ink-100">
            {entity.name}
          </span>
          <span
            className={
              "rounded-full px-2 py-0.5 text-[11px] " +
              (count > 0
                ? "bg-emerald-500/15 text-emerald-200"
                : "bg-ink-800 text-ink-400")
            }
          >
            {count} clip{count === 1 ? "" : "s"}
          </span>
        </div>

        {previews.length > 0 ? (
          <div className="flex w-full gap-1.5">
            {previews.map((c) => (
              <div
                key={c.id}
                className="min-w-0 flex-1"
                title={c.name}
              >
                <div className="aspect-video w-full overflow-hidden rounded-md border border-ink-800 bg-ink-950 ring-1 ring-black/30">
                  <img
                    src={c.thumbUrl}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="mt-0.5 truncate text-center text-[10px] text-ink-500">
                  {c.name}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {count > previews.length && previews.length > 0 ? (
          <span className="text-[10px] text-ink-500">
            +{count - previews.length} more in Library →
          </span>
        ) : null}
      </button>

      <div className="flex flex-1 flex-col gap-2 p-3 text-sm">
        {editing ? (
          <>
            <input
              className="rounded bg-ink-800 px-2 py-1 text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <textarea
              className="min-h-[3rem] rounded bg-ink-800 px-2 py-1 text-xs text-ink-200 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description"
            />
            <div className="flex justify-end gap-2 pt-1">
              <button
                className="text-xs text-ink-400 hover:text-ink-200"
                onClick={() => {
                  setName(entity.name);
                  setDescription(entity.description);
                  setEditing(false);
                }}
              >
                Cancel
              </button>
              <button
                className="rounded bg-accent-500 px-3 py-1 text-xs font-medium text-black hover:bg-accent-400 disabled:opacity-50"
                onClick={save}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        ) : (
          <>
            {entity.description && (
              <div className="text-xs text-ink-300">{entity.description}</div>
            )}
            <div className="mt-auto flex items-center justify-end gap-2 pt-2 text-[11px]">
              <button
                className="text-ink-400 hover:text-ink-100"
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
              <button
                className="text-ink-500 hover:text-red-400"
                onClick={remove}
              >
                Delete
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
