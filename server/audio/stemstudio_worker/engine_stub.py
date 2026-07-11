# Derived from Stem Studio's python/stemstudio_worker/engine_stub.py
# (Apache-2.0), commit fa1bcd092cecca891cb6192d805999165df351e7.
"""Dependency-light source separator used by Clipper Cowboy's managed worker."""
from __future__ import annotations
from typing import Callable, Dict
import numpy as np

ProgressCb = Callable[[str, float], None]
LOW_CUT = 300.0
HIGH_CUT = 3400.0

def _filter_channel(x: np.ndarray, sr: int, low: float, high: float) -> np.ndarray:
    nyq = sr / 2.0
    low_n, high_n = max(low, 0.0), min(high, nyq)
    try:
        from scipy.signal import butter, sosfiltfilt
        filters = []
        if low_n > 0: filters.append(butter(4, low_n / nyq, btype="highpass", output="sos"))
        if high_n < nyq: filters.append(butter(4, high_n / nyq, btype="lowpass", output="sos"))
        y = x
        for sos in filters: y = sosfiltfilt(sos, y)
        return y.astype(np.float32)
    except Exception:
        freqs = np.fft.rfftfreq(x.shape[0], d=1.0 / sr)
        spectrum = np.fft.rfft(x)
        keep = (freqs >= low_n) & (freqs < high_n)
        return np.fft.irfft(spectrum * keep, n=x.shape[0]).astype(np.float32)

class EngineStub:
    """Stem Studio's deterministic band-split engine and output contract."""
    def load(self, progress_cb: ProgressCb) -> None:
        progress_cb("loading", 20.0)
        progress_cb("loading", 100.0)

    def separate(self, audio: np.ndarray, sr: int, progress_cb: ProgressCb) -> Dict[str, np.ndarray]:
        if audio.ndim == 1: audio = audio[:, None]
        dialogue, music = np.zeros_like(audio), np.zeros_like(audio)
        for channel in range(audio.shape[1]):
            signal = audio[:, channel]
            music[:, channel] = _filter_channel(signal, sr, 0.0, LOW_CUT)
            dialogue[:, channel] = _filter_channel(signal, sr, LOW_CUT, HIGH_CUT)
            progress_cb("separating", (channel + 0.6) / audio.shape[1] * 100.0)
        effects = (audio - music - dialogue).astype(np.float32)
        progress_cb("separating", 100.0)
        return {"dialogue": dialogue.astype(np.float32), "music": music.astype(np.float32), "effects": effects}
