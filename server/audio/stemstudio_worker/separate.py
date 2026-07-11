# Derived from Stem Studio's python/stemstudio_worker/separate.py and
# engine_mvsep.py (Apache-2.0), commit fa1bcd092cecca891cb6192d805999165df351e7.
# Clipper modification: the production worker exposes only the real,
# model-backed Demucs path. `engine_stub` is deliberately not importable here.
from __future__ import annotations
import argparse
import json
import os
import sys
import traceback
from typing import Dict
import numpy as np
from .engine_demucs import EngineDemucs

STEM_FILES = {"dialogue": "dialogue.wav", "music": "music.wav", "effects": "effects.wav"}

def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def progress(stage: str):
    return lambda name, percent: emit({"event": "progress", "stage": name or stage, "percent": float(percent)})

def read_wav(source: str):
    import soundfile as sf
    return sf.read(source, always_2d=True, dtype="float32")

def write_wav(destination: str, audio: np.ndarray, sample_rate: int) -> None:
    import soundfile as sf
    sf.write(destination, audio if audio.ndim == 2 else audio[:, None], sample_rate, subtype="FLOAT")

def run(source: str, outdir: str, engine: EngineDemucs) -> Dict[str, str]:
    os.makedirs(outdir, exist_ok=True)
    engine.load(progress("loading"))
    audio, sample_rate = read_wav(source)
    separating = progress("separating")
    separating("separating", 0.0)
    stems = engine.separate(audio, sample_rate, separating)
    separating("separating", 100.0)
    outputs: Dict[str, str] = {}
    writing = progress("writing")
    for index, (key, filename) in enumerate(STEM_FILES.items()):
        target = os.path.join(outdir, filename)
        write_wav(target, stems[key], sample_rate)
        outputs[key] = target
        writing("writing", (index + 1) / len(STEM_FILES) * 100.0)
    return outputs

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="stemstudio_worker.separate")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--download-model", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--outdir")
    parser.add_argument("--engine", default="demucs", choices=["demucs"])
    parser.add_argument("--quality", default="fast", choices=["fast"])
    parser.add_argument("--cache-dir")
    args = parser.parse_args(argv)
    if args.probe:
        try:
            emit(EngineDemucs.probe())
        except Exception as exc:
            emit({"device": "unavailable", "engines": ["demucs"], "error": str(exc)})
        return 0
    try:
        engine = EngineDemucs(cache_dir=args.cache_dir)
        if args.download_model:
            engine.load(progress("loading"))
            emit({"event": "done", "model": "htdemucs"})
            return 0
        if not args.input or not args.outdir:
            parser.error("--input and --outdir are required unless --probe or --download-model is used")
        emit({"event": "done", "outputs": run(args.input, args.outdir, engine)})
        return 0
    except Exception as exc:
        emit({"event": "error", "message": str(exc)})
        print("".join(traceback.format_exception(type(exc), exc, exc.__traceback__)), file=sys.stderr)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
