// Where python, the venv, and app data live at runtime.
//
// Dev (unpackaged): main.js keeps its dev defaults and dev.sh's env vars —
// nothing here changes existing setups. Packaged: per-user app-data dirs,
// populated by bootstrap.js on first launch. STEMAPP_* env overrides always
// win, mirroring the sidecar's own config.py.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

// Increment whenever an existing packaged environment must be rebuilt.
// Revision 2 repairs v0.1.0/v0.1.1 environments whose later pip steps could
// replace CUDA torch with a CPU-only wheel.
const BOOTSTRAP_REV = 2;

const PYTHON_PIN = {
  version: '3.12.13',
  tag: '20260718',
  urlBase:
    'https://github.com/astral-sh/python-build-standalone/releases/download/20260718/',
  assets: {
    linux: {
      file: 'cpython-3.12.13+20260718-x86_64-unknown-linux-gnu-install_only.tar.gz',
      sha256: '7eea0959fa425c8aff3ea0a1352ee7d01d794b51439ed8f5fcfa017dbc0ec661',
    },
    win32: {
      file: 'cpython-3.12.13+20260718-x86_64-pc-windows-msvc-install_only.tar.gz',
      sha256: '56c9dd9681c4810cb8bfdec277ee2606d8ab17e678e5bc2bd138eb8098e330b6',
    },
  },
};

// Rolling tag on purpose: BtbN purges old versioned releases, so a version pin
// would 404 within months. The resolved build is recorded in the marker file.
const WIN_FFMPEG_URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';

const isWin = process.platform === 'win32';

// Big, non-roaming data: models and the venv are multi-GB, so Windows gets
// %LOCALAPPDATA% (not the roaming %APPDATA% Electron would default to) and
// Linux gets XDG data (not ~/.config).
function dataRoot() {
  if (isWin) {
    return path.join(
      process.env.LOCALAPPDATA || app.getPath('userData'), 'MusicHammer');
  }
  const xdg =
    process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local', 'share');
  return path.join(xdg, 'MusicHammer');
}

const pythonDir = () => path.join(dataRoot(), 'python');
const basePython = () =>
  isWin ? path.join(pythonDir(), 'python.exe')
        : path.join(pythonDir(), 'bin', 'python3');
const venvDir = () => path.join(dataRoot(), 'venv');
const venvBin = () => path.join(venvDir(), isWin ? 'Scripts' : 'bin');
const venvPython = () => path.join(venvBin(), isWin ? 'python.exe' : 'python');
const ffmpegBinDir = () => path.join(dataRoot(), 'ffmpeg', 'bin');
const markerFile = () => path.join(dataRoot(), 'bootstrap.json');

function sidecarDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'sidecar')
    : path.join(__dirname, '..', 'sidecar');
}

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(markerFile(), 'utf8'));
  } catch {
    return null;
  }
}

function markerIsCurrent(marker) {
  return Boolean(marker &&
    marker.bootstrapRev === BOOTSTRAP_REV &&
    marker.pythonTag === PYTHON_PIN.tag);
}

function needsBootstrap() {
  if (!app.isPackaged) return false;
  if (process.env.STEMAPP_PYTHON) return false; // user brought their own env
  const m = readMarker();
  return !(markerIsCurrent(m) && fs.existsSync(venvPython()));
}

function sidecarPython() {
  if (process.env.STEMAPP_PYTHON) return process.env.STEMAPP_PYTHON;
  if (app.isPackaged) return venvPython();
  // dev fallback — dev.sh (or a gitignored dev.local.sh) points
  // STEMAPP_PYTHON at a real inference env; bare python3 won't have torch
  return 'python3';
}

function sidecarEnv() {
  if (!app.isPackaged) return {};
  const env = {
    STEMAPP_DATA_DIR:
      process.env.STEMAPP_DATA_DIR || path.join(dataRoot(), 'data'),
    STEMAPP_TOOLS_BIN: process.env.STEMAPP_TOOLS_BIN || venvBin(),
  };
  // bootstrap drops a static ffmpeg here on Windows; the sidecar assumes
  // ffmpeg/ffprobe on PATH
  if (isWin && fs.existsSync(ffmpegBinDir())) {
    env.PATH = ffmpegBinDir() + path.delimiter + (process.env.PATH || '');
  }
  return env;
}

module.exports = {
  BOOTSTRAP_REV, PYTHON_PIN, WIN_FFMPEG_URL, isWin,
  dataRoot, pythonDir, basePython, venvDir, venvBin, venvPython,
  ffmpegBinDir, markerFile, readMarker, markerIsCurrent, needsBootstrap,
  sidecarDir, sidecarPython, sidecarEnv,
};
