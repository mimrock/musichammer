"""Song library: library/<slug>/source.<ext> + stems/<model>/<stem>.flac + manifest.json"""
import hashlib
import json
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

from . import config

_lock = threading.Lock()


def probe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def _manifest_path(song_id: str) -> Path:
    return config.LIBRARY_DIR / song_id / "manifest.json"


def _write_manifest(song_id: str, manifest: dict) -> None:
    p = _manifest_path(song_id)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(manifest, indent=2))
    tmp.replace(p)


def get_song(song_id: str) -> dict | None:
    p = _manifest_path(song_id)
    if not p.exists():
        return None
    return json.loads(p.read_text())


def _dir_bytes(d: Path) -> int:
    return sum(p.stat().st_size for p in d.rglob("*") if p.is_file())


def list_songs() -> list[dict]:
    songs = []
    if config.LIBRARY_DIR.exists():
        for d in sorted(config.LIBRARY_DIR.iterdir()):
            m = get_song(d.name)
            if m:
                m["disk_bytes"] = _dir_bytes(d)
                songs.append(m)
    return songs


def delete_song(song_id: str) -> int:
    """Remove the song's whole library dir (source copy, stems, peaks caches).
    Returns freed bytes. Only direct children of LIBRARY_DIR with a manifest
    are deletable, so a crafted song_id can't reach outside the library."""
    with _lock:
        song_dir = (config.LIBRARY_DIR / song_id).resolve()
        if (song_dir.parent != config.LIBRARY_DIR.resolve()
                or not (song_dir / "manifest.json").is_file()):
            raise KeyError(song_id)
        freed = _dir_bytes(song_dir)
        shutil.rmtree(song_dir)
        return freed


class DuplicateSongError(Exception):
    def __init__(self, existing: dict):
        self.existing = existing
        super().__init__(f"already in the library as “{existing['title']}”")


def _file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def _find_duplicate(size: int, sha256: str) -> dict | None:
    """Match by content hash. File size is a cheap pre-filter, so at most
    same-sized library copies ever get hashed; manifests from before the
    hash field get it backfilled on that occasion."""
    if not config.LIBRARY_DIR.exists():
        return None
    for d in sorted(config.LIBRARY_DIR.iterdir()):
        m = get_song(d.name)
        if m is None:
            continue
        src = config.LIBRARY_DIR / m["id"] / m.get("source_file", "")
        if not src.is_file() or src.stat().st_size != size:
            continue
        if not m.get("source_sha256"):
            m["source_sha256"] = _file_sha256(src)
            _write_manifest(m["id"], m)
        if m["source_sha256"] == sha256:
            return m
    return None


def ingest(path_str: str, force: bool = False) -> dict:
    src = Path(path_str).expanduser().resolve()
    if not src.is_file():
        raise FileNotFoundError(f"not a file: {src}")
    if src.suffix.lower() not in config.SUPPORTED_AUDIO_EXT:
        raise ValueError(f"unsupported audio type: {src.suffix}")
    sha256 = _file_sha256(src)  # before the lock — may take a moment on big files

    slug = re.sub(r"[^a-z0-9_-]+", "-", src.stem.lower()).strip("-") or "song"
    with _lock:
        if not force:
            dup = _find_duplicate(src.stat().st_size, sha256)
            if dup is not None:
                raise DuplicateSongError(dup)
        song_id, n = slug, 2
        while (config.LIBRARY_DIR / song_id).exists():
            song_id, n = f"{slug}-{n}", n + 1
        song_dir = config.LIBRARY_DIR / song_id
        song_dir.mkdir(parents=True)

    dest = song_dir / f"source{src.suffix.lower()}"
    shutil.copy2(src, dest)
    manifest = {
        "id": song_id,
        "title": src.stem,
        "source_file": dest.name,
        "original_path": str(src),
        "source_sha256": sha256,
        "duration_s": round(probe_duration(dest), 2),
        "added_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "stems": {},
    }
    _write_manifest(song_id, manifest)
    return manifest


def source_path(song: dict) -> Path:
    return config.LIBRARY_DIR / song["id"] / song["source_file"]


def _estimate_bpm(path: Path) -> int | None:
    """Median of windowed tempo estimates over the whole song. Single windows
    flip metric level (double/half-time) on quiet or double-kick passages, so
    no per-chunk value can be shown to the user; the cross-window median is
    stable (steady studio material collapses to one value). None = no
    detectable beat (e.g. test tones) — the UI then stays percent-only."""
    import librosa
    import numpy as np
    y, sr = librosa.load(str(path), sr=22050, mono=True)
    win, hop = 15 * sr, int(7.5 * sr)
    tempos = []
    for s in range(0, max(len(y) - win, 1), hop):
        t, _ = librosa.beat.beat_track(y=y[s:s + win], sr=sr)
        t = float(np.atleast_1d(t)[0])
        if t > 0:
            tempos.append(t)
    return round(float(np.median(tempos))) if tempos else None


def bpm(song_id: str) -> dict:
    """Reference tempo for the mixer's varispeed control, cached in the
    manifest (null caches too — a beatless file is never re-analyzed)."""
    song = get_song(song_id)
    if song is None:
        raise KeyError(song_id)
    if "bpm" not in song:
        value = _estimate_bpm(source_path(song))  # slow — outside the lock
        with _lock:
            song = get_song(song_id)
            if song is None:
                raise KeyError(song_id)
            song["bpm"] = value
            _write_manifest(song_id, song)
    return {"bpm": song["bpm"]}


_CHORD_PC = {p: i for i, p in enumerate(
    ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"])}


def _estimate_chords(path: Path) -> list:
    """madmom CNN+CRF chord segments, cleaned up for an honest display.
    The recognizer only knows maj/min, so a distorted power chord is forced
    into one of them (usually maj — the root's 5th harmonic IS its major
    third). When the chroma carries little energy on the labeled third, the
    quality claim is demoted to root+"5"; calibrated against published charts,
    real triads measure >0.75 on that ratio, bare fifths <0.5. A#/D# are
    spelled Bb/Eb. [start, end, label] triplets; [] = nothing tonal found."""
    import librosa
    import numpy as np
    from madmom.features.chords import (CNNChordFeatureProcessor,
                                        CRFChordRecognitionProcessor)
    segments = CRFChordRecognitionProcessor()(CNNChordFeatureProcessor()(str(path)))
    y, sr = librosa.load(str(path), sr=22050, mono=True)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=2048)
    fps = sr / 2048
    out = []
    for start, end, label in segments:
        if label == "N":
            continue
        root_name, _, quality = label.partition(":")
        root = _CHORD_PC[root_name]
        c = chroma[:, int(start * fps):int(end * fps)]
        if c.shape[1]:
            m = c.mean(axis=1)
            third = m[(root + (4 if quality == "maj" else 3)) % 12]
            if third < 0.55 * (m[root] + m[(root + 7) % 12]) / 2:
                quality = "5"
        name = ({"A#": "Bb", "D#": "Eb"}.get(root_name, root_name)
                + {"maj": "", "min": "m", "5": "5"}[quality])
        # demotion can equalize neighbors (G:maj|G:min -> one G5 stretch)
        if out and out[-1][2] == name and start - out[-1][1] < 0.1:
            out[-1][1] = round(float(end), 2)
        else:
            out.append([round(float(start), 2), round(float(end), 2), name])
    return out


def chords(song_id: str) -> dict:
    """Chord lane for the mixer, cached in the manifest ([] caches too — an
    atonal file is never re-analyzed)."""
    song = get_song(song_id)
    if song is None:
        raise KeyError(song_id)
    if "chords" not in song:
        try:
            value = _estimate_chords(source_path(song))  # slow — outside the lock
        except ImportError:
            # build without chord support (madmom needs git + a compiler at
            # install time; Windows ships without it) — report an empty lane
            # but do NOT cache it, so adding madmom later just works
            return {"chords": []}
        with _lock:
            song = get_song(song_id)
            if song is None:
                raise KeyError(song_id)
            song["chords"] = value
            _write_manifest(song_id, song)
    return {"chords": song["chords"]}


def stem_path(song: dict, model_id: str, stem: str) -> Path | None:
    """Resolve a stem to its file via the manifest (no client-supplied paths
    touch the filesystem, so no traversal risk)."""
    rel = song.get("stems", {}).get(model_id, {}).get("files", {}).get(stem)
    if rel is None:
        return None
    p = config.LIBRARY_DIR / song["id"] / rel
    return p if p.is_file() else None


def peaks(path: Path, points: int = 1000) -> dict:
    """Mono max-abs peak per bucket, cached next to the stem file. Cheap
    enough to compute lazily (soundfile reads FLAC natively)."""
    cache = path.parent / f".peaks_{path.stem}_{points}.json"
    if cache.exists() and cache.stat().st_mtime >= path.stat().st_mtime:
        return json.loads(cache.read_text())
    import numpy as np
    import soundfile as sf
    with sf.SoundFile(str(path)) as f:
        frames = f.frames
        bucket = max(frames // points, 1)
        out = []
        while True:
            block = f.read(bucket * 256, dtype="float32", always_2d=True)
            if block.shape[0] == 0:
                break
            mono = np.abs(block).max(axis=1)
            n = (mono.shape[0] // bucket) * bucket
            if n:
                out.extend(mono[:n].reshape(-1, bucket).max(axis=1).tolist())
            # tail of the final partial block
            if mono.shape[0] > n:
                out.append(float(mono[n:].max()))
        duration = frames / f.samplerate
    result = {"duration_s": round(duration, 3),
              "peaks": [round(p, 4) for p in out[:points + 2]]}
    cache.write_text(json.dumps(result))
    return result


def add_stems(song_id: str, model_id: str, stems: dict[str, str], meta: dict) -> None:
    with _lock:
        manifest = get_song(song_id)
        if manifest is None:
            raise KeyError(song_id)
        manifest["stems"][model_id] = {"files": stems, **meta}
        _write_manifest(song_id, manifest)
