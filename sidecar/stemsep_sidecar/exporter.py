"""Stem export: lossless FLAC/WAV, or lossy MP3 when small files matter.

Individual FLAC stems are copied byte-for-byte. WAV stems are converted
losslessly, MP3 stems are encoded at a fixed 256 kbps, and combined exports
are mixed in bounded-memory blocks with only downward overload protection
when the selected signals would clip.

Every failure a user can run into is raised as a ValueError (KeyError for an
unknown song or stem) whose message is fit to show in the app.
"""
import math
import os
import re
import secrets
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import library


FORMATS = {"flac", "wav", "mp3"}
# One fixed lossy setting: whoever picks MP3 over FLAC wants a small file.
MP3_BITRATE_KBPS = 256
# 256 kbps only exists in MPEG-1 Layer III, which is limited to these rates.
MP3_SAMPLERATES = {32000, 44100, 48000}
MODES = {"separate", "mix"}
_INVALID_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED_FILENAME = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)",
                                re.IGNORECASE)


class ExportConflictError(Exception):
    """Raised before writing when one or more destination files exist."""

    def __init__(self, paths: list[Path]):
        self.paths = paths
        count = len(paths)
        super().__init__(f"{count} export file{'s' if count != 1 else ''} already exist")


def safe_filename_component(value: str, fallback: str = "audio") -> str:
    """Return a portable Windows/Linux filename component."""
    value = _INVALID_FILENAME.sub(" ", str(value))
    value = re.sub(r"\s+", " ", value).strip(" .")
    if not value:
        value = fallback
    if _RESERVED_FILENAME.match(value):
        value = f"_{value}"
    # Leave room for " - stem.ext" under common 255-byte filename limits.
    return value[:120].rstrip(" .") or fallback


def _sources(song_id: str, model_id: str, stems: list[str]) -> tuple[dict, list[tuple[str, Path]]]:
    song = library.get_song(song_id)
    if song is None:
        raise KeyError("unknown song")
    if model_id not in song.get("stems", {}):
        raise KeyError("unknown stem set")
    if not stems:
        raise ValueError("select at least one stem")
    if len(set(stems)) != len(stems):
        raise ValueError("duplicate stems are not allowed")

    resolved = []
    for stem in stems:
        source = library.stem_path(song, model_id, stem)
        if source is None:
            raise KeyError(f"no such stem: {stem}")
        resolved.append((stem, source))
    return song, resolved


def _temp_path(parent: Path, suffix: str) -> Path:
    """Reserve a hidden staging file next to its final location.

    It is created like any saved file (0666 minus the umask) because it is
    renamed into place as the export; tempfile.mkstemp would leave the result
    readable by its owner only.
    """
    while True:
        path = parent / f".musichammer-export-{secrets.token_hex(6)}{suffix}"
        try:
            os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666))
        except FileExistsError:
            continue
        return path


def _wav_subtype(source: Path) -> str:
    import soundfile as sf

    with sf.SoundFile(str(source)) as audio:
        return audio.subtype if audio.subtype in {
            "PCM_U8", "PCM_16", "PCM_24", "PCM_32", "FLOAT", "DOUBLE",
        } else "PCM_24"


def _check_sources(sources: list[tuple[str, Path]], export_format: str) -> None:
    """Reject, before anything is written, stems that cannot be exported."""
    import soundfile as sf

    if export_format == "mp3" and "MP3" not in sf.available_formats():
        raise ValueError("MP3 export is not available in this installation")
    for stem, path in sources:
        try:
            with sf.SoundFile(str(path)) as audio:
                samplerate, channels = audio.samplerate, audio.channels
        except (OSError, sf.SoundFileError) as error:
            raise ValueError(f"the {stem} stem could not be read: {error}") from error
        if export_format == "mp3" and (samplerate not in MP3_SAMPLERATES
                                       or channels > 2):
            raise ValueError(
                f"MP3 export needs mono or stereo audio at 32, 44.1, or "
                f"48 kHz; {stem} is {channels} ch at {samplerate} Hz")


def _open_output(target: Path, export_format: str, samplerate: int,
                 channels: int, subtype: str = "PCM_24"):
    import soundfile as sf

    if export_format == "mp3":
        # libsndfile picks the constant bitrate by interpolating MPEG-1's
        # 320..32 kbps range with the 0..1 compression level.
        return sf.SoundFile(
            str(target), mode="w", samplerate=samplerate, channels=channels,
            format="MP3", subtype="MPEG_LAYER_III", bitrate_mode="CONSTANT",
            compression_level=(320 - MP3_BITRATE_KBPS) / (320 - 32))
    return sf.SoundFile(str(target), mode="w", samplerate=samplerate,
                        channels=channels, format=export_format.upper(),
                        subtype=subtype)


def _convert(source: Path, target: Path, export_format: str) -> None:
    import soundfile as sf

    subtype = _wav_subtype(source) if export_format == "wav" else "PCM_24"
    with sf.SoundFile(str(source)) as src:
        with _open_output(target, export_format, src.samplerate, src.channels,
                          subtype) as out:
            while True:
                block = src.read(65536, dtype="float32", always_2d=True)
                if not len(block):
                    break
                out.write(block)


def _write_separate(sources: list[tuple[str, Path]], temps: list[Path],
                    export_format: str) -> None:
    """Write one file per stem, encoding the stems side by side.

    MP3 encoding takes around ten seconds per stem and libsndfile releases
    the GIL while it works, so threads cut a six-stem export to roughly the
    time of one stem.
    """
    def write(source: Path, temp: Path) -> None:
        if export_format == "flac":
            # Contents only: the export is a new file, so it gets today's
            # date and ordinary permissions rather than the library stem's.
            shutil.copyfile(source, temp)
        else:
            _convert(source, temp, export_format)

    workers = min(len(sources), os.cpu_count() or 1)
    # Leaving the block waits for every running stem, so the caller never
    # removes a staging file that is still being written.
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(write, source, temp)
                   for (_, source), temp in zip(sources, temps)]
        try:
            for future in futures:
                future.result()
        except BaseException:
            for future in futures:
                future.cancel()
            raise


def _audio_shape(sources: list[tuple[str, Path]]) -> tuple[int, int, int]:
    import soundfile as sf

    samplerate = channels = None
    frames = 0
    for _, path in sources:
        with sf.SoundFile(str(path)) as audio:
            if samplerate is None:
                samplerate, channels = audio.samplerate, audio.channels
            elif (audio.samplerate, audio.channels) != (samplerate, channels):
                raise ValueError("selected stems do not share a sample rate and channel layout")
            frames = max(frames, audio.frames)
    return samplerate, channels, frames


def _mix_pass(sources: list[tuple[str, Path]], gains: dict[str, float],
              frames: int, channels: int, output=None, scale: float = 1.0) -> float:
    import numpy as np
    import soundfile as sf

    inputs = [sf.SoundFile(str(path)) for _, path in sources]
    peak = 0.0
    try:
        position = 0
        while position < frames:
            block_frames = min(65536, frames - position)
            mixed = np.zeros((block_frames, channels), dtype="float32")
            for (stem, _), audio in zip(sources, inputs):
                block = audio.read(block_frames, dtype="float32", always_2d=True)
                mixed[:len(block)] += block * gains[stem]
            if len(mixed):
                peak = max(peak, float(np.max(np.abs(mixed))))
            if output is not None:
                output.write(mixed * scale)
            position += block_frames
    finally:
        for audio in inputs:
            audio.close()
    return peak


def _write_mix(sources: list[tuple[str, Path]], gains: dict[str, float],
               target: Path, export_format: str) -> float:
    samplerate, channels, frames = _audio_shape(sources)
    peak = _mix_pass(sources, gains, frames, channels)
    scale = min(1.0, 0.999 / peak) if peak > 0 else 1.0
    with _open_output(target, export_format, samplerate, channels) as out:
        _mix_pass(sources, gains, frames, channels, output=out, scale=scale)
    return scale


def export_stems(song_id: str, model_id: str, stems: list[str], mode: str,
                 export_format: str, destination: str,
                 gains: dict[str, float] | None = None,
                 overwrite: bool = False) -> dict:
    """Export selected stems and return their final paths.

    ``destination`` is a directory for separate files and a complete filename
    for a mix. The Electron shell obtains it from a native user-driven dialog.
    """
    mode = mode.lower()
    export_format = export_format.lower()
    if mode not in MODES:
        raise ValueError("export mode must be separate or mix")
    if export_format not in FORMATS:
        raise ValueError("export format must be FLAC, WAV, or MP3")

    import soundfile as sf

    song, sources = _sources(song_id, model_id, stems)
    _check_sources(sources, export_format)
    destination_path = Path(destination).expanduser()
    if not destination_path.is_absolute():
        raise ValueError("export destination must be an absolute path")

    title = safe_filename_component(song.get("title", "audio"))
    if mode == "separate":
        parent = destination_path.resolve()
        if not parent.is_dir():
            raise ValueError("export destination folder does not exist")
        targets = [
            parent / f"{title} - {safe_filename_component(stem, 'stem')}.{export_format}"
            for stem, _ in sources
        ]
    else:
        parent = destination_path.parent.resolve()
        if not parent.is_dir():
            raise ValueError("export destination folder does not exist")
        target = destination_path
        if target.suffix.lower() != f".{export_format}":
            raise ValueError(f"combined export filename must end in .{export_format}")
        targets = [target]

    if len({str(target).casefold() for target in targets}) != len(targets):
        raise ValueError("selected stems produce duplicate filenames")
    conflicts = [target for target in targets if target.exists()]
    if conflicts and not overwrite:
        raise ExportConflictError(conflicts)

    gain_values = gains or {}
    clean_gains = {}
    for stem, _ in sources:
        value = float(gain_values.get(stem, 1.0))
        if not math.isfinite(value) or not 0 <= value <= 1.25:
            raise ValueError(f"invalid volume for stem: {stem}")
        clean_gains[stem] = value

    staged: list[tuple[Path, Path]] = []
    scale = 1.0
    try:
        for target in targets:
            staged.append((_temp_path(parent, f".{export_format}"), target))
        temps = [temp for temp, _ in staged]
        if mode == "separate":
            _write_separate(sources, temps, export_format)
        else:
            scale = _write_mix(sources, clean_gains, temps[0], export_format)

        for temp, target in staged:
            temp.replace(target)
    except OSError as error:
        raise ValueError(f"could not write the export to {parent}: "
                         f"{error.strerror or error}") from error
    except sf.SoundFileError as error:
        # The stems were readable a moment ago, so this is the output side;
        # libsndfile reports a full disk as nothing more than "System error."
        raise ValueError(f"could not write the export to {parent}: {error} "
                         f"The disk may be full.") from error
    finally:
        for temp, _ in staged:
            temp.unlink(missing_ok=True)

    return {
        "files": [str(target) for target in targets],
        "mode": mode,
        "format": export_format,
        "overload_scale": round(scale, 6),
    }
