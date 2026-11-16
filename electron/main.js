const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
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

function safeExportName(value) {
  const cleaned = String(value || 'audio')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[ .]+$/g, '')
    .trim()
    .slice(0, 120);
  return cleaned || 'audio';
}

ipcMain.handle('dialog:exportAudio', async (_event, options) => {
  const mode = options && options.mode;
  const format = options && options.format;
  if (!['separate', 'mix'].includes(mode) || !['flac', 'wav', 'mp3'].includes(format)) {
    throw new Error('Invalid export options');
  }

  const win = BrowserWindow.getFocusedWindow();
  const musicDir = app.getPath('music');
  if (mode === 'separate') {
    // No promptToCreate: on Windows it hands back a typed-in folder that
    // does not exist yet. The picker has its own "New folder" button.
    const properties = ['openDirectory'];
    if (process.platform === 'darwin') properties.push('createDirectory');
    const res = await dialog.showOpenDialog(win, {
      title: 'Export stem files',
      buttonLabel: 'Export here',
      defaultPath: musicDir,
      properties,
    });
    return res.canceled ? null : { path: res.filePaths[0], overwriteConfirmed: false };
  }

  const extension = `.${format}`;
  const defaultName = `${safeExportName(options.title)} - mix${extension}`;
  const res = await dialog.showSaveDialog(win, {
    title: 'Export combined track',
    buttonLabel: 'Export',
    defaultPath: path.join(musicDir, defaultName),
    filters: [{
      name: `${format.toUpperCase()} audio`,
      extensions: [format],
    }],
    // Windows and macOS always ask before replacing a file; GTK only does
    // when told to.
    properties: ['showOverwriteConfirmation'],
  });
  if (res.canceled || !res.filePath) return null;
  // The native dialog already asked about the exact path it returned, so the
  // app must not ask again. A path completed here was never checked.
  const complete = res.filePath.toLowerCase().endsWith(extension);
  return {
    path: complete ? res.filePath : res.filePath + extension,
    overwriteConfirmed: complete,
  };
});

ipcMain.handle('shell:showItem', (_event, filePath) => {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new Error('Invalid export path');
  }
  shell.showItemInFolder(filePath);
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
