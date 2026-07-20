const stageEl = document.getElementById('stage');
const fillEl = document.getElementById('fill');
const logEl = document.getElementById('log');
const errEl = document.getElementById('error');
const actionsEl = document.getElementById('actions');
const consentEl = document.getElementById('consent');
const progressEl = document.getElementById('progress');
const toggleEl = document.getElementById('details-toggle');

let errored = false;
let lastPctAt = 0;

// The bar is determinate only while percentages are flowing (downloads with a
// known size, pip's raw progress). The moment they stop — pip building a
// wheel, tar extracting — fall back to the sweeping animation instead of
// freezing at some stale width and looking hung.
setInterval(() => {
  if (!errored && !fillEl.classList.contains('indet') &&
      Date.now() - lastPctAt > 3000) {
    fillEl.classList.add('indet');
  }
}, 1000);

let logOpen = false;
function setLog(open) {
  logOpen = open;
  logEl.classList.toggle('hidden', !open);
  toggleEl.textContent = open ? 'Hide details ▾' : 'Show details ▸';
  if (open) logEl.scrollTop = logEl.scrollHeight;
}
toggleEl.addEventListener('click', () => setLog(!logOpen));

window.bootstrap.onProgress((msg) => {
  if (msg.consent) {
    document.getElementById('dl-size').textContent = `${msg.consent.downloadGB} GB`;
    document.getElementById('disk-size').textContent = `${msg.consent.diskGB} GB`;
    document.getElementById('cuda-note').classList
      .toggle('hidden', msg.consent.mode !== 'cuda');
    progressEl.classList.add('hidden');
    consentEl.classList.remove('hidden');
    return;
  }
  if (msg.reset) {
    errored = false;
    errEl.style.display = 'none';
    actionsEl.style.display = 'none';
    logEl.textContent = '';
    fillEl.style.width = '0%';
    fillEl.classList.add('indet');
    setLog(false);
    return;
  }
  if (msg.label) {
    stageEl.textContent = msg.label;
    fillEl.style.width = '0%';
    fillEl.classList.add('indet');
  }
  if (msg.pct != null) {
    lastPctAt = Date.now();
    fillEl.classList.remove('indet');
    fillEl.style.width = msg.pct + '%';
  }
  if (msg.line) {
    logEl.textContent += msg.line + '\n';
    if (logOpen) logEl.scrollTop = logEl.scrollHeight;
  }
  if (msg.error) {
    errored = true;
    errEl.textContent = msg.error;
    errEl.style.display = 'block';
    actionsEl.style.display = 'flex';
    stageEl.textContent = 'Setup failed';
    fillEl.classList.remove('indet');
    fillEl.style.width = '0%';
    setLog(true); // the log is the context for the error — show it
  }
});

document.getElementById('start').addEventListener('click', () => {
  consentEl.classList.add('hidden');
  progressEl.classList.remove('hidden');
  stageEl.textContent = 'Starting…';
  window.bootstrap.start();
});
document.getElementById('quit-consent').addEventListener('click', () => window.bootstrap.quit());
document.getElementById('retry').addEventListener('click', () => window.bootstrap.retry());
document.getElementById('quit').addEventListener('click', () => window.bootstrap.quit());
