"""SHA256-verified model checkpoint downloader (from the original HF repos —
the app never rehosts weights)."""
import hashlib
import threading
import urllib.request

from . import config, registry

CHUNK = 1024 * 1024
_state: dict[str, dict] = {}
_lock = threading.Lock()


def status(model_id: str) -> dict:
    with _lock:
        return dict(_state.get(model_id, {"status": "idle"}))


def _set(model_id: str, **kw) -> None:
    with _lock:
        _state.setdefault(model_id, {}).update(kw)


def _sha256(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
    return h.hexdigest()


def verify(model_id: str) -> dict:
    """Full hash check of all files of an installed model."""
    m = registry.get_model(model_id)
    if not m or m.get("managed_by_runner"):
        return {"verified": None, "detail": "no registry-managed files for this model"}
    results = {}
    for f in m.get("files", []):
        p = config.MODELS_DIR / f["name"]
        results[f["name"]] = p.exists() and _sha256(p) == f["sha256"]
    return {"verified": all(results.values()), "files": results}


def start(model_id: str) -> dict:
    m = registry.get_model(model_id)
    if not m:
        return {"error": "unknown model"}
    if m.get("managed_by_runner"):
        return {"error": "weights are auto-downloaded by the runner on first use"}
    st = status(model_id)
    if st.get("status") == "downloading":
        return st
    _set(model_id, status="downloading", progress=0.0, bytes_done=0,
         bytes_total=sum(f.get("size", 0) for f in m.get("files", [])), error=None)
    threading.Thread(target=_download, args=(m,), daemon=True).start()
    return status(model_id)


def _download(m: dict) -> None:
    model_id = m["id"]
    total = sum(f.get("size", 0) for f in m.get("files", []))
    done_before = 0
    try:
        for f in m.get("files", []):
            dest = config.MODELS_DIR / f["name"]
            if dest.exists() and dest.stat().st_size == f.get("size") and _sha256(dest) == f["sha256"]:
                done_before += f.get("size", 0)
                continue
            part = dest.with_suffix(dest.suffix + ".part")
            h = hashlib.sha256()
            req = urllib.request.Request(f["url"], headers={"User-Agent": "musichammer-sidecar/0.1"})
            with urllib.request.urlopen(req, timeout=60) as r, open(part, "wb") as out:
                fetched = 0
                while chunk := r.read(CHUNK):
                    out.write(chunk)
                    h.update(chunk)
                    fetched += len(chunk)
                    if total:
                        _set(model_id, bytes_done=done_before + fetched,
                             progress=round((done_before + fetched) / total, 4))
            if h.hexdigest() != f["sha256"]:
                part.unlink(missing_ok=True)
                raise ValueError(f"sha256 mismatch for {f['name']} — refusing to keep the file")
            part.replace(dest)
            done_before += f.get("size", 0)
        _set(model_id, status="done", progress=1.0)
    except Exception as e:  # surfaced via /models, not raised into the void
        _set(model_id, status="failed", error=str(e))
