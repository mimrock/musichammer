const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');

const runtime = require('./runtime');
const { runBootstrapFlow } = require('./bootstrap');

const SIDECAR_URL = process.env.STEMAPP_SIDECAR_URL || 'http://127.0.0.1:8756';
// Dev: the consolidated eval venv (or dev.sh's STEMAPP_PYTHON). Packaged: the
// venv that bootstrap.js materialized under the per-user data dir.
const SIDECAR_PYTHON = runtime.sidecarPython();
const SIDECAR_CWD = runtime.sidecarDir();

// Per-session auth token: the sidecar rejects requests without it, so a
// random webpage can't drive a localhost API that deletes songs and reads
// the library. To attach to an externally started sidecar, export the same
// STEMAPP_TOKEN to both (or none to the sidecar = auth off).
const SIDECAR_TOKEN = process.env.STEMAPP_TOKEN || crypto.randomBytes(32).toString('hex');

let sidecarProc = null;

// desktop app: stem playback must not require a user gesture per track
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Chromium caps 6 concurrent connections per host. The mixer alone streams
// one <audio> per stem (6 for the recommended model), and the first /chords
// call holds its connection for minutes of analysis — the last-created stem
// stream starves and plays silence until chords finish. Everything talks to
// the local sidecar, so lift the cap for loopback.
app.commandLine.appendSwitch('ignore-connections-limit', '127.0.0.1,localhost');

async function sidecarAlive() {
  try {
    const r = await fetch(`${SIDECAR_URL}/health`, {
      signal: AbortSignal.timeout(1500),
      headers: { 'X-StemApp-Token': SIDECAR_TOKEN },
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureSidecar() {
  if (await sidecarAlive()) return true;
  sidecarProc = spawn(SIDECAR_PYTHON, ['-m', 'stemsep_sidecar'], {
    cwd: SIDECAR_CWD,
    stdio: 'ignore',
    detached: false,
    env: { ...process.env, ...runtime.sidecarEnv(), STEMAPP_TOKEN: SIDECAR_TOKEN },
  });
  sidecarProc.on('exit', (code) => { sidecarProc = null; });
  for (let i = 0; i < 30; i++) {
    await new Promise((res) => setTimeout(res, 500));
    if (await sidecarAlive()) return true;
  }
  return false;
}

function createWindow(sidecarOk) {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    backgroundColor: '#15171c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'),
               { query: { sidecarOk: String(sidecarOk) } });
}

// sync on purpose: the renderer needs the token before its first fetch,
// and preload scripts can't await handle() results at load time
ipcMain.on('auth:token', (e) => { e.returnValue = SIDECAR_TOKEN; });

ipcMain.handle('dialog:openAudio', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Add songs',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio', extensions: ['wav', 'flac', 'mp3', 'ogg', 'm4a', 'aiff', 'aif', 'opus'] },
    ],
  });
  return res.canceled ? [] : res.filePaths;
});

app.whenReady().then(async () => {
  let bootstrapWin = null;
  if (runtime.needsBootstrap()) {
    bootstrapWin = await runBootstrapFlow();
    if (!bootstrapWin) { app.quit(); return; }
  }
  const ok = await ensureSidecar();
  createWindow(ok);
  // only close the bootstrap window now that another window exists, else
  // window-all-closed quits the app between the two
  if (bootstrapWin && !bootstrapWin.isDestroyed()) bootstrapWin.close();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('quit', () => {
  // only kill the sidecar if we were the ones who started it
  if (sidecarProc) sidecarProc.kill('SIGTERM');
});

// SIGTERM (logout, kill) fast-exits Chromium without firing 'quit', which
// would orphan the sidecar on port 8756 — route it through app.quit()
process.on('SIGTERM', () => app.quit());
process.on('SIGINT', () => app.quit());
