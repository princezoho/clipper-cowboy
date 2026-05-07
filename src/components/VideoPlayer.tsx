import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

export interface VideoPlayerHandle {
  el: HTMLVideoElement | null;
  togglePlay: () => void;
  play: () => void;
  pause: () => void;
  seek: (t: number) => void;
  stepFrame: (delta: number) => void;
  setRate: (r: number) => void;
}

interface Props {
  src: string;
  onTimeUpdate?: (t: number) => void;
  onLoaded?: (info: { duration: number; width: number; height: number }) => void;
  fps: number;
}

type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    cb: (now: number, metadata: { mediaTime: number }) => void
  ) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(function VideoPlayer(
  { src, onTimeUpdate, onLoaded, fps },
  ref
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  useImperativeHandle(ref, () => ({
    get el() {
      return videoRef.current;
    },
    togglePlay() {
      const v = videoRef.current;
      if (!v) return;
      if (v.paused) v.play();
      else v.pause();
    },
    play() {
      videoRef.current?.play();
    },
    pause() {
      videoRef.current?.pause();
    },
    seek(t: number) {
      const v = videoRef.current;
      if (!v) return;
      v.currentTime = Math.max(0, Math.min(t, v.duration || t));
    },
    stepFrame(delta: number) {
      const v = videoRef.current;
      if (!v) return;
      v.pause();
      const dt = delta / Math.max(1, fps);
      v.currentTime = Math.max(0, Math.min(v.currentTime + dt, v.duration));
    },
    setRate(r: number) {
      const v = videoRef.current;
      if (!v) return;
      v.playbackRate = r;
    },
  }));

  useEffect(() => {
    const v = videoRef.current as RvfcVideo | null;
    if (!v) return;

    let rafId: number | null = null;
    let vfcId: number | null = null;
    let cancelled = false;

    const useVfc = typeof v.requestVideoFrameCallback === "function";

    const tick = () => {
      if (cancelled) return;
      if (onTimeUpdate) onTimeUpdate(v.currentTime);
      if (!v.paused && !v.ended) {
        if (useVfc && v.requestVideoFrameCallback) {
          vfcId = v.requestVideoFrameCallback(tick);
        } else {
          rafId = requestAnimationFrame(tick);
        }
      }
    };

    const onPlay = () => {
      setPlaying(true);
      tick();
    };
    const onPause = () => {
      setPlaying(false);
      if (onTimeUpdate) onTimeUpdate(v.currentTime);
    };
    const onSeeked = () => {
      if (onTimeUpdate) onTimeUpdate(v.currentTime);
    };
    const onLoadedMeta = () => {
      onLoaded?.({
        duration: v.duration,
        width: v.videoWidth,
        height: v.videoHeight,
      });
      if (onTimeUpdate) onTimeUpdate(v.currentTime);
    };

    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("timeupdate", onSeeked);
    v.addEventListener("loadedmetadata", onLoadedMeta);

    return () => {
      cancelled = true;
      if (rafId != null) cancelAnimationFrame(rafId);
      if (vfcId != null && v.cancelVideoFrameCallback) {
        v.cancelVideoFrameCallback(vfcId);
      }
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("timeupdate", onSeeked);
      v.removeEventListener("loadedmetadata", onLoadedMeta);
    };
  }, [onTimeUpdate, onLoaded]);

  return (
    <div className="relative flex h-full w-full items-center justify-center bg-black">
      <video
        ref={videoRef}
        src={src}
        className="max-h-full max-w-full"
        preload="auto"
      />
      {!playing && (
        <button
          aria-label="Play"
          onClick={() => videoRef.current?.play()}
          className="absolute inset-0 flex items-center justify-center bg-black/0 transition hover:bg-black/20"
        >
          <span className="grid h-16 w-16 place-items-center rounded-full bg-white/15 text-3xl text-white backdrop-blur">
            ▶
          </span>
        </button>
      )}
    </div>
  );
});

export default VideoPlayer;
