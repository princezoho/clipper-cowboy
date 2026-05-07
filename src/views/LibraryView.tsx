import { useState } from "react";
import {
  LibraryItem,
  deleteLibraryItem,
  formatDuration,
  patchLibraryItem,
} from "../lib/api";

interface Props {
  items: LibraryItem[];
  loading: boolean;
  onChanged: () => void;
}

export default function LibraryView({ items, loading, onChanged }: Props) {
  const [preview, setPreview] = useState<LibraryItem | null>(null);

  if (loading && items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-ink-400">
        Loading library…
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-ink-400">
        <div className="text-lg text-ink-200">Library is empty</div>
        <div className="max-w-md text-sm">
          Open a pool video, mark in/out, and export. Your clips show up here.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4 p-5">
        {items.map((item) => (
          <ClipCard
            key={item.id}
            item={item}
            onPreview={() => setPreview(item)}
            onChanged={onChanged}
          />
        ))}
      </div>
      {preview && (
        <PreviewModal item={preview} onClose={() => setPreview(null)} />
      )}
    </>
  );
}

function ClipCard({
  item,
  onPreview,
  onChanged,
}: {
  item: LibraryItem;
  onPreview: () => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description);
  const [tagsText, setTagsText] = useState(item.tags.join(", "));
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const tags = tagsText
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      await patchLibraryItem(item.id, { name, description, tags });
      setEditing(false);
      onChanged();
    } catch (err) {
      alert(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete clip "${item.name}"? The file will also be removed.`)) {
      return;
    }
    try {
      await deleteLibraryItem(item.id);
      onChanged();
    } catch (err) {
      alert(String(err));
    }
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-ink-800 bg-ink-900">
      <button
        className="relative aspect-video overflow-hidden bg-ink-950"
        onClick={onPreview}
        title="Preview"
      >
        <img
          src={item.thumbUrl}
          loading="lazy"
          alt={item.name}
          className="h-full w-full object-cover transition hover:scale-[1.02]"
        />
        {item.duration != null && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px]">
            {formatDuration(item.duration)}
          </span>
        )}
        {item.mode && (
          <span
            className={
              "absolute left-1.5 top-1.5 rounded px-1.5 py-0.5 font-mono text-[10px] " +
              (item.mode === "stream-copy"
                ? "bg-emerald-500/80 text-black"
                : item.mode === "smart-cut"
                ? "bg-accent-500/85 text-black"
                : "bg-amber-500/85 text-black")
            }
            title={item.details}
          >
            {item.mode}
          </span>
        )}
      </button>

      <div className="flex flex-1 flex-col gap-2 p-3 text-sm">
        {editing ? (
          <>
            <input
              className="rounded bg-ink-800 px-2 py-1 text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
            />
            <textarea
              className="min-h-[3rem] rounded bg-ink-800 px-2 py-1 text-xs text-ink-200 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description"
            />
            <input
              className="rounded bg-ink-800 px-2 py-1 text-xs text-ink-200 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="tag1, tag2, tag3"
            />
            <div className="flex justify-end gap-2 pt-1">
              <button
                className="text-xs text-ink-400 hover:text-ink-200"
                onClick={() => {
                  setName(item.name);
                  setDescription(item.description);
                  setTagsText(item.tags.join(", "));
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
            <div className="font-medium text-ink-100">{item.name}</div>
            {item.description && (
              <div className="text-xs text-ink-300">{item.description}</div>
            )}
            {item.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {item.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-ink-800 px-2 py-0.5 text-[11px] text-ink-300"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-auto flex items-center justify-between pt-2 text-[11px] text-ink-500">
              <span className="truncate font-mono" title={item.filename}>
                {item.filename}
              </span>
              <div className="flex shrink-0 items-center gap-2">
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
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PreviewModal({
  item,
  onClose,
}: {
  item: LibraryItem;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/80 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-ink-800 bg-ink-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-800 px-4 py-2">
          <div className="font-medium">{item.name}</div>
          <button
            className="text-ink-400 hover:text-ink-100"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <video
          src={item.videoUrl}
          controls
          autoPlay
          className="max-h-[70vh] w-full bg-black"
        />
        {item.description && (
          <div className="px-4 py-3 text-sm text-ink-300">
            {item.description}
          </div>
        )}
      </div>
    </div>
  );
}
