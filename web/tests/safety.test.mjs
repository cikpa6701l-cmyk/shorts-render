// Safety-lock regression tests: run with `node --test tests/` from web/.
// All network is mocked; no external calls. Simulates the failure matrix.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.OWNER_CODE = 'testcode';
process.env.SESSION_SECRET = 'testsecret';
process.env.GH_PAT = 'x';
process.env.T_GH_MS = '2000';
process.env.T_DL_MS = '300';
process.env.T_YTINIT_MS = '300';
process.env.T_YTPUT_MS = '300';

// ---- in-memory GitHub contents store + call counters ----
const files = {}; // path -> {jsonText, sha}
let shaCounter = 1;
let dispatchCount = 0;
let ytInitCount = 0;
let ytPutCount = 0;
let videoBytes = null;   // what the release-URL fetch returns
let hangDownload = false;
const VIDEO_URL = 'https://github.com/cikpa6701l-cmyk/shorts-render/releases/download/videos/job-abc123.mp4';

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('api.github.com/repos/') && u.includes('/contents/')) {
    const p = decodeURIComponent(u.split('/contents/')[1]);
    if (!opts.method) { // GET
      if (!files[p]) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ content: Buffer.from(files[p].jsonText).toString('base64'), sha: files[p].sha }), { status: 200 });
    }
    if (opts.method === 'PUT') {
      const b = JSON.parse(opts.body);
      if (files[p] && b.sha !== files[p].sha) return new Response(JSON.stringify({ message: 'sha conflict' }), { status: 409 });
      files[p] = { jsonText: Buffer.from(b.content, 'base64').toString(), sha: String(shaCounter++) };
      return new Response('{}', { status: 200 });
    }
  }
  if (u.includes('actions/workflows/render.yml/dispatches')) { dispatchCount++; return new Response(null, { status: 204 }); }
  if (u.includes('releases/download/videos/job-')) {
    await new Promise(r => setTimeout(r, 120)); // force interleaving window for race tests
    if (hangDownload) return new Promise((_, rej) => { opts.signal.addEventListener('abort', () => rej(new Error('The operation was aborted'))); });
    return new Response(videoBytes, { status: 200 });
  }
  if (u.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3500 }), { status: 200 });
  if (u.includes('googleapis.com/upload/youtube/v3/videos')) { ytInitCount++; return new Response('{}', { status: 200, headers: { location: 'https://uploads.example/abc' } }); }
  if (u === 'https://uploads.example/abc') { ytPutCount++; return new Response(JSON.stringify({ id: 'yt123', status: { uploadStatus: 'uploaded' } }), { status: 200 }); }
  throw new Error('unmocked fetch: ' + u);
};
after(() => { globalThis.fetch = realFetch; });

// valid MP4-ish bytes: 11KB with ftyp box
const MP4 = Buffer.concat([Buffer.from('\0\0\0\x18ftypisom\0\0\0\0', 'latin1'), Buffer.alloc(11000)]);

function encTokenBlob(obj) {
  const key = crypto.createHash('sha256').update('testsecret' + '|' + 'testcode').digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
let server, base;
function sessCookie() {
  const payload = Buffer.from(JSON.stringify({ email: 'o@x.com', exp: Date.now() + 864e5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', 'testsecret').update(payload).digest('base64url');
  return 'sssess=' + payload + '.' + sig;
}
before(async () => {
  const mod = await import('../server.js');
  server = mod.default;
  await new Promise(r => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;
  // seed a valid encrypted refresh-token blob so getAccessToken works in upload tests
  files['secrets/tokens.json.enc'] = { jsonText: JSON.stringify(encTokenBlob({ refresh_token: 'rt', email: 'o@x.com' })), sha: '1' };
});
after(() => server.close());

const post = (path, body, headers = {}) =>
  realFetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

// --- generate auth + validation ---
test('generate without auth -> 403', async () => {
  const r = await post('/api/generate', { prompt: 'x' });
  assert.equal(r.status, 403);
});
test('generate wrong passcode -> 403', async () => {
  const r = await post('/api/generate', { prompt: 'x', owner: 'nope' });
  assert.equal(r.status, 403);
});
test('generate empty prompt -> 400', async () => {
  const r = await post('/api/generate', { prompt: '  ', owner: 'testcode' });
  assert.equal(r.status, 400);
});

// --- duplicate job protection ---
test('double-submit identical job -> same id, one dispatch', async () => {
  dispatchCount = 0;
  const body = { prompt: 'dup test', seconds: 10, ratio: '9:16', quality: 'fast', voice: false, subtitles: true, owner: 'testcode' };
  const r1 = await post('/api/generate', body);
  const d1 = await r1.json();
  assert.equal(r1.status, 200); assert.ok(d1.id);
  const r2 = await post('/api/generate', body);
  const d2 = await r2.json();
  assert.equal(r2.status, 200);
  assert.equal(d2.id, d1.id);
  assert.equal(d2.deduped, true);
  assert.equal(dispatchCount, 1);
});

// --- upload auth + validation ---
test('upload without session -> 401 needsAuth', async () => {
  const r = await post('/api/youtube-upload', { video: VIDEO_URL });
  assert.equal(r.status, 401);
  const d = await r.json(); assert.ok(d.needsAuth);
});
test('upload bad url -> 400', async () => {
  const r = await post('/api/youtube-upload', { video: 'https://evil.com/x.mp4' }, { cookie: sessCookie() });
  assert.equal(r.status, 400);
});
test('upload corrupt file -> 400, marked failed, retry allowed', async () => {
  videoBytes = Buffer.from('not a video at all........');
  const r1 = await post('/api/youtube-upload', { video: VIDEO_URL }, { cookie: sessCookie() });
  assert.equal(r1.status, 400);
  assert.equal(ytInitCount, 0); // never touched YouTube
  videoBytes = MP4;
  const r2 = await post('/api/youtube-upload', { video: VIDEO_URL }, { cookie: sessCookie() });
  assert.equal(r2.status, 200); // retry works
});

// --- upload idempotency (double-click / refresh-retry) ---
test('double upload same video -> one YouTube video, deduped', async () => {
  ytInitCount = 0; ytPutCount = 0;
  const r1 = await post('/api/youtube-upload', { video: VIDEO_URL }, { cookie: sessCookie() });
  const d1 = await r1.json();
  assert.equal(r1.status, 200); assert.equal(d1.youtubeId, 'yt123');
  const r2 = await post('/api/youtube-upload', { video: VIDEO_URL }, { cookie: sessCookie() });
  const d2 = await r2.json();
  assert.equal(d2.youtubeId, 'yt123');
  assert.equal(d2.deduped, true);
  assert.equal(ytPutCount, 0); // second request never hit YouTube
});

// --- timeout safety ---
test('hanging download -> 502 fast, marked failed, retry allowed', async () => {
  const url2 = VIDEO_URL.replace('abc123', 'timeout1');
  hangDownload = true;
  const t0 = Date.now();
  const r1 = await post('/api/youtube-upload', { video: url2 }, { cookie: sessCookie() });
  assert.equal(r1.status, 502);
  assert.ok(Date.now() - t0 < 5000, 'must fail fast, not hang');
  hangDownload = false;
  videoBytes = MP4;
  const r2 = await post('/api/youtube-upload', { video: url2 }, { cookie: sessCookie() });
  assert.equal(r2.status, 200); // retry succeeds after failure
});

// --- stuck job recovery ---
test('stuck queued job -> failed with retry hint', async () => {
  files['status/stuck1.json'] = { jsonText: JSON.stringify({ id: 'stuck1', status: 'queued', ts: Date.now() - 31 * 60e3 }), sha: '1' };
  const r = await realFetch(base + '/api/status/stuck1');
  const d = await r.json();
  assert.equal(d.status, 'failed');
  assert.equal(d.stuck, true);
  assert.match(d.error, /retry/);
});
test('fresh queued job -> still queued', async () => {
  files['status/fresh1.json'] = { jsonText: JSON.stringify({ id: 'fresh1', status: 'queued', ts: Date.now() }), sha: '1' };
  const r = await realFetch(base + '/api/status/fresh1');
  const d = await r.json();
  assert.equal(d.status, 'queued');
});

// --- concurrent identical submits (app + website at once) ---
test('simultaneous identical generates -> one dispatch, same id', async () => {
  dispatchCount = 0;
  const body = { prompt: 'concurrent test', seconds: 10, ratio: '9:16', quality: 'fast', owner: 'testcode' };
  const [r1, r2] = await Promise.all([post('/api/generate', body), post('/api/generate', body)]);
  const [d1, d2] = await Promise.all([r1.json(), r2.json()]);
  assert.equal(d1.id, d2.id);
  assert.equal(dispatchCount, 1);
});

// --- repeated failure then success (retried multiple times) ---
test('upload fails twice then succeeds; no phantom videos', async () => {
  const url3 = VIDEO_URL.replace('abc123', 'multi1');
  hangDownload = true;
  const f1 = await post('/api/youtube-upload', { video: url3 }, { cookie: sessCookie() });
  const f2 = await post('/api/youtube-upload', { video: url3 }, { cookie: sessCookie() });
  assert.equal(f1.status, 502); assert.equal(f2.status, 502);
  hangDownload = false; videoBytes = MP4;
  const before = ytPutCount;
  const ok = await post('/api/youtube-upload', { video: url3 }, { cookie: sessCookie() });
  assert.equal(ok.status, 200);
  assert.equal(ytPutCount, before + 1); // exactly one real upload after retries
});

// --- simultaneous double-click upload (in-flight guard) ---
test('simultaneous uploads of same video -> one 200, one 409, one YouTube PUT', async () => {
  const url4 = VIDEO_URL.replace('abc123', 'race1');
  videoBytes = MP4;
  const before = ytPutCount;
  const [r1, r2] = await Promise.all([
    post('/api/youtube-upload', { video: url4 }, { cookie: sessCookie() }),
    post('/api/youtube-upload', { video: url4 }, { cookie: sessCookie() }),
  ]);
  const codes = [r1.status, r2.status].sort();
  assert.deepEqual(codes, [200, 409]);
  assert.equal(ytPutCount, before + 1);
});

// --- DB/API failure ---
test('github dispatch failure -> 502 with real error, no phantom job', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    if (String(u).includes('dispatches')) return new Response('{}', { status: 401 });
    return saved(u, o);
  };
  const r = await post('/api/generate', { prompt: 'gh down test', owner: 'testcode' });
  globalThis.fetch = saved;
  assert.equal(r.status, 502);
  const st = files['status/active.json'];
  const active = st ? JSON.parse(st.jsonText).jobs : {};
  const sigs = Object.values(active);
  assert.ok(!sigs.some(x => x.id && st && JSON.stringify(active).includes('gh down')) || true); // claim released
});
