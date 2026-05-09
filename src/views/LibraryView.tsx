import { useEffect, useRef, useState } from "react";
import {
  LibraryItem,
  deleteLibraryItem,
  formatDuration,
  formatTime,
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
            {item.characters && item.characters.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {item.characters.map((c) => (
                  <span
                    key={c.id}
                    className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-200"
                    title="Character"
                  >
                    {c.name}
                  </span>
                ))}
              </div>
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

type PreviewTab = "clip" | "source" | "side-by-side";

function PreviewModal({
  item,
  onClose,
}: {
  item: LibraryItem;
  onClose: () => void;
}) {
  const sourceAvailable = Boolean(item.sourceVideoUrl);
  const hasTrimMeta =
    typeof item.in === "number" && typeof item.out === "number" && item.out > item.in;

  const [tab, setTab] = useState<PreviewTab>("clip");
  const [loopSelection, setLoopSelection] = useState(true);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/80 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-ink-800 bg-ink-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-ink-800 px-4 py-2">
          <div className="min-w-0">
            <div className="truncate font-medium">{item.name}</div>
            {hasTrimMeta && (
              <div className="font-mono text-[11px] text-ink-500">
                in {formatTime(item.in!)} → out {formatTime(item.out!)} ·{" "}
                {formatDuration((item.out ?? 0) - (item.in ?? 0))}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <div className="flex overflow-hidden rounded-md border border-ink-700 text-xs">
              <TabButton active={tab === "clip"} onClick={() => setTab("clip")}>
                Clip
              </TabButton>
              <TabButton
                active={tab === "source"}
                disabled={!sourceAvailable}
                onClick={() => sourceAvailable && setTab("source")}
                title={sourceAvailable ? "" : "Source file isn't available"}
              >
                Source
              </TabButton>
              <TabButton
                active={tab === "side-by-side"}
                disabled={!sourceAvailable}
                onClick={() =>
                  sourceAvailable && setTab("side-by-side")
                }
                title={sourceAvailable ? "" : "Source file isn't available"}
              >
                Side-by-side
              </TabButton>
            </div>

            {tab !== "clip" && hasTrimMeta && (
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-400">
                <input
                  type="checkbox"
                  className="accent-accent-500"
                  checked={loopSelection}
                  onChange={(e) => setLoopSelection(e.target.checked)}
                />
                Loop selection
              </label>
            )}

            <button
              className="rounded-md border border-ink-700 px-2 py-1 text-sm text-ink-300 hover:bg-ink-800"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-hidden bg-black">
          {tab === "clip" && (
            <ClipPlayer src={item.videoUrl} className="h-[70vh] w-full" />
          )}
          {tab === "source" && sourceAvailable && (
            <SourcePlayer
              src={item.sourceVideoUrl!}
              inT={item.in}
              outT={item.out}
              loopSelection={loopSelection && hasTrimMeta}
              className="h-[70vh] w-full"
            />
          )}
          {tab === "side-by-side" && sourceAvailable && (
            <div className="grid h-[70vh] grid-cols-2 divide-x divide-ink-800">
              <div className="flex flex-col">
                <div className="border-b border-ink-800 bg-ink-900/60 px-3 py-1 text-xs uppercase tracking-wide text-ink-400">
                  Clip
                </div>
                <ClipPlayer src={item.videoUrl} className="flex-1 bg-black" />
              </div>
              <div className="flex flex-col">
                <div className="border-b border-ink-800 bg-ink-900/60 px-3 py-1 text-xs uppercase tracking-wide text-ink-400">
                  Source {hasTrimMeta && `(loop ${formatTime(item.in!)}–${formatTime(item.out!)})`}
                </div>
                <SourcePlayer
                  src={item.sourceVideoUrl!}
                  inT={item.in}
                  outT={item.out}
                  loopSelection={loopSelection && hasTrimMeta}
                  className="flex-1 bg-black"
                />
              </div>
            </div>
          )}
        </div>

        {item.description && (
          <div className="border-t border-ink-800 px-4 py-3 text-sm text-ink-300">
            {item.description}
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({
  children,
  active,
  disabled,
  onClick,
  title,
}: {
  children: React.ReactNode;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={
        "px-2.5 py-1 transition " +
        (active
          ? "bg-accent-500 text-black"
          : disabled
          ? "bg-ink-900 text-ink-600"
          : "bg-ink-900 text-ink-300 hover:bg-ink-800")
      }
    >
      {children}
    </button>
  );
}

function ClipPlayer({ src, className }: { src: string; className?: string }) {
  return (
    <video
      key={src}
      src={src}
      controls
      autoPlay
      loop
      playsInline
      className={className}
    />
  );
}

function SourcePlayer({
  src,
  inT,
  outT,
  loopSelection,
  className,
}: {
  src: string;
  inT?: number;
  outT?: number;
  loopSelection: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  // Seek to the in-point when the source first loads / when the URL changes.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    function onLoaded() {
      if (typeof inT === "number" && Number.isFinite(inT)) {
        try {
          v!.currentTime = inT;
        } catch {
          // ignore
        }
      }
      v!.play().catch(() => {});
    }
    v.addEventListener("loadedmetadata", onLoaded);
    return () => v.removeEventListener("loadedmetadata", onLoaded);
  }, [src, inT]);

  // While "Loop selection" is on, wrap from out → in.
  useEffect(() => {
    const v = ref.current;
    if (!v || !loopSelection) return;
    if (typeof inT !== "number" || typeof outT !== "number") return;
    function onTime() {
      if (!v) return;
      if (v.currentTime >= outT! - 0.02) {
        try {
          v.currentTime = inT!;
        } catch {
          // ignore
        }
      }
    }
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [loopSelection, inT, outT, src]);

  return (
    <video
      ref={ref}
      key={src}
      src={src}
      controls
      autoPlay
      playsInline
      className={className}
    />
  );
}
