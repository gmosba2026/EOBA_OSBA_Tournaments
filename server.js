/**
 * EOBA_OSBA_Tournaments backend
 * - Serves index.html (and any static assets beside it)
 * - /api/state   GET  → returns current state + version
 *                PUT  → overwrites state (requires X-Admin-Pin header)
 * State lives in a single JSON file on a Render persistent disk.
 */
const express = require('express');
const fs      = require('fs');
const fsp     = require('fs/promises');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── Config (env vars) ─────────────────────────────────────────── */
const ADMIN_PIN  = process.env.ADMIN_PIN || '128976';
const DATA_DIR   = process.env.DATA_DIR  || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TMP_FILE   = path.join(DATA_DIR, 'state.tmp.json');

/* ── Bootstrap data dir ───────────────────────────────────────── */
if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(STATE_FILE)) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    version: 0,
    updatedAt: new Date().toISOString(),
    appState: { tournaments: [], activeTournamentId: null }
  }, null, 2));
}

/* ── In-memory snapshot + write lock ──────────────────────────── */
let snapshot = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
let writing  = Promise.resolve();

async function persist(next) {
  await fsp.writeFile(TMP_FILE, JSON.stringify(next));
  await fsp.rename(TMP_FILE, STATE_FILE);     // atomic on same filesystem
  snapshot = next;
}

/* ── Middleware ───────────────────────────────────────────────── */
app.use(express.json({ limit: '5mb' }));      // room for embedded logos
app.disable('x-powered-by');

/* ── API ──────────────────────────────────────────────────────── */
app.get('/api/state', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(snapshot);
});

app.put('/api/state', async (req, res) => {
  const pin = req.headers['x-admin-pin'] || '';
  const gcPins = ((snapshot.appState && snapshot.appState.tournaments) || [])
    .map(t => t && t.gymCaptainPin)
    .filter(Boolean);
  const authOK = pin && (pin === ADMIN_PIN || gcPins.includes(pin));
  if (!authOK) {
    return res.status(401).json({ error: 'Bad PIN' });
  }
  const { appState, expectedVersion } = req.body || {};
  if (!appState || typeof appState !== 'object') {
    return res.status(400).json({ error: 'Missing appState' });
  }

  /* Optimistic-concurrency: reject if client was editing a stale version */
  if (typeof expectedVersion === 'number' &&
      expectedVersion !== snapshot.version) {
    return res.status(409).json({
      error: 'Version conflict',
      currentVersion: snapshot.version
    });
  }

  /* Serialize writes so two near-simultaneous PUTs can't corrupt the file */
  writing = writing.then(async () => {
    const next = {
      version:   snapshot.version + 1,
      updatedAt: new Date().toISOString(),
      appState
    };
    await persist(next);
    return next;
  }).catch(err => { console.error('persist error:', err); throw err; });

  try {
    const saved = await writing;
    res.json({ ok: true, version: saved.version, updatedAt: saved.updatedAt });
  } catch {
    res.status(500).json({ error: 'Write failed' });
  }
});

/* ── Health check (useful for Render probes) ──────────────────── */
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

/* ── Static frontend ──────────────────────────────────────────── */
app.use(express.static(__dirname, { index: 'index.html', extensions: ['html'] }));

/* ── Start ────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`EOBA server listening on :${PORT}`);
  console.log(`State file: ${STATE_FILE} (version ${snapshot.version})`);
});
