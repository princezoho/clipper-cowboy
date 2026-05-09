import { useEffect, useState } from "react";
import {
  Character,
  CharacterRef,
  createCharacter,
  deleteCharacter,
  deleteCharacterRef,
  fetchCharacters,
  patchCharacter,
} from "../lib/api";

interface Props {
  reloadKey?: number;
  onChanged?: () => void;
}

export default function CharactersView({ reloadKey, onChanged }: Props) {
  const [items, setItems] = useState<Character[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchCharacters();
      setItems(r.items);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, [reloadKey]);

  function bumpParent() {
    onChanged?.();
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createCharacter({
        name: newName.trim(),
        description: newDesc.trim(),
      });
      setNewName("");
      setNewDesc("");
      await reload();
      bumpParent();
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="rounded-xl border border-ink-800 bg-ink-900 p-4">
        <div className="mb-3 text-sm font-medium text-ink-200">
          Add a character
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_2fr_auto]">
          <input
            className="rounded bg-ink-800 px-3 py-2 text-sm text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name (e.g. Buck, Marshall Roy)"
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
            placeholder="Optional description (e.g. blonde sheriff with mustache)"
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
        <div className="mt-2 text-[11px] text-ink-500">
          After adding, open a clip from the Pool, mark in/out, and use the
          editor to add reference frames to this character. Or drop your own
          .jpg/.png files into <code className="text-ink-400">characters/&lt;name&gt;/refs/</code>{" "}
          on disk.
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="text-sm text-ink-400">Loading characters…</div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ink-800 bg-ink-900/40 p-8 text-center text-sm text-ink-400">
          No characters yet. Add one above to start auto-tagging clips that
          feature them.
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
          {items.map((c) => (
            <CharacterCard
              key={c.id}
              character={c}
              onChanged={() => {
                reload();
                bumpParent();
              }}
              onError={setError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CharacterCard({
  character,
  onChanged,
  onError,
}: {
  character: Character;
  onChanged: () => void;
  onError: (s: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(character.name);
  const [description, setDescription] = useState(character.description);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await patchCharacter(character.id, { name, description });
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
        `Delete character "${character.name}" and ${character.refCount} reference image${character.refCount === 1 ? "" : "s"}?`
      )
    )
      return;
    try {
      await deleteCharacter(character.id);
      onChanged();
    } catch (err) {
      onError(String(err));
    }
  }

  async function removeRef(ref: CharacterRef) {
    if (!confirm(`Remove this reference image from ${character.name}?`)) return;
    try {
      await deleteCharacterRef(character.id, ref.name);
      onChanged();
    } catch (err) {
      onError(String(err));
    }
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-ink-800 bg-ink-900">
      <div className="flex aspect-video items-center justify-center bg-ink-950">
        {character.thumbUrl ? (
          <img
            src={character.thumbUrl}
            alt={character.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="px-4 text-center text-xs text-ink-500">
            No reference images yet — open a pool clip and add a frame from the
            editor.
          </div>
        )}
      </div>

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
                  setName(character.name);
                  setDescription(character.description);
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
            <div className="font-medium text-ink-100">{character.name}</div>
            {character.description && (
              <div className="text-xs text-ink-300">
                {character.description}
              </div>
            )}
            <div className="text-[11px] text-ink-500">
              {character.refCount} reference image
              {character.refCount === 1 ? "" : "s"} ·{" "}
              <code className="text-ink-400">characters/{character.folder}</code>
            </div>

            {character.refs.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {character.refs.map((ref) => (
                  <button
                    key={ref.name}
                    onClick={() => removeRef(ref)}
                    title="Click to remove this reference"
                    className="group relative h-12 w-12 overflow-hidden rounded border border-ink-800"
                  >
                    <img
                      src={ref.url}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                    <span className="absolute inset-0 hidden items-center justify-center bg-black/70 text-[10px] text-red-300 group-hover:flex">
                      remove
                    </span>
                  </button>
                ))}
              </div>
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
