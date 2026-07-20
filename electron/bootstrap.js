// First-run bootstrap: materialize the python env the sidecar needs.
// setup.sh productized — same steps, same torch-flavor logic, driven from the
// main process with progress streamed to a bootstrap window. Every step is
// safe to re-run: downloads are hash-checked and reused, python/venv dirs are
// wiped before re-extract/re-create, so Retry after a mid-flight failure
// (network drop, disk full) does the right thing.
const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const rt = require('./runtime');

const GiB = 1024 ** 3;

function send(win, msg) {
  if (win && !win.isDestroyed()) win.webContents.send('bootstrap:progress', msg);
}

function runCmd(cmd, args, opts, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const eat = (chunk) => {
      const lines = (tail + chunk.toString()).split(/\r?\n/);
      tail = lines.pop();
      for (const l of lines) if (l.trim() && onLine) onLine(l);
    };
    p.stdout.on('data', eat);
    p.stderr.on('data', eat);
    p.on('error', reject);
    p.on('close', (code) => {
      if (tail.trim() && onLine) onLine(tail);
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`));
    });
  });
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((res, rej) => {
    fs.createReadStream(file).on('data', (d) => hash.update(d))
      .on('end', res).on('error', rej);
  });
  return hash.digest('hex');
}

async function download(url, dest, expectedSha, onPct) {
  if (fs.existsSync(dest) && expectedSha &&
      (await sha256File(dest)) === expectedSha) {
    return; // resume-after-failure: previous verified download is fine
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status} for ${url}`);
  const total = Number(r.headers.get('content-length')) || 0;
  let got = 0;
  const out = fs.createWriteStream(dest + '.part');
  for await (const chunk of r.body) {
    out.write(chunk);
    got += chunk.length;
    if (total && onPct) onPct(Math.round((got / total) * 100));
  }
  await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  if (expectedSha) {
    const actual = await sha256File(dest + '.part');
    if (actual !== expectedSha) {
      await fsp.rm(dest + '.part', { force: true });
      throw new Error(`checksum mismatch for ${path.basename(dest)} — download corrupted?`);
    }
  }
  await fsp.rename(dest + '.part', dest);
}

// Same decision tree as setup.sh: no nvidia-smi → cpu; driver >= 580 → default
// (CUDA 13) wheels; 525–579 → cu128 wheels; older → cpu with a warning (the
// desktop app degrades instead of refusing like the script does).
async function detectTorchFlavor(onLine) {
  let out = '';
  try {
    await runCmd('nvidia-smi',
      ['--query-gpu=driver_version', '--format=csv,noheader'], {},
      (l) => { out = out || l.trim(); });
  } catch {
    onLine('no NVIDIA driver found — CPU processing');
    return { mode: 'cpu', args: ['--index-url', 'https://download.pytorch.org/whl/cpu'] };
  }
  const major = parseInt(out, 10);
  if (major >= 580) {
    onLine(`NVIDIA driver ${out}: CUDA (default wheels)`);
    return { mode: 'cuda', args: [] };
  }
  if (major >= 525) {
    onLine(`NVIDIA driver ${out}: CUDA (cu128 wheels)`);
    return { mode: 'cuda', args: ['--index-url', 'https://download.pytorch.org/whl/cu128'] };
  }
  onLine(`NVIDIA driver ${out || '(unreadable)'} too old for current torch — CPU processing`);
  return { mode: 'cpu', args: ['--index-url', 'https://download.pytorch.org/whl/cpu'] };
}

async function hasGit() {
  try { await runCmd('git', ['--version'], {}); return true; }
  catch { return false; }
}

// torch's native DLLs need the MSVC runtime, which a clean Windows lacks
// (c10.dll fails with WinError 126 — found the hard way on a fresh VM).
// Installing it needs elevation, so the user sees one UAC prompt.
async function ensureVcRedist(stage, line) {
  if (!rt.isWin) return;
  const sys32 = path.join(process.env.SystemRoot || 'C:/Windows', 'System32');
  const present = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']
    .every((d) => fs.existsSync(path.join(sys32, d)));
  if (present) return;
  stage('vcredist', 'Installing Microsoft C++ runtime (one-time)');
  line('this needs administrator approval — expect a Windows prompt');
  const exe = path.join(rt.dataRoot(), 'vc_redist.x64.exe');
  await download('https://aka.ms/vs/17/release/vc_redist.x64.exe', exe, null, () => {});
  try {
    await runCmd('powershell.exe',
      ['-NoProfile', '-Command',
       `Start-Process -FilePath '${exe}' -ArgumentList '/install','/quiet','/norestart' -Verb RunAs -Wait`],
      {}, line);
  } catch {
    throw new Error(
      'The Microsoft C++ runtime could not be installed (the administrator ' +
      'prompt may have been declined). It is required for audio processing — ' +
      'press Retry to try again.');
  } finally {
    await fsp.rm(exe, { force: true });
  }
}

// python-build-standalone was built with clang, so C extensions default to a
// clang that most user machines don't have. Find something that exists and
// force it via CC/CXX (setuptools honors the env override).
async function findCompilerEnv() {
  const candidates = [
    ['clang', 'clang++'],
    ['gcc', 'g++'],
    ['cc', 'c++'],
  ];
  for (const [cc, cxx] of candidates) {
    try {
      await runCmd(cc, ['--version'], {});
      return { ...process.env, CC: cc, CXX: cxx };
    } catch { /* try next */ }
  }
  return null;
}

async function runBootstrap(win, flavor) {
  const root = rt.dataRoot();
  await fsp.mkdir(root, { recursive: true });
  const stage = (id, label) => send(win, { stage: id, label });
  const line = (l) => send(win, { line: l });
  const pct = (p) => send(win, { pct: p });

  // -- disk space, upfront: this is a multi-GB install and must fail loudly --
  stage('disk', 'Checking disk space');
  const needBytes = (flavor.mode === 'cuda' ? 14 : 8) * GiB;
  try {
    const st = await fsp.statfs(root);
    const free = st.bavail * st.bsize;
    if (free < needBytes) {
      throw new Error(
        `Not enough disk space: the ${flavor.mode.toUpperCase()} install needs ` +
        `about ${Math.round(needBytes / GiB)} GB free, but only ` +
        `${(free / GiB).toFixed(1)} GB is available under ${root}. ` +
        `Free up space and press Retry.`);
    }
    line(`${(free / GiB).toFixed(1)} GB free — ok`);
  } catch (e) {
    if (e.message.startsWith('Not enough disk space')) throw e;
    line('disk-space check unavailable, continuing'); // statfs missing: not fatal
  }

  await ensureVcRedist(stage, line);

  // -- portable python ------------------------------------------------------
  const asset = rt.PYTHON_PIN.assets[process.platform];
  if (!asset) throw new Error(`unsupported platform: ${process.platform}`);
  stage('python', `Downloading Python ${rt.PYTHON_PIN.version}`);
  const archive = path.join(root, asset.file);
  await download(rt.PYTHON_PIN.urlBase + asset.file, archive, asset.sha256, pct);
  stage('python-x', 'Unpacking Python');
  await fsp.rm(rt.pythonDir(), { recursive: true, force: true });
  // tar is native on Linux and ships with Windows 10 1803+ (bsdtar)
  await runCmd('tar', ['-xzf', archive, '-C', root], {}, line);

  // -- venv -----------------------------------------------------------------
  stage('venv', 'Creating Python environment');
  await fsp.rm(rt.venvDir(), { recursive: true, force: true });
  await runCmd(rt.basePython(), ['-m', 'venv', rt.venvDir()], {}, line);
  // upgrade with the venv's seeded pip first — it may predate --progress-bar raw
  await runCmd(rt.venvPython(),
    ['-m', 'pip', 'install', '--no-input', '--upgrade', 'pip', '-q'], {}, line);
  // raw progress prints "Progress <got> of <total>" even without a TTY —
  // feed it to the bar instead of the log, so big wheel downloads (torch!)
  // don't look frozen
  const pipProgress = (l) => {
    const m = /^Progress (\d+) of (\d+)$/.exec(l);
    if (m && Number(m[2]) > 0) {
      pct(Math.round((Number(m[1]) / Number(m[2])) * 100));
    } else {
      line(l);
    }
  };
  const pip = (args, onl, env) =>
    runCmd(rt.venvPython(),
           ['-m', 'pip', 'install', '--no-input', '--progress-bar', 'raw', ...args],
           env ? { env } : {}, onl || pipProgress);

  // -- torch first, so audio-separator can't drag in unwanted CUDA libs -----
  stage('torch', `Installing PyTorch (${flavor.mode})`);
  await pip(['torch', 'torchaudio', ...flavor.args]);

  // -- the separation stack + sidecar deps ----------------------------------
  stage('deps', 'Installing separation engine');
  await pip(['audio-separator[cpu]==0.44.2', 'bs-roformer-infer==0.1.1',
             'melband-roformer-infer==0.1.1', 'packaging', 'soundfile']);
  // requirements.txt stays the single source of truth: madmom (a git pin that
  // needs git + a C compiler at install time) is the only optional line in it,
  // everything else is essential and must never be hostage to a failed build.
  stage('deps2', 'Installing sidecar server');
  const reqFile = path.join(rt.sidecarDir(), 'requirements.txt');
  const reqLines = fs.readFileSync(reqFile, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const madmom = reqLines.find((l) => l.startsWith('madmom'));
  await pip(reqLines.filter((l) => l !== madmom));

  let chords = false;
  const ccEnv = await findCompilerEnv();
  if (madmom && await hasGit() && ccEnv) {
    stage('chords', 'Installing chord recognition (optional)');
    try {
      await pip([madmom], null, ccEnv);
      chords = true;
    } catch {
      // ship without the chord readout; the sidecar degrades gracefully
      // (see library.chords) and everything else still works
      line('chord recognition failed to build — continuing without it');
    }
  } else {
    line('git or a C compiler not found — skipping chord recognition');
  }

  stage('patch', 'Applying model patches');
  await runCmd(rt.venvPython(),
    [path.join(rt.sidecarDir(), 'patches', 'apply_melband_patch.py')], {}, line);

  // -- windows: static ffmpeg (assumed on PATH everywhere else) -------------
  let ffmpeg = null;
  if (rt.isWin) {
    stage('ffmpeg', 'Downloading ffmpeg');
    const zip = path.join(root, 'ffmpeg.zip');
    await download(rt.WIN_FFMPEG_URL, zip, null, pct);
    const tmp = path.join(root, 'ffmpeg-tmp');
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.rm(path.join(root, 'ffmpeg'), { recursive: true, force: true });
    await fsp.mkdir(tmp, { recursive: true });
    await runCmd('tar', ['-xf', zip, '-C', tmp], {}, line); // bsdtar reads zip
    const [dir] = await fsp.readdir(tmp); // single ffmpeg-master-* root dir
    await fsp.rename(path.join(tmp, dir), path.join(root, 'ffmpeg'));
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.rm(zip, { force: true });
    ffmpeg = dir;
  }

  stage('finish', 'Finishing up');
  await fsp.rm(archive, { force: true }); // reclaim the archive's disk space
  await fsp.writeFile(rt.markerFile(), JSON.stringify({
    pythonTag: rt.PYTHON_PIN.tag,
    pythonVersion: rt.PYTHON_PIN.version,
    torch: flavor.mode,
    chords,
    ffmpeg,
    completedAt: new Date().toISOString(),
  }, null, 2));
}

// Wait for the user to press one of two buttons in the bootstrap window:
// okChannel resolves true, 'bootstrap:quit' (or closing the window) false.
function awaitChoice(win, okChannel) {
  return new Promise((resolve) => {
    const done = (v) => { cleanup(); resolve(v); };
    const onOk = () => done(true);
    const onQuit = () => done(false);
    const onClosed = () => done(false);
    const cleanup = () => {
      ipcMain.removeListener(okChannel, onOk);
      ipcMain.removeListener('bootstrap:quit', onQuit);
      win.removeListener('closed', onClosed);
    };
    ipcMain.on(okChannel, onOk);
    ipcMain.on('bootstrap:quit', onQuit);
    win.on('closed', onClosed);
  });
}

// Owns the bootstrap window and the retry loop. Resolves with the still-open
// bootstrap window when the env is ready — the caller must close it AFTER
// creating the main window (closing the app's only window fires
// window-all-closed and quits the app). Resolves null if the user bailed.
async function runBootstrapFlow() {
  const win = new BrowserWindow({
    width: 560,
    height: 460,
    resizable: false,
    backgroundColor: '#141210',
    webPreferences: {
      preload: path.join(__dirname, 'preload-bootstrap.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  await win.loadFile(path.join(__dirname, 'renderer', 'bootstrap.html'));

  // Consent gate: nothing touches the network until the user says go. The
  // flavor check is local (nvidia-smi), and knowing it lets the page show an
  // honest size estimate — a CUDA torch is several GB, CPU much less.
  const flavor = await detectTorchFlavor((l) => send(win, { line: l }));
  send(win, {
    consent: {
      mode: flavor.mode,
      downloadGB: flavor.mode === 'cuda' ? 3.5 : 1.5,
      diskGB: flavor.mode === 'cuda' ? 14 : 8,
    },
  });
  if (!(await awaitChoice(win, 'bootstrap:start'))) {
    if (!win.isDestroyed()) win.close();
    return null;
  }

  for (;;) {
    try {
      await runBootstrap(win, flavor);
      send(win, { stage: 'engine', label: 'Starting the engine' });
      return win;
    } catch (e) {
      if (win.isDestroyed()) return null; // window closed mid-install
      send(win, { error: String(e.message || e) });
      const retry = await awaitChoice(win, 'bootstrap:retry');
      if (!retry) {
        if (!win.isDestroyed()) win.close();
        return null;
      }
      send(win, { reset: true });
    }
  }
}

module.exports = { runBootstrapFlow };
