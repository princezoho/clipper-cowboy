"""Real Demucs engine adapted from Stem Studio's engine_mvsep.py.

Stem Studio uses Demucs' ``apply_model`` for its MVSEP-CDX23 worker. Clipper
uses Demucs' maintained ``htdemucs`` checkpoints instead: its four sources are
mapped to dialogue (vocals), music (drums + bass + other), and best-effort
residual effects/SFX. The residual preserves the input mixture exactly.
"""
from __future__ import annotations

import os
import sys
from typing import Callable, Dict

import numpy as np

ProgressCb = Callable[[str, float], None]
QUALITY_MODELS = {"fast": "htdemucs", "high": "htdemucs_ft"}


def _log(message: str) -> None:
    print(f"[engine_demucs] {message}", file=sys.stderr, flush=True)


def _device(torch):
    override = os.environ.get("CLIPPER_AUDIO_DEVICE", "").strip().lower()
    if override in ("cpu", "cuda"):
        if override == "cuda" and torch.cuda.is_available():
            return torch.device("cuda")
        if override == "cpu":
            return torch.device("cpu")
    if torch.cuda.is_available():
        return torch.device("cuda")
    # htdemucs hits unsupported large-channel convolution operations on the
    # PyTorch MPS backend. CPU is slower but reliably completes on Apple
    # silicon.
    return torch.device("cpu")


def compose_stems(audio: np.ndarray, source: Dict[str, np.ndarray]) -> Dict[str, np.ndarray]:
    """Map Demucs' four sources to Clipper's three stems without clipping.

    ``other`` contains melodic/harmonic instruments and belongs in music, not
    residual SFX. Effects/SFX is calculated from the original mixture so all
    three returned arrays sum exactly to it (within float precision).
    """
    if not {"vocals", "drums", "bass", "other"}.issubset(source):
        raise RuntimeError("The managed Demucs model returned unexpected sources.")
    dialogue = source["vocals"]
    music = source["drums"] + source["bass"] + source["other"]
    effects = audio - dialogue - music
    return {
        "dialogue": dialogue.astype(np.float32),
        "music": music.astype(np.float32),
        "effects": effects.astype(np.float32),
    }


class EngineDemucs:
    """Stem Studio-derived model invocation using Demucs' official htdemucs."""

    def __init__(self, cache_dir: str | None) -> None:
        self.cache_dir = cache_dir
        self._torch = None
        self._models: Dict[str, object] = {}
        self._device = None

    @staticmethod
    def probe() -> dict:
        import torch

        return {
            "device": str(_device(torch)),
            "torch": str(torch.__version__),
            "engines": ["demucs"],
            "models": QUALITY_MODELS,
        }

    def load(self, quality: str, progress_cb: ProgressCb) -> None:
        model_name = QUALITY_MODELS.get(quality)
        if not model_name:
            raise RuntimeError(f"Unsupported Demucs quality: {quality}")
        if self.cache_dir:
            os.makedirs(self.cache_dir, exist_ok=True)
            # Demucs delegates its verified fixed release URL to torch.hub.
            os.environ["TORCH_HOME"] = self.cache_dir
        import torch
        from demucs.pretrained import get_model

        self._torch = torch
        self._device = _device(torch)
        if quality in self._models:
            return
        _log(f"loading {model_name} on {self._device}")
        progress_cb("loading", 5.0)
        model = get_model(model_name)
        model.eval().to(self._device)
        self._models[quality] = model
        progress_cb("loading", 100.0)

    def separate(
        self, audio: np.ndarray, sample_rate: int, quality: str, progress_cb: ProgressCb
    ) -> Dict[str, np.ndarray]:
        model = self._models.get(quality)
        if model is None or self._torch is None or self._device is None:
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
        if sample_rate != model.samplerate:
            x = AF.resample(x, sample_rate, model.samplerate)
        progress_cb("separating", 2.0)
        with self._torch.no_grad():
            separated = apply_model(
                model, x, split=True, overlap=0.25, progress=False
            )[0].detach().to("cpu").float()
        if sample_rate != model.samplerate:
            separated = AF.resample(separated, model.samplerate, sample_rate)
        if self._device.type in ("cuda", "mps"):
            getattr(self._torch, self._device.type).synchronize()
        source = {
            name: separated[index].numpy().T[:, :original_channels]
            for index, name in enumerate(model.sources)
        }
        progress_cb("separating", 100.0)
        return compose_stems(audio, source)
