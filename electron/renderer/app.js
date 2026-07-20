const API = window.stemapp.sidecarUrl;
const TOKEN = window.stemapp.sidecarToken;

let models = [];
let songs = [];
let jobs = [];

const $ = (id) => document.getElementById(id);

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), 6000);
}

async function api(path, opts = {}) {
  opts.headers = { 'X-StemApp-Token': TOKEN, ...opts.headers };
  const r = await fetch(API + path, opts);
  if (!r.ok) {
    let detail = r.statusText;
    try { detail = (await r.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return r.json();
}

function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function fmtSize(b) {
  return b >= 1 << 30 ? (b / (1 << 30)).toFixed(1) + ' GB'
       : b >= 1 << 20 ? Math.round(b / (1 << 20)) + ' MB'
       : Math.round(b / 1024) + ' kB';
}

const DEVICE_LABELS = { cuda: 'NVIDIA GPU', mps: 'APPLE GPU', cpu: 'CPU' };
const RECOMMENDED_MODEL = 'bs_roformer_sw';

// registry speed factors are CPU-measured; phrase them in user time
function fmtSpeed(f) {
  if (!f) return '';
  const mins = 4 * f;
  return mins < 1 ? 'a 4-min song takes under a minute on CPU'
                  : `a 4-min song takes ~${Math.round(mins)} min on CPU`;
}

function led(state) {
  return el('span', 'led' + (state ? ' ' + state : ''));
}

function meterBar(frac) {
  const bar = el('div', 'meter');
  const fill = el('div');
  fill.style.width = `${Math.round((frac || 0) * 100)}%`;
  bar.append(fill);
  return bar;
}

function btn(label, cls, onclick) {
  const b = el('button', cls, label);
  b.onclick = onclick;
  return b;
}

function startDownload(modelId) {
  return api(`/models/${modelId}/download`, { method: 'POST' })
    .then(refresh).catch((e) => toast(e.message));
}

// --- rendering ----------------------------------------------------------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function activeJob(songId) {
  return jobs.find((j) => j.song_id === songId && (j.status === 'running' || j.status === 'queued'));
}

// --- library sorting --------------------------------------------------------
// ISO timestamps from the manifests compare correctly as strings.

const SORTS = {
  added: (a, b) => (b.added_at || '').localeCompare(a.added_at || ''),
  title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
  duration: (a, b) => (b.duration_s || 0) - (a.duration_s || 0),
};

let sortBy = localStorage.getItem('sortBy');
if (!SORTS[sortBy]) sortBy = 'added';
$('sort-select').value = sortBy;
$('sort-select').onchange = () => {
  sortBy = $('sort-select').value;
  localStorage.setItem('sortBy', sortBy);
  renderSongs();
};

// --- confirmation dialog ------------------------------------------------

let confirmResolve = null; // pending askConfirm; closing the dialog = "no"

function setConfirm(open) {
  $('confirm').classList.toggle('hidden', !open);
  $('confirm-scrim').classList.toggle('hidden', !open);
  if (!open && confirmResolve) {
    const r = confirmResolve;
    confirmResolve = null;
    r(false);
  }
}

function askConfirm({ title, body, okLabel, danger }) {
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    const ok = $('confirm-ok');
    ok.textContent = okLabel;
    ok.className = danger ? 'danger' : 'primary';
    ok.onclick = () => {
      confirmResolve = null; // so setConfirm(false) doesn't also resolve
      setConfirm(false);
      resolve(true);
    };
    confirmResolve = resolve;
    setConfirm(true);
    $('confirm-cancel').focus();
  });
}

async function confirmDelete(song) {
  if (activeJob(song.id)) {
    toast('A separation is still running for this song — cancel it first.');
    return;
  }
  const nSets = Object.keys(song.stems || {}).length;
  const what = nSets
    ? `the song and its ${nSets} separated stem ${nSets === 1 ? 'set' : 'sets'}`
    : 'the song';
  const ok = await askConfirm({
    title: `Delete “${song.title}”?`,
    body: `This removes ${what} from the library and frees ${fmtSize(song.disk_bytes || 0)} ` +
          'of disk space. There is no undo. Your original file stays where it was — ' +
          'only the app’s copy is deleted.',
    okLabel: 'Delete song',
    danger: true,
  });
  if (!ok) return;
  api(`/songs/${encodeURIComponent(song.id)}`, { method: 'DELETE' })
    .then((r) => { toast(`Deleted “${song.title}” — freed ${fmtSize(r.freed_bytes)}`); return refresh(); })
    .catch((e) => toast(e.message));
}

$('confirm-cancel').onclick = () => setConfirm(false);
$('confirm-scrim').onclick = () => setConfirm(false);

function renderModels() {
  const list = $('models-list');
  list.replaceChildren();
  for (const m of models) {
    const row = el('div', 'model-row');
    const dl = m.download;

    const head = el('div', 'model-head');
    const nameWrap = el('span');
    nameWrap.append(el('span', 'model-name', m.display_name));
    if (m.id === RECOMMENDED_MODEL) {
      nameWrap.append(' ', el('span', 'chip rec', 'recommended'));
    }
    head.append(nameWrap);

    const status = el('span', 'model-status');
    if (m.installed) {
      status.classList.add('ok');
      status.append(led('ok'), 'installed');
    } else if (dl && dl.status === 'downloading') {
      status.append(led('busy'), `downloading ${Math.round((dl.progress || 0) * 100)}%`);
    } else if (dl && dl.status === 'failed') {
      status.append(led('err'), 'download failed');
    } else if (m.managed) {
      status.append(led(''), 'auto-installs on first use');
    } else {
      status.append(led(''), 'not installed');
    }
    head.append(status);
    row.append(head);

    const stems = el('div', 'model-stems');
    stems.append('splits into: ');
    (m.stems || []).forEach((s, i) => {
      if (i) stems.append(' · ');
      stems.append(el('span', s === 'guitar' ? 'hl' : null, s));
    });
    row.append(stems);

    const bits = [];
    if (m.size_bytes) bits.push(fmtSize(m.size_bytes));
    if (m.cpu_x_realtime) bits.push(fmtSpeed(m.cpu_x_realtime));
    if (bits.length) row.append(el('div', 'model-info', bits.join(' · ')));

    const lic = el('div', 'model-info');
    lic.append(`License: ${m.license}`);
    if (!m.license_ok_redistribute) {
      const chip = el('span', 'chip lic', 'personal use');
      chip.title = 'The author published these weights without a license grant. ' +
                   'Fine to download and use privately; not redistributable.';
      lic.append(' ', chip);
    }
    row.append(lic);

    if (!m.installed && !m.managed) {
      const act = el('div', 'model-actions');
      if (dl && dl.status === 'downloading') {
        act.append(meterBar(dl.progress));
      } else {
        act.append(btn(dl && dl.status === 'failed' ? 'Retry download' : 'Download',
                       m.id === RECOMMENDED_MODEL ? 'primary' : null,
                       () => startDownload(m.id)));
      }
      row.append(act);
    }
    list.append(row);
  }
}

// --- first-run signal chain ------------------------------------------------

function chainStep(num, title, ledState, bodyText) {
  const step = el('div', 'chain-step');
  const head = el('div', 'step-head');
  head.append(el('span', 'step-num', num), el('span', 'step-title', title), led(ledState));
  step.append(head, el('p', 'step-body', bodyText));
  return step;
}

function renderOnboarding() {
  const box = $('onboarding');
  const show = songs.length === 0;
  box.classList.toggle('hidden', !show);
  if (!show) return;
  box.replaceChildren();

  box.append(el('h1', 'onboard-title', 'Split a song into its parts'));
  box.append(el('p', 'onboard-sub',
    'Guitar, vocals, drums, bass — pulled apart on this machine, fully offline.'));

  const rec = models.find((m) => m.id === RECOMMENDED_MODEL);
  const installedModel = models.find((m) => m.installed);

  let s1;
  if (installedModel) {
    s1 = chainStep('1', 'Get a model', 'ok',
      `${installedModel.display_name} is installed and ready.`);
    const act = el('div', 'step-actions');
    act.append(btn('All models', 'ghost', () => setDrawer(true)));
    s1.append(act);
  } else if (rec && rec.download && rec.download.status === 'downloading') {
    s1 = chainStep('1', 'Get a model', 'busy',
      'The neural net that pulls a mix apart. Downloading now — this happens once.');
    const act = el('div', 'step-actions');
    act.append(meterBar(rec.download.progress),
               el('span', 'progress-label', `${Math.round((rec.download.progress || 0) * 100)}%`));
    s1.append(act);
  } else {
    const failed = rec && rec.download && rec.download.status === 'failed';
    s1 = chainStep('1', 'Get a model', failed ? 'err' : '',
      'The neural net that pulls a mix apart. One download, then everything runs offline.');
    const act = el('div', 'step-actions');
    if (rec) {
      act.append(btn(`${failed ? 'Retry' : 'Download'} recommended · ${fmtSize(rec.size_bytes)}`,
                     'primary', () => startDownload(rec.id)));
    }
    act.append(btn('All models', 'ghost', () => setDrawer(true)));
    s1.append(act);
  }

  const s2 = chainStep('2', 'Add a song', '',
    'MP3, FLAC or WAV from this computer. Files are copied into the app library — ' +
    'your originals are never touched.');
  const act2 = el('div', 'step-actions');
  act2.append(btn('Add songs', installedModel ? 'primary' : null, addSongs));
  s2.append(act2);

  const s3 = chainStep('3', 'Separate & listen', '',
    'Press “Separate stems” on the song, wait for the meter, then open the mixer ' +
    'to solo the guitar — or mute it and play along.');

  const chain = el('div', 'chain');
  chain.append(s1, el('div', 'chain-wire'), s2, el('div', 'chain-wire'), s3);
  box.append(chain);
  box.append(el('div', 'onboard-note', 'Audio never leaves this machine'));
}

const chosenModel = {}; // per-song "separate with" pick, survives re-renders

function renderSongs() {
  const list = $('songs-list');
  list.replaceChildren();
  $('library-bar').classList.toggle('hidden', songs.length < 2);

  for (const s of [...songs].sort(SORTS[sortBy])) {
    const card = el('div', 'song-card');
    const hasStems = Object.keys(s.stems || {}).length > 0;

    const head = el('div', 'song-head');
    const headline = el('span', 'song-headline');
    headline.append(el('span', 'song-title', s.title));
    if (hasStems) headline.append(el('span', 'sep-badge', '✓ separated'));
    head.append(headline);
    const side = el('span', 'song-side');
    side.append(el('span', 'song-meta', fmtTime(s.duration_s)));
    const del = btn('Delete', 'ghost del', () => confirmDelete(s));
    del.title = 'Delete this song and its stems from the library';
    side.append(del);
    head.append(side);
    card.append(head);

    for (const modelId of Object.keys(s.stems || {})) {
      const info = s.stems[modelId];
      const n = Object.keys(info.files || {}).length;
      const m = models.find((x) => x.id === modelId);
      const open = el('button', 'mix-btn');
      open.append(el('span', null, info.model_display_name || (m ? m.display_name : modelId)),
                  el('span', 'take-meta', `${n} stems`),
                  el('span', 'open-cue', 'open mixer ▸'));
      open.title = 'Open in the mixer — solo or mute each instrument';
      open.onclick = () => openMixer(s, modelId);
      card.append(open);
    }

    const job = activeJob(s.id);
    if (job) {
      const wrap = el('div', 'progress-wrap');
      wrap.append(meterBar(job.progress));
      const m = models.find((x) => x.id === job.model_id);
      const name = m ? m.display_name : job.model_id;
      wrap.append(el('span', 'progress-label',
        job.status === 'queued'
          ? `queued · ${name}`
          : `${Math.round(job.progress * 100)}% · ${fmtTime(job.eta_s)} left · ${name}`));
      wrap.append(btn('Cancel', 'danger',
        () => api(`/jobs/${job.id}/cancel`, { method: 'POST' }).then(refresh).catch((e) => toast(e.message))));
      card.append(wrap);
    } else {
      const controls = el('div', 'sep-row');
      const runnable = models.filter((m) => m.installed || m.managed);
      if (runnable.length) {
        controls.append(el('span', 'sep-label', 'separate with'));
        const sel = el('select');
        for (const m of runnable) {
          const opt = el('option', null, m.display_name + (s.stems[m.id] ? ' — again' : ''));
          opt.value = m.id;
          sel.append(opt);
        }
        if (chosenModel[s.id] && runnable.some((m) => m.id === chosenModel[s.id])) {
          sel.value = chosenModel[s.id];
        } else if (runnable.some((m) => m.id === RECOMMENDED_MODEL)) {
          // default to the recommended model once it's installed — not to
          // whatever happens to sort first in the registry
          sel.value = RECOMMENDED_MODEL;
        }
        sel.onchange = () => { chosenModel[s.id] = sel.value; };
        // once stems exist, re-separating is a side path — the mixer row is
        // the card's main action, so this button demotes to ghost
        controls.append(sel, btn(hasStems ? 'Separate again' : 'Separate stems',
          hasStems ? 'ghost' : 'primary',
          () => api('/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ song_id: s.id, model_id: sel.value, device: preferredDevice }),
          }).then(refresh).catch((e) => toast(e.message))));
      } else {
        controls.append(btn('Download a model to start', null, () => setDrawer(true)));
      }
      card.append(controls);
    }

    const failed = jobs.filter((j) => j.song_id === s.id && j.status === 'failed').at(-1);
    if (failed && !job) {
      const strip = el('div', 'error-strip');
      strip.title = failed.error || '';
      const msg = el('span');
      msg.append(el('b', null, 'Separation failed.'), ' Hover for details — the full log is in the data folder.');
      strip.append(led('err'), msg);
      card.append(strip);
    }

    list.append(card);
  }
}

// --- mixer ----------------------------------------------------------------
// Streaming <audio> elements (no full decode -> long songs stay cheap on RAM)
// routed through WebAudio gain nodes for volume/mute/solo. Track 0 is the
// sync master; the others are nudged if they drift past 80 ms.

const STEM_ORDER = ['guitar', 'vocals', 'bass', 'drums', 'piano', 'other', 'rest', 'instrumental'];
const mixer = { open: false, tracks: [], ctx: null, playing: false, raf: null, duration: 0,
                rate: 1, bpm: null, songId: null, chords: null };

function stemUrl(songId, modelId, stem, kind) {
  const base = `${API}/songs/${encodeURIComponent(songId)}/stems/${encodeURIComponent(modelId)}/${encodeURIComponent(stem)}/${kind}`;
  // <audio> elements can't send headers, so audio auths via query param;
  // peaks go through api() (which appends ?points=…), keep that URL bare
  return kind === 'audio' ? `${base}?token=${TOKEN}` : base;
}

function effectiveGains() {
  const anySolo = mixer.tracks.some((t) => t.solo);
  for (const t of mixer.tracks) {
    const audible = !t.muted && (!anySolo || t.solo);
    t.gain.gain.value = audible ? t.vol : 0;
  }
  for (const t of mixer.tracks) {
    t.muteBtn.classList.toggle('active', t.muted);
    t.soloBtn.classList.toggle('active', t.solo);
  }
}

// Varispeed: the percent is the ground truth (exact, works on any song); the
// BPM readout is the song's reference estimate × rate, so it only moves when
// the user moves the rate — never from re-detection, which flips metric
// levels on 15s windows. preservesPitch keeps the key while stretching.
function setRate(r) {
  mixer.rate = Math.min(1.5, Math.max(0.5, Math.round(r * 20) / 20));
  for (const tr of mixer.tracks) tr.el.playbackRate = mixer.rate;
  $('tempo-pct').textContent = `${Math.round(mixer.rate * 100)}%`;
  $('tempo-pct').classList.toggle('off-unity', mixer.rate !== 1);
  updateBpmLabel();
}

function updateBpmLabel() {
  const label = $('tempo-bpm');
  label.classList.toggle('hidden', mixer.bpm == null);
  if (mixer.bpm != null) label.textContent = `≈ ${Math.round(mixer.bpm * mixer.rate)} BPM`;
}

// Chord readout: the sounding chord plus the change coming next — the next
// one is what a player actually needs, the current one is already ringing.
// (A full timeline strip was tried and rejected: on a real song it's
// hundreds of unreadable slivers.) chords === null -> analysis still
// running, busy LED; [] -> nothing tonal (or no data), readout hidden.
function setText(id, v) {
  const e = $(id);
  if (e.textContent !== v) e.textContent = v; // rAF calls this every frame
}

function updateChordReadout() {
  const pending = mixer.chords === null;
  const has = Array.isArray(mixer.chords) && mixer.chords.length > 0;
  $('chord-box').classList.toggle('hidden', !pending && !has);
  $('chord-busy').classList.toggle('hidden', !pending);
  if (!has) {
    setText('chord-now', '');
    setText('chord-next', '');
    return;
  }
  const t = master() ? master().currentTime : 0;
  const now = mixer.chords.find(([s, e]) => t >= s && t < e);
  const next = mixer.chords.find(([s]) => s > t);
  setText('chord-now', now ? now[2] : '–');
  setText('chord-next', next ? `→ ${next[2]}` : '');
}

function drawPeaks(t) {
  const c = t.canvas;
  const ctx2 = c.getContext('2d');
  const W = (c.width = c.clientWidth * devicePixelRatio);
  const H = (c.height = c.clientHeight * devicePixelRatio);
  ctx2.clearRect(0, 0, W, H);
  if (!t.peaks || !t.peaks.length) return;
  ctx2.fillStyle = '#e8a33dbb';
  const n = t.peaks.length;
  const scale = mixer.peakMax || 1;
  const bw = W / n;
  for (let i = 0; i < n; i++) {
    const h = Math.max((t.peaks[i] / scale) * H, 1);
    ctx2.fillRect(i * bw, (H - h) / 2, Math.max(bw - 1, 1), h);
  }
}

function master() {
  return mixer.tracks[0] ? mixer.tracks[0].el : null;
}

function mixerTick() {
  if (!mixer.open) return;
  const m = master();
  if (m) {
    const t = m.currentTime;
    $('mixer-time').textContent = `${fmtTime(t)} / ${fmtTime(mixer.duration)}`;
    for (const tr of mixer.tracks) {
      tr.playhead.style.left = `${(t / (mixer.duration || 1)) * 100}%`;
      if (mixer.playing && tr.el !== m && Math.abs(tr.el.currentTime - t) > 0.08) {
        tr.el.currentTime = t;
      }
    }
    updateChordReadout();
    if (mixer.playing && m.ended) setPlaying(false);
  }
  mixer.raf = requestAnimationFrame(mixerTick);
}

function setPlaying(on) {
  mixer.playing = on;
  $('mixer-play').textContent = on ? '⏸ Pause' : '▶ Play';
  if (on) {
    if (mixer.ctx.state === 'suspended') mixer.ctx.resume();
    const t = master().currentTime;
    for (const tr of mixer.tracks) {
      if (tr.el !== master()) tr.el.currentTime = t;
    }
    Promise.all(mixer.tracks.map((tr) => tr.el.play())).catch((e) => toast(`playback: ${e.message}`));
  } else {
    for (const tr of mixer.tracks) tr.el.pause();
  }
}

function seekTo(frac) {
  const t = Math.max(0, Math.min(frac, 1)) * mixer.duration;
  for (const tr of mixer.tracks) tr.el.currentTime = t;
}

async function openMixer(song, modelId) {
  closeMixer();
  mixer.open = true;
  mixer.ctx = mixer.ctx || new AudioContext();
  $('mixer').classList.remove('hidden');
  $('mixer-title').textContent = song.title;
  const m = models.find((x) => x.id === modelId);
  $('mixer-model').textContent = ` — ${m ? m.display_name : modelId}`;
  $('mixer-loading').classList.remove('hidden');
  $('mixer-tracks').replaceChildren();

  const stemNames = Object.keys(song.stems[modelId].files)
    .sort((a, b) => (STEM_ORDER.indexOf(a) + 99) - (STEM_ORDER.indexOf(b) + 99)
                  || a.localeCompare(b));

  for (const name of stemNames) {
    const elx = new Audio();
    elx.crossOrigin = 'anonymous';
    elx.preload = 'auto';
    elx.preservesPitch = true;
    elx.src = stemUrl(song.id, modelId, name, 'audio');
    const srcNode = mixer.ctx.createMediaElementSource(elx);
    const gain = mixer.ctx.createGain();
    srcNode.connect(gain).connect(mixer.ctx.destination);

    const row = el('div', 'track');
    const label = el('div', 'track-label' + (name === 'guitar' ? ' is-guitar' : ''), name);
    const muteBtn = el('button', 'sq m', 'M');
    muteBtn.title = 'Mute';
    const soloBtn = el('button', 'sq s', 'S');
    soloBtn.title = 'Solo';
    const vol = document.createElement('input');
    vol.type = 'range';
    vol.min = 0; vol.max = 1.25; vol.step = 0.01; vol.value = 1;
    const wave = el('div', 'wave');
    const canvas = document.createElement('canvas');
    const playhead = el('div', 'playhead');
    wave.append(canvas, playhead);

    const ctrl = el('div', 'track-ctrl');
    ctrl.append(label, muteBtn, soloBtn, vol);
    row.append(ctrl, wave);
    $('mixer-tracks').append(row);

    const track = { name, el: elx, srcNode, gain, canvas, playhead,
                    vol: 1, muted: false, solo: false, muteBtn, soloBtn, peaks: null };
    muteBtn.onclick = () => { track.muted = !track.muted; effectiveGains(); };
    soloBtn.onclick = () => { track.solo = !track.solo; effectiveGains(); };
    vol.oninput = () => { track.vol = parseFloat(vol.value); effectiveGains(); };
    wave.onclick = (ev) => seekTo((ev.clientX - wave.getBoundingClientRect().left) / wave.clientWidth);
    mixer.tracks.push(track);
  }

  mixer.songId = song.id;
  mixer.bpm = null;
  setRate(1); // fresh song starts at real speed, BPM label hidden until known
  api(`/songs/${encodeURIComponent(song.id)}/bpm`)
    .then((d) => {
      // first call analyzes the whole song — guard against a late arrival
      // after the user has moved on to another song
      if (mixer.open && mixer.songId === song.id) {
        mixer.bpm = d.bpm;
        updateBpmLabel();
      }
    })
    .catch(() => {}); // no reference tempo — the control stays percent-only

  mixer.chords = null;
  updateChordReadout(); // busy LED until this song's analysis lands
  api(`/songs/${encodeURIComponent(song.id)}/chords`)
    .then((d) => {
      if (mixer.open && mixer.songId === song.id) {
        mixer.chords = d.chords;
        updateChordReadout();
      }
    })
    .catch(() => {
      // no chord data — hide the readout, the mixer works fine without it
      if (mixer.open && mixer.songId === song.id) {
        mixer.chords = [];
        updateChordReadout();
      }
    });

  // fetch all peaks, then scale waveforms to a common max so relative
  // loudness between stems stays visible
  const results = await Promise.allSettled(mixer.tracks.map(async (t) => {
    const d = await api(stemUrl(song.id, modelId, t.name, 'peaks').replace(API, '') + '?points=1200');
    t.peaks = d.peaks;
    mixer.duration = Math.max(mixer.duration, d.duration_s);
  }));
  const fail = results.find((r) => r.status === 'rejected');
  if (fail) toast(`waveforms: ${fail.reason.message}`);
  mixer.peakMax = Math.max(0.01, ...mixer.tracks.flatMap((t) => t.peaks || [0]));
  for (const t of mixer.tracks) drawPeaks(t);
  $('mixer-loading').classList.add('hidden');
  effectiveGains();
  mixerTick();
}

function closeMixer() {
  if (!mixer.open) return;
  setPlaying(false);
  cancelAnimationFrame(mixer.raf);
  for (const t of mixer.tracks) {
    t.el.src = '';
    t.srcNode.disconnect();
    t.gain.disconnect();
  }
  mixer.tracks = [];
  mixer.duration = 0;
  mixer.open = false;
  mixer.chords = null;
  $('chord-box').classList.add('hidden');
  $('mixer').classList.add('hidden');
}

$('mixer-close').onclick = closeMixer;
$('mixer-play').onclick = () => setPlaying(!mixer.playing);
$('tempo-down').onclick = () => setRate(mixer.rate - 0.05);
$('tempo-up').onclick = () => setRate(mixer.rate + 0.05);
$('tempo-pct').onclick = () => setRate(1);
window.addEventListener('resize', () => mixer.open && mixer.tracks.forEach(drawPeaks));

// --- data + wiring --------------------------------------------------------

let sidecarUp = false;
let preferredDevice = 'cpu';

function setEngine(state) {
  const chip = $('sidecar-status');
  chip.replaceChildren();
  if (state === 'ok') {
    const dev = DEVICE_LABELS[preferredDevice] || preferredDevice.toUpperCase();
    chip.append(led('ok'), `ENGINE · ${dev}`);
    chip.title = `The separation engine is running. Jobs run on your ${dev}.`;
  } else if (state === 'err') {
    chip.append(led('err'), 'ENGINE OFFLINE');
    chip.title = 'The local separation engine is not responding. ' +
                 'It usually recovers by itself; if not, restart the app.';
  } else {
    chip.append(led(''), 'ENGINE …');
  }
}

let renderedSnap = null;

function selectInUse() {
  const a = document.activeElement;
  return !!a && a.tagName === 'SELECT';
}

async function refresh() {
  try {
    [models, songs, jobs] = await Promise.all([api('/models'), api('/songs'), api('/jobs')]);
    if (!sidecarUp) {
      sidecarUp = true;
      const h = await api('/health');
      const devs = h.devices || ['cpu'];
      preferredDevice = devs.includes('cuda') ? 'cuda' : devs.includes('mps') ? 'mps' : 'cpu';
      setEngine('ok');
    }
    // Re-render only when the data actually changed, and never while a
    // dropdown has focus — replaceChildren() would snap its open popup shut.
    // A deferred render happens on the first tick after the select blurs
    // (renderedSnap stays stale until then).
    const snap = JSON.stringify([models, songs, jobs]);
    if (snap !== renderedSnap && !selectInUse()) {
      renderedSnap = snap;
      renderModels();
      renderSongs();
      renderOnboarding();
    }
  } catch (e) {
    sidecarUp = false;
    setEngine('err');
  }
}

async function ingestOne(path, force = false) {
  const r = await fetch(API + '/songs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-StemApp-Token': TOKEN },
    body: JSON.stringify({ path, force }),
  });
  if (r.ok) return;
  let detail = r.statusText;
  try { detail = (await r.json()).detail || detail; } catch {}
  if (r.status === 409 && detail && detail.duplicate) {
    const ok = await askConfirm({
      title: 'Already in the library',
      body: `The file you picked is the same audio as “${detail.existing_title}”, ` +
            'which is already in the library. Add a second copy anyway?',
      okLabel: 'Add anyway',
    });
    if (ok) return ingestOne(path, true);
    return;
  }
  toast(`${path}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

async function addSongs() {
  const paths = await window.stemapp.openAudioDialog();
  for (const p of paths) {
    await ingestOne(p).catch((e) => toast(`${p}: ${e.message}`));
    refresh(); // ingested songs appear while later dialogs are still up
  }
}

$('btn-add').onclick = addSongs;

function setDrawer(open) {
  $('models-panel').classList.toggle('hidden', !open);
  $('drawer-scrim').classList.toggle('hidden', !open);
}

$('btn-models').onclick = () => setDrawer($('models-panel').classList.contains('hidden'));
$('models-close').onclick = () => setDrawer(false);
$('drawer-scrim').onclick = () => setDrawer(false);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('confirm').classList.contains('hidden')) setConfirm(false);
    else if (mixer.open) closeMixer();
    else setDrawer(false);
  }
});

refresh();
setInterval(refresh, 1500);
