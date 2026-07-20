"""Separation job queue: one worker (CPU-bound work, parallel jobs would just
thrash), subprocess runners, time-based progress/ETA from calibrated
realtime factors, cancellation via process-group kill."""
import os
import queue
import re
import shutil
import signal
import subprocess
import threading
import time
import uuid
from pathlib import Path

from . import config, library, registry

JOBS: dict[str, dict] = {}
_queue: queue.Queue = queue.Queue()
_lock = threading.Lock()
_worker: threading.Thread | None = None


def start_worker() -> None:
    global _worker
    if _worker is None or not _worker.is_alive():
        _worker = threading.Thread(target=_worker_loop, daemon=True)
        _worker.start()


def submit(song_id: str, model_id: str, device: str) -> dict:
    song = library.get_song(song_id)
    if song is None:
        raise KeyError(f"unknown song: {song_id}")
    model = registry.get_model(model_id)
    if model is None:
        raise KeyError(f"unknown model: {model_id}")
    if device not in config.available_devices():
        raise ValueError(f"unsupported device: {device} (have: {config.available_devices()})")
    st = registry.files_status(model)
    if not st["installed"] and not st["managed"]:
        raise ValueError(f"model {model_id} is not installed — download it first")

    job_id = uuid.uuid4().hex[:8]
    factor = registry.get_factor(model_id, device)
    job = {
        "id": job_id, "song_id": song_id, "model_id": model_id, "device": device,
        "status": "queued", "progress": 0.0,
        "eta_s": round(song["duration_s"] * factor),
        "error": None, "created_at": time.time(),
        "started_at": None, "finished_at": None, "wall_s": None, "x_realtime": None,
        "log_file": str(config.LOGS_DIR / f"job_{job_id}.log"),
        "_cancel": threading.Event(), "_proc": None,
    }
    with _lock:
        JOBS[job_id] = job
    _queue.put(job_id)
    return public(job)


def public(job: dict) -> dict:
    return {k: v for k, v in job.items() if not k.startswith("_")}


def get(job_id: str) -> dict | None:
    job = JOBS.get(job_id)
    return public(job) if job else None


def list_jobs() -> list[dict]:
    return [public(j) for j in sorted(JOBS.values(), key=lambda j: j["created_at"])]


def active_for_song(song_id: str) -> dict | None:
    for j in JOBS.values():
        if j["song_id"] == song_id and j["status"] in ("queued", "running"):
            return public(j)
    return None


_IS_WINDOWS = os.name == "nt"


def _spawn_kwargs() -> dict:
    """Each job gets its own process group/tree so cancel kills all of it."""
    if _IS_WINDOWS:
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def _kill_tree(proc: subprocess.Popen, force: bool = False) -> None:
    if _IS_WINDOWS:
        # /T walks the child tree; always /F — the inference CLIs have no
        # graceful-shutdown handling on Windows worth waiting for
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                       capture_output=True)
        return
    try:
        os.killpg(os.getpgid(proc.pid),
                  signal.SIGKILL if force else signal.SIGTERM)
    except ProcessLookupError:
        pass


def cancel(job_id: str) -> dict | None:
    job = JOBS.get(job_id)
    if job is None:
        return None
    job["_cancel"].set()
    proc = job.get("_proc")
    if job["status"] == "running" and proc and proc.poll() is None:
        _kill_tree(proc)
    if job["status"] == "queued":
        job["status"] = "cancelled"
    return public(job)


def _worker_loop() -> None:
    while True:
        job_id = _queue.get()
        job = JOBS.get(job_id)
        if job is None or job["_cancel"].is_set():
            if job:
                job["status"] = "cancelled"
            continue
        try:
            _run(job)
        except Exception as e:
            job["status"] = "failed"
            job["error"] = str(e)
            job["finished_at"] = time.time()


# --- runners -------------------------------------------------------------

def _build_command(job: dict, model: dict, src: Path, out_dir: Path, work: Path) -> list[str]:
    runner = model["runner"]
    if runner == "audio_separator":
        return [str(config.TOOLS_BIN / "audio-separator"), str(src),
                "-m", model["runner_model_name"],
                "--model_file_dir", str(config.MODELS_DIR),
                "--output_dir", str(out_dir),
                "--output_format", "FLAC"]
    if runner in ("bs_roformer_infer", "melband_roformer_infer"):
        # these CLIs only pick up .wav files from the input folder
        in_dir = work / "in"
        in_dir.mkdir(parents=True, exist_ok=True)
        wav = in_dir / f"{src.stem}.wav"
        if src.suffix.lower() == ".wav":
            wav.symlink_to(src)
        else:
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src),
                            "-c:a", "pcm_f32le", str(wav)], check=True)
        cli = "bs-roformer-infer" if runner == "bs_roformer_infer" else "melband-roformer-infer"
        return [str(config.TOOLS_BIN / cli),
                "--model_type", model["arch"],
                "--config_path", str(config.SIDECAR_ROOT / model["config"]),
                "--model_path", str(config.MODELS_DIR / model["files"][0]["name"]),
                "--input_folder", str(in_dir),
                "--store_dir", str(out_dir),
                "--device", job["device"]]
    raise ValueError(f"unknown runner: {runner}")


def _collect_stems(model: dict, src: Path, out_dir: Path) -> dict[str, Path]:
    """Map runner output files to canonical stem names."""
    runner, base = model["runner"], src.stem
    stems: dict[str, Path] = {}
    if runner == "audio_separator":
        for f in out_dir.iterdir():  # e.g. source_(Guitar)_htdemucs_6s.flac
            m = re.search(r"_\(([A-Za-z]+)\)_", f.name)
            if m:
                stems[m.group(1).lower()] = f
    elif runner == "melband_roformer_infer":
        for name, stem in ((f"{base}_Guitar.wav", "guitar"),
                           (f"{base}_instrumental.wav", "rest")):
            p = out_dir / name
            if p.exists():
                stems[stem] = p
    elif runner == "bs_roformer_infer":
        # NB: the package also writes <base>_instrumental.wav = mix minus the
        # FIRST configured stem (bass for SW) — mislabeled, ignore it.
        for stem in model["stems"]:
            p = out_dir / f"{base}_{stem}.wav"
            if p.exists():
                stems[stem] = p
    expected = set(model["stems"])
    if not expected.issubset(stems):
        raise RuntimeError(f"missing stems {expected - set(stems)} in runner output "
                           f"(got: {sorted(p.name for p in out_dir.iterdir())})")
    return stems


def _run(job: dict) -> None:
    song = library.get_song(job["song_id"])
    model = registry.get_model(job["model_id"])
    src = library.source_path(song)
    duration = song["duration_s"]
    factor = registry.get_factor(job["model_id"], job["device"])
    expected = max(duration * factor, 1.0)

    work = config.TMP_DIR / f"job_{job['id']}"
    out_dir = work / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = _build_command(job, model, src, out_dir, work)

    job["status"] = "running"
    job["started_at"] = time.time()
    with open(job["log_file"], "w") as logf:
        logf.write(f"$ {' '.join(cmd)}\n\n")
        logf.flush()
        proc = subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT,
                                **_spawn_kwargs())
        job["_proc"] = proc
        while proc.poll() is None:
            if job["_cancel"].is_set():
                _kill_tree(proc)
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    _kill_tree(proc, force=True)
            elapsed = time.time() - job["started_at"]
            job["progress"] = round(min(elapsed / expected, 0.99), 4)
            job["eta_s"] = round(max(expected - elapsed, 0))
            time.sleep(1)

    job["finished_at"] = time.time()
    wall = job["finished_at"] - job["started_at"]
    if job["_cancel"].is_set():
        job["status"] = "cancelled"
        shutil.rmtree(work, ignore_errors=True)
        return
    if proc.returncode != 0:
        job["status"] = "failed"
        job["error"] = f"runner exited rc={proc.returncode}, see log {job['log_file']}"
        return  # keep work dir for debugging

    stems = _collect_stems(model, src, out_dir)
    stem_dir = config.LIBRARY_DIR / song["id"] / "stems" / model["id"]
    stem_dir.mkdir(parents=True, exist_ok=True)
    rel_files = {}
    for name, path in stems.items():
        target = stem_dir / f"{name}.flac"
        if path.suffix.lower() == ".flac":
            shutil.move(str(path), target)
        else:
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(path),
                            "-c:a", "flac", str(target)], check=True)
        rel_files[name] = str(target.relative_to(config.LIBRARY_DIR / song["id"]))

    x_realtime = round(wall / duration, 3)
    library.add_stems(song["id"], model["id"], rel_files, {
        "model_display_name": model["display_name"],
        "checkpoints": [f["name"] for f in model.get("files", [])] or [model.get("runner_model_name")],
        "license": model.get("license"),
        "device": job["device"],
        "wall_s": round(wall, 1),
        "x_realtime": x_realtime,
        "separated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    })
    registry.update_factor(job["model_id"], job["device"], x_realtime)
    job["wall_s"] = round(wall, 1)
    job["x_realtime"] = x_realtime
    job["progress"] = 1.0
    job["eta_s"] = 0
    job["status"] = "done"
    shutil.rmtree(work, ignore_errors=True)
