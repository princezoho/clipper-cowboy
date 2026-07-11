#!/usr/bin/env python3
"""Targeted synthetic regression test for Clipper's Demucs stem grouping."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server", "audio"))
from stemstudio_worker.engine_demucs import compose_stems  # noqa: E402

audio = np.array([[0.90, -0.90], [0.35, -0.35]], dtype=np.float32)
vocals = np.array([[0.10, -0.10], [0.05, -0.05]], dtype=np.float32)
drums = np.array([[0.20, -0.20], [0.10, -0.10]], dtype=np.float32)
bass = np.array([[0.15, -0.15], [0.05, -0.05]], dtype=np.float32)
other = np.array([[0.30, -0.30], [0.08, -0.08]], dtype=np.float32)

stems = compose_stems(audio, {
    "vocals": vocals, "drums": drums, "bass": bass, "other": other,
})

np.testing.assert_allclose(stems["music"], drums + bass + other)
np.testing.assert_allclose(stems["effects"], audio - vocals - drums - bass - other, atol=1e-7)
np.testing.assert_allclose(stems["dialogue"] + stems["music"] + stems["effects"], audio, atol=1e-7)

# Source estimates can contain hot peaks. The engine leaves them as float WAV
# samples rather than clipping them before calculating the residual.
hot = compose_stems(
    np.array([[0.9]], dtype=np.float32),
    {name: np.array([[value]], dtype=np.float32) for name, value in {
        "vocals": 0.1, "drums": 0.5, "bass": 0.4, "other": 0.3,
    }.items()},
)
assert hot["music"][0, 0] > 1.0
np.testing.assert_allclose(hot["dialogue"] + hot["music"] + hot["effects"], [[0.9]], atol=1e-7)
print("Demucs music/SFX mapping test passed.")
