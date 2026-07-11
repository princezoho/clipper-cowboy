"""Real Demucs engine adapted from Stem Studio's engine_mvsep.py.

Stem Studio uses Demucs' ``apply_model`` for its MVSEP-CDX23 worker. Clipper
uses the maintained Demucs ``htdemucs`` checkpoint instead: its four sources
are mapped to dialogue (vocals), music (drums + bass), and effects (other).
The residual is folded into effects, preserving the input mixture exactly.
"""
from __future__ import annotations

import os
import sys
from typing import Callable, Dict

import numpy as np

ProgressCb = Callable[[str, float], None]


def _log(message: str) -> None:
    print(f"[engine_demucs] {message}", file=sys.stderr, flush=True)


def _device(torch):
    override = os.environ.get("CLIPPER_AUDIO_DEVICE", "").strip().lower()
    if override in ("cpu", "mps", "cuda"):
        if override == "cuda" and torch.cuda.is_available():
            return torch.device("cuda")
        if override == "mps" and torch.backends.mps.is_available():
            return torch.device("mps")
        if override == "cpu":
            return torch.device("cpu")
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


class EngineDemucs:
    """Stem Studio-derived model invocation using Demucs' official htdemucs."""

    def __init__(self, cache_dir: str | None) -> None:
        self.cache_dir = cache_dir
        self._torch = None
        self._model = None
        self._device = None

    @staticmethod
    def probe() -> dict:
        import torch

        return {
            "device": str(_device(torch)),
            "torch": str(torch.__version__),
            "engines": ["demucs"],
            "model": "htdemucs",
        }

    def load(self, progress_cb: ProgressCb) -> None:
        if self.cache_dir:
            os.makedirs(self.cache_dir, exist_ok=True)
            # Demucs delegates its verified fixed release URL to torch.hub.
            os.environ["TORCH_HOME"] = self.cache_dir
        import torch
        from demucs.pretrained import get_model

        self._torch = torch
        self._device = _device(torch)
        _log(f"loading htdemucs on {self._device}")
        progress_cb("loading", 5.0)
        model = get_model("htdemucs")
        model.eval().to(self._device)
        self._model = model
        progress_cb("loading", 100.0)

    def separate(
        self, audio: np.ndarray, sample_rate: int, progress_cb: ProgressCb
    ) -> Dict[str, np.ndarray]:
        if self._model is None or self._torch is None or self._device is None:
            raise RuntimeError("EngineDemucs.load() must be called before separate()")
        from demucs.apply import apply_model
        import torchaudio.functional as AF

        if audio.ndim == 1:
            audio = audio[:, None]
        audio = np.ascontiguousarray(audio.astype(np.float32))
        # htdemucs is stereo; duplicate mono material to retain a valid model input.
        original_channels = audio.shape[1]
        model_audio = audio if original_channels > 1 else np.repeat(audio, 2, axis=1)
        x = self._torch.from_numpy(model_audio.T[None]).to(self._device)
        if sample_rate != self._model.samplerate:
            x = AF.resample(x, sample_rate, self._model.samplerate)
        progress_cb("separating", 2.0)
        with self._torch.no_grad():
            separated = apply_model(
                self._model, x, split=True, overlap=0.25, progress=False
            )[0].detach().to("cpu").float()
        if sample_rate != self._model.samplerate:
            separated = AF.resample(separated, self._model.samplerate, sample_rate)
        if self._device.type in ("cuda", "mps"):
            getattr(self._torch, self._device.type).synchronize()
        source = {
            name: separated[index].numpy().T[:, :original_channels]
            for index, name in enumerate(self._model.sources)
        }
        if not {"vocals", "drums", "bass", "other"}.issubset(source):
            raise RuntimeError("The managed htdemucs model returned unexpected sources.")
        # Match Stem Studio's canonical three-stem output and enforce mixture
        # consistency after resampling/model overlap-add.
        dialogue = source["vocals"]
        music = source["drums"] + source["bass"]
        effects = audio - dialogue - music
        progress_cb("separating", 100.0)
        return {
            "dialogue": dialogue.astype(np.float32),
            "music": music.astype(np.float32),
            "effects": effects.astype(np.float32),
        }
