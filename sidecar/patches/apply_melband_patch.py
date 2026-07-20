"""Overwrite the installed melband-roformer-infer model module with our
patched copy (adds the mlp_expansion_factor plumbing the becruily guitar
checkpoint needs). Idempotent; run inside the target venv:

    <venv>/bin/python sidecar/patches/apply_melband_patch.py

Pinned against melband-roformer-infer==0.1.1 — if the pin ever moves, re-diff
the upstream file instead of blindly copying this one over it.
"""
import shutil
import sys
from importlib.metadata import version
from pathlib import Path

import mel_band_roformer

EXPECTED = "0.1.1"
got = version("melband-roformer-infer")
if got != EXPECTED:
    sys.exit(f"melband-roformer-infer is {got}, patch was made for {EXPECTED} — re-diff before applying")

target = Path(mel_band_roformer.__file__).parent / "mel_band_roformer.py"
src = Path(__file__).parent / "mel_band_roformer_patched.py"

if "local patch" in target.read_text():
    print(f"already patched: {target}")
else:
    shutil.copy2(src, target)
    print(f"patched: {target}")
