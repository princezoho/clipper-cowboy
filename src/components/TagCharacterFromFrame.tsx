import { useState } from "react";
import {
  Character,
  MatchedCharacter,
  addCharacterRef,
  createCharacter,
  formatTime,
} from "../lib/api";

interface Props {
  sourceId: string;
  /** Function that returns the current playhead time in seconds. */
  getCurrentTime: () => number;
  existingCharacters: Character[];
  alreadyMatched: MatchedCharacter[];
  onTagged: (c: MatchedCharacter) => void;
  onCharactersChanged?: () => void;
  onError?: (msg: string) => void;
}

/**
 * Inline expanding control. Click "+ Tag character at playhead" to expose:
 *   - "Name new..." text input → creates a new character + uses the current
 *      frame as their first reference image
 *   - "Connect to existing..." dropdown → adds the current frame as a new
 *      reference image to that character
 * In both cases the resulting character also gets attached to the current
 * clip's matched-character list.
 */
export default function TagCharacterFromFrame({
  sourceId,
  getCurrentTime,
  existingCharacters,
  alreadyMatched,
  onTagged,
  onCharactersChanged,
  onError,
}: Props) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [t, setT] = useState<number | null>(null);

  function openPanel() {
    setT(getCurrentTime());
    setOpen(true);
  }

  function closePanel() {
    setOpen(false);
    setNewName("");
    setT(null);
  }

  async function createNew() {
    const name = newName.trim();
    if (!name || busy || t == null) return;
    setBusy(true);
    try {
      const created = await createCharacter({ name });
      await addCharacterRef(created.id, { sourceId, t });
      onTagged({ id: created.id, name: created.name });
      onCharactersChanged?.();
      closePanel();
    } catch (err) {
      onError?.(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function connectExisting(characterId: string) {
    if (!characterId || busy || t == null) return;
    const target = existingCharacters.find((c) => c.id === characterId);
    if (!target) return;
    setBusy(true);
    try {
      await addCharacterRef(target.id, { sourceId, t });
      if (!alreadyMatched.find((m) => m.id === target.id)) {
        onTagged({ id: target.id, name: target.name });
      }
      onCharactersChanged?.();
      closePanel();
    } catch (err) {
      onError?.(String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={openPanel}
        className="rounded-full border border-dashed border-ink-700 px-2.5 py-0.5 text-[11px] text-ink-400 hover:border-ink-500 hover:text-ink-200"
        title="Capture the current frame as a character reference image"
      >
        + Tag character at playhead
      </button>
    );
  }

  const matchedIds = new Set(alreadyMatched.map((c) => c.id));
  const addable = existingCharacters.filter((c) => !matchedIds.has(c.id));

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-xs">
      <span className="text-[11px] text-ink-500">
        @ {t != null ? formatTime(t) : ""} →
      </span>
      <input
        autoFocus
        className="w-44 rounded bg-ink-800 px-2 py-1 text-xs text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        placeholder="New character name"
        onKeyDown={(e) => {
          if (e.key === "Enter" && newName.trim()) {
            e.preventDefault();
            createNew();
          } else if (e.key === "Escape") {
            closePanel();
          }
        }}
      />
      <button
        className="rounded bg-accent-500 px-2 py-1 text-[11px] font-medium text-black hover:bg-accent-400 disabled:opacity-50"
        disabled={!newName.trim() || busy}
        onClick={createNew}
      >
        {busy ? "…" : "Create"}
      </button>
      {addable.length > 0 && (
        <>
          <span className="text-[10px] text-ink-600">or</span>
          <select
            className="rounded bg-ink-800 px-2 py-1 text-[11px] text-ink-200 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
            value=""
            onChange={(e) => {
              if (e.target.value) connectExisting(e.target.value);
            }}
            disabled={busy}
          >
            <option value="">Connect to existing…</option>
            {addable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </>
      )}
      <button
        className="rounded px-2 py-1 text-[11px] text-ink-500 hover:text-ink-200"
        onClick={closePanel}
      >
        Cancel
      </button>
    </div>
  );
}
