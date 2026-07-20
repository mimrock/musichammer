"""Model registry + per-machine speed calibration."""
import json
import threading

from . import config

_lock = threading.Lock()
_registry = None


def load() -> dict:
    global _registry
    if _registry is None:
        _registry = json.loads(config.REGISTRY_FILE.read_text())
    return _registry


def models() -> list[dict]:
    return load()["models"]


def get_model(model_id: str) -> dict | None:
    return next((m for m in models() if m["id"] == model_id), None)


def files_status(model: dict) -> dict:
    """Cheap presence/size check. Hash verification is a separate, explicit
    step (downloader.verify) because hashing 700 MB on every /models poll
    would be silly."""
    if model.get("managed_by_runner"):
        # audio-separator downloads these itself on first use; presence of the
        # registry filename in MODELS_DIR means it already did.
        present = (config.MODELS_DIR / model["runner_model_name"]).exists()
        return {"installed": present, "managed": True}
    ok = True
    for f in model.get("files", []):
        p = config.MODELS_DIR / f["name"]
        if not p.exists() or (f.get("size") and p.stat().st_size != f["size"]):
            ok = False
            break
    return {"installed": ok, "managed": False}


# --- calibration: measured x-realtime per (model, device), EMA-updated ---

def _load_calibration() -> dict:
    if config.CALIBRATION_FILE.exists():
        return json.loads(config.CALIBRATION_FILE.read_text())
    return {}


def get_factor(model_id: str, device: str) -> float:
    cal = _load_calibration()
    factor = cal.get(model_id, {}).get(device)
    if factor:
        return factor
    m = get_model(model_id) or {}
    return m.get("cpu_x_realtime", 1.0)


def update_factor(model_id: str, device: str, measured: float, alpha: float = 0.5) -> None:
    with _lock:
        cal = _load_calibration()
        prev = cal.get(model_id, {}).get(device)
        new = measured if prev is None else alpha * measured + (1 - alpha) * prev
        cal.setdefault(model_id, {})[device] = round(new, 3)
        tmp = config.CALIBRATION_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(cal, indent=2))
        tmp.replace(config.CALIBRATION_FILE)
