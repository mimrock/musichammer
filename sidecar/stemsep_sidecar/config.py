"""Paths and settings. Everything is overridable via env so the frozen
sidecar build and the Electron shell can relocate all state."""
import os
import subprocess
import sys
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent   # <repo>/sidecar
APP_ROOT = SIDECAR_ROOT.parent                          # <repo>

DATA_DIR = Path(os.environ.get("STEMAPP_DATA_DIR", APP_ROOT / "data"))
MODELS_DIR = Path(os.environ.get("STEMAPP_MODELS_DIR", DATA_DIR / "models"))
LIBRARY_DIR = Path(os.environ.get("STEMAPP_LIBRARY_DIR", DATA_DIR / "library"))
LOGS_DIR = DATA_DIR / "logs"
TMP_DIR = DATA_DIR / "tmp"
CALIBRATION_FILE = DATA_DIR / "calibration.json"
REGISTRY_FILE = Path(os.environ.get("STEMAPP_REGISTRY", SIDECAR_ROOT / "registry.json"))

# Directory holding the inference CLIs (audio-separator, bs-roformer-infer,
# melband-roformer-infer). Default: the bin dir of the python running this
# sidecar — in every real setup (dev venv or the bootstrap-built one) that's
# the same env the CLIs live in. The Electron shell sets STEMAPP_TOOLS_BIN
# explicitly anyway.
TOOLS_BIN = Path(os.environ.get("STEMAPP_TOOLS_BIN") or Path(sys.executable).parent)

HOST = os.environ.get("STEMAPP_HOST", "127.0.0.1")
PORT = int(os.environ.get("STEMAPP_PORT", "8756"))

# Per-session auth token. The Electron main process generates one and passes
# it down when spawning us; every request must then carry it. Empty (e.g. a
# standalone `python -m stemsep_sidecar` for API work) = auth disabled, which
# also keeps /docs usable in dev.
TOKEN = os.environ.get("STEMAPP_TOKEN", "")

SUPPORTED_AUDIO_EXT = {".wav", ".flac", ".mp3", ".ogg", ".m4a", ".aiff", ".aif", ".opus"}

_devices: list[str] | None = None


def available_devices() -> list[str]:
    """Ask the inference env's torch what it can run on. Subprocess (not an
    in-process import) keeps torch's multi-second import out of the sidecar;
    result is cached for the process lifetime. Preferred device first."""
    global _devices
    if _devices is None:
        devs = ["cpu"]
        try:
            out = subprocess.run(
                [str(TOOLS_BIN / "python"), "-c",
                 "import torch\n"
                 "print('cuda' if torch.cuda.is_available() else '')\n"
                 "m = getattr(torch.backends, 'mps', None)\n"
                 "print('mps' if m is not None and m.is_available() else '')"],
                capture_output=True, text=True, timeout=120)
            found = [d for d in out.stdout.split() if d]
            devs = found + devs
        except Exception:
            pass  # torch probe failing must never take the sidecar down
        _devices = devs
    return _devices


def ensure_dirs() -> None:
    for d in (DATA_DIR, MODELS_DIR, LIBRARY_DIR, LOGS_DIR, TMP_DIR):
        d.mkdir(parents=True, exist_ok=True)
