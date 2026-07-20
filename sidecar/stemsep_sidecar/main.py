"""FastAPI app — the local HTTP interface the Electron shell talks to."""
import secrets
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from . import config, downloader, jobs, library, registry


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.ensure_dirs()
    jobs.start_worker()
    # warm the torch device probe off the request path
    threading.Thread(target=config.available_devices, daemon=True).start()
    yield


app = FastAPI(title="MusicHammer sidecar", version="0.1.0", lifespan=lifespan)

# The Electron renderer loads from file://, so its Origin is the literal
# string "null" — that's the only origin we serve. Any file:// page or
# sandboxed iframe also sends "null", which is why CORS alone isn't the
# protection here: the token below is.
app.add_middleware(CORSMiddleware, allow_origins=["null"], allow_methods=["*"],
                   allow_headers=["X-StemApp-Token", "Content-Type"])


@app.middleware("http")
async def require_token(request: Request, call_next):
    """Reject anything that doesn't carry the session token (when one is set).
    <audio> elements can't send headers, so the token is also accepted as a
    query param. OPTIONS passes through: CORS preflights never carry custom
    headers, respond with no data, and are answered by CORSMiddleware anyway
    (which runs inside this middleware, so blocking them here would break
    every renderer request)."""
    if config.TOKEN and request.method != "OPTIONS":
        supplied = (request.headers.get("x-stemapp-token")
                    or request.query_params.get("token") or "")
        if not secrets.compare_digest(supplied, config.TOKEN):
            return JSONResponse({"detail": "missing or bad auth token"},
                                status_code=401)
    return await call_next(request)


class IngestRequest(BaseModel):
    path: str
    force: bool = False  # add even if the same audio is already in the library


class JobRequest(BaseModel):
    song_id: str
    model_id: str
    device: str = "cpu"


@app.get("/health")
def health():
    return {"ok": True, "version": app.version, "data_dir": str(config.DATA_DIR),
            "devices": config.available_devices()}


@app.get("/models")
def list_models():
    out = []
    for m in registry.models():
        entry = {k: v for k, v in m.items() if k != "files"}
        entry["size_bytes"] = sum(f.get("size", 0) for f in m.get("files", []))
        entry.update(registry.files_status(m))
        entry["download"] = downloader.status(m["id"])
        out.append(entry)
    return out


@app.post("/models/{model_id}/download")
def download_model(model_id: str):
    if registry.get_model(model_id) is None:
        raise HTTPException(404, "unknown model")
    res = downloader.start(model_id)
    if res.get("error"):
        raise HTTPException(400, res["error"])
    return res


@app.post("/models/{model_id}/verify")
def verify_model(model_id: str):
    if registry.get_model(model_id) is None:
        raise HTTPException(404, "unknown model")
    return downloader.verify(model_id)


@app.get("/songs")
def list_songs():
    return library.list_songs()


@app.post("/songs")
def ingest_song(req: IngestRequest):
    try:
        return library.ingest(req.path, force=req.force)
    except library.DuplicateSongError as e:
        # structured detail so the UI can offer "add anyway" (retry with force)
        raise HTTPException(409, {"duplicate": True,
                                  "existing_id": e.existing["id"],
                                  "existing_title": e.existing["title"],
                                  "message": str(e)})
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(400, str(e))


@app.get("/songs/{song_id}")
def get_song(song_id: str):
    song = library.get_song(song_id)
    if song is None:
        raise HTTPException(404, "unknown song")
    return song


@app.get("/songs/{song_id}/bpm")
def song_bpm(song_id: str):
    # first call may block for tens of seconds (whole-song analysis); FastAPI
    # runs sync handlers in a threadpool, so other requests keep flowing
    try:
        return library.bpm(song_id)
    except KeyError:
        raise HTTPException(404, "unknown song")


@app.get("/songs/{song_id}/chords")
def song_chords(song_id: str):
    # same lazy pattern as /bpm — the first call analyzes the whole song
    try:
        return library.chords(song_id)
    except KeyError:
        raise HTTPException(404, "unknown song")


@app.delete("/songs/{song_id}")
def delete_song(song_id: str):
    if jobs.active_for_song(song_id):
        raise HTTPException(409, "a separation is still running for this song — "
                                 "cancel it first")
    try:
        freed = library.delete_song(song_id)
    except KeyError:
        raise HTTPException(404, "unknown song")
    return {"deleted": song_id, "freed_bytes": freed}


def _stem_or_404(song_id: str, model_id: str, stem: str):
    song = library.get_song(song_id)
    if song is None:
        raise HTTPException(404, "unknown song")
    p = library.stem_path(song, model_id, stem)
    if p is None:
        raise HTTPException(404, "no such stem")
    return p


@app.get("/songs/{song_id}/stems/{model_id}/{stem}/audio")
def stem_audio(song_id: str, model_id: str, stem: str):
    return FileResponse(_stem_or_404(song_id, model_id, stem), media_type="audio/flac")


@app.get("/songs/{song_id}/stems/{model_id}/{stem}/peaks")
def stem_peaks(song_id: str, model_id: str, stem: str, points: int = 1000):
    return library.peaks(_stem_or_404(song_id, model_id, stem), min(max(points, 50), 4000))


@app.get("/jobs")
def list_jobs():
    return jobs.list_jobs()


@app.post("/jobs")
def create_job(req: JobRequest):
    try:
        return jobs.submit(req.song_id, req.model_id, req.device)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "unknown job")
    return job


@app.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    job = jobs.cancel(job_id)
    if job is None:
        raise HTTPException(404, "unknown job")
    return job
