// Shorts AI Studio - free-tier host: UI + job dispatch + owner Google session.
// No secrets client-side. Owner auth: official Google OAuth 2.0 (offline refresh token,
// encrypted at rest in the render repo) or the legacy passcode. Passwords are never stored.
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const PORT = process.env.PORT || 3000;
const GH_PAT = process.env.GH_PAT || '';
const REPO = process.env.GH_REPO || 'cikpa6701l-cmyk/shorts-render';
const OWNER = process.env.OWNER_CODE || '';
const G_CID = process.env.GOOGLE_CLIENT_ID || '';
const G_SEC = process.env.GOOGLE_CLIENT_SECRET || '';
const S_SEC = process.env.SESSION_SECRET || '';
const BASE = (process.env.BASE_URL || 'https://shorts-ai-studio.onrender.com').replace(/\/$/, '');
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = 'secrets/tokens.json.enc';
const SESSION_DAYS = 30;

const ghH = { 'Authorization': 'Bearer ' + GH_PAT, 'Accept': 'application/vnd.github+json', 'content-type': 'application/json', 'User-Agent': 'shorts-studio' };
async function gh(url, opts) { return fetch(url, Object.assign({ headers: ghH }, opts || {})); }

async function putStatus(id, st) {
  const p = `https://api.github.com/repos/${REPO}/contents/status/${id}.json`;
  const cur = await (await gh(p)).json().catch(() => ({}));
  const body = { message: 'status ' + id, content: Buffer.from(JSON.stringify(st)).toString('base64') };
  if (cur && cur.sha) body.sha = cur.sha;
  const r = await gh(p, { method: 'PUT', body: JSON.stringify(body) });
  return r.ok;
}

// ---------- crypto helpers (AES-256-GCM, key derived from env-only secrets) ----------
const encKey = () => crypto.createHash('sha256').update(S_SEC + '|' + OWNER).digest();
function enc(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function dec(b64) {
  const raw = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
}

// ---------- token store (encrypted blob in the render repo so it survives restarts) ----------
let tokCache = null, tokLoaded = false;
async function loadTokens() {
  if (tokLoaded) return tokCache;
  tokLoaded = true;
  try {
    const r = await gh(`https://api.github.com/repos/${REPO}/contents/${TOKEN_PATH}`);
    if (r.ok) { const d = await r.json(); tokCache = dec(Buffer.from(d.content, 'base64').toString()); }
  } catch (e) { console.log('token load failed:', String(e.message || e).slice(0, 120)); tokCache = null; }
  return tokCache;
}
async function saveTokens(t) {
  tokCache = t; tokLoaded = true;
  const p = `https://api.github.com/repos/${REPO}/contents/${TOKEN_PATH}`;
  const cur = await (await gh(p)).json().catch(() => ({}));
  const body = { message: 'owner token update', content: Buffer.from(enc(t)).toString('base64') };
  if (cur && cur.sha) body.sha = cur.sha;
  await gh(p, { method: 'PUT', body: JSON.stringify(body) });
}
let atCache = { token: '', exp: 0 };
async function getAccessToken() {
  if (atCache.token && atCache.exp > Date.now() + 300000) return atCache.token;
  const t = await loadTokens();
  if (!t || !t.refresh_token) { const e = new Error('needsAuth'); e.code = 'needsAuth'; throw e; }
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: G_CID, client_secret: G_SEC, refresh_token: t.refresh_token, grant_type: 'refresh_token' }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) {
    if (d.error === 'invalid_grant') { await saveTokens(null).catch(() => {}); tokCache = null; }
    const e = new Error(d.error === 'invalid_grant' ? 'needsAuth' : 'token refresh failed: ' + (d.error || r.status));
    if (d.error === 'invalid_grant') e.code = 'needsAuth';
    throw e;
  }
  atCache = { token: d.access_token, exp: Date.now() + (d.expires_in || 3500) * 1000 };
  return atCache.token;
}

// ---------- signed session cookie ----------
function sign(v) { return crypto.createHmac('sha256', S_SEC).update(v).digest('base64url'); }
function setCookie(res, name, val, maxAge) {
  res.setHeader('set-cookie', (res.getHeader('set-cookie') || []).concat(
    `${name}=${val}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`));
}
function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return out;
}
function sessionUser(req) {
  if (!S_SEC) return null;
  const c = cookies(req).sssess || '';
  const i = c.lastIndexOf('.');
  if (i < 1) return null;
  const payload = c.slice(0, i), sig = c.slice(i + 1);
  const expect = sign(payload);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try { const u = JSON.parse(Buffer.from(payload, 'base64url').toString()); return u.exp > Date.now() ? u : null; } catch { return null; }
}
function makeSession(res, u) {
  const payload = Buffer.from(JSON.stringify({ email: u.email || '', name: u.name || '', picture: u.picture || '', exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  setCookie(res, 'sssess', payload + '.' + sign(payload), SESSION_DAYS * 86400);
}

function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const sess = sessionUser(req);

  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
  }

  // ---------- auth ----------
  if (req.method === 'GET' && u.pathname === '/auth/google') {
    if (!G_CID || !G_SEC || !S_SEC) return json(res, 500, { error: 'oauth not configured' });
    const state = crypto.randomBytes(16).toString('hex');
    setCookie(res, 'ssstate', state, 600);
    const q = new URLSearchParams({ client_id: G_CID, redirect_uri: BASE + '/auth/google/callback', response_type: 'code',
      scope: 'openid email profile https://www.googleapis.com/auth/youtube.upload', access_type: 'offline', prompt: 'consent', state });
    res.writeHead(302, { location: 'https://accounts.google.com/o/oauth2/v2/auth?' + q });
    return res.end();
  }
  if (req.method === 'GET' && u.pathname === '/auth/google/callback') {
    try {
      if (!S_SEC) throw new Error('oauth not configured');
      if ((u.searchParams.get('state') || '') !== (cookies(req).ssstate || '')) throw new Error('bad state');
      const code = u.searchParams.get('code') || '';
      if (!code) throw new Error('no code');
      const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: G_CID, client_secret: G_SEC, code, grant_type: 'authorization_code', redirect_uri: BASE + '/auth/google/callback' }) });
      const td = await tr.json().catch(() => ({}));
      if (!tr.ok || !td.access_token) throw new Error('token exchange failed: ' + (td.error || tr.status));
      let profile = {};
      const parts = String(td.id_token || '').split('.');
      if (parts.length === 3) { try { profile = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch {} }
      const prev = await loadTokens().catch(() => null);
      const rt = td.refresh_token || (prev && prev.refresh_token) || '';
      if (rt) await saveTokens({ refresh_token: rt, email: profile.email || (prev && prev.email) || '', saved_at: Date.now() });
      makeSession(res, { email: profile.email || '', name: profile.name || '', picture: profile.picture || '' });
      setCookie(res, 'ssstate', '', 0);
      res.writeHead(302, { location: '/' });
      return res.end();
    } catch (e) {
      res.writeHead(302, { location: '/?auth_error=' + encodeURIComponent(String(e.message || e).slice(0, 120)) });
      return res.end();
    }
  }
  if (req.method === 'GET' && u.pathname === '/auth/logout') {
    setCookie(res, 'sssess', '', 0);
    res.writeHead(302, { location: '/' });
    return res.end();
  }
  if (req.method === 'GET' && u.pathname === '/api/session') {
    const t = await loadTokens().catch(() => null);
    return json(res, 200, { loggedIn: !!sess, email: sess ? sess.email : '', name: sess ? sess.name : '', youtube: !!(t && t.refresh_token) });
  }

  // ---------- status proxy ----------
  if (req.method === 'GET' && u.pathname.startsWith('/api/status/')) {
    const id = u.pathname.split('/').pop().replace(/[^a-z0-9]/g, '');
    try {
      const r = await gh(`https://api.github.com/repos/${REPO}/contents/status/${id}.json`);
      if (!r.ok) return json(res, 404, { error: 'not found' });
      const d = await r.json();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(Buffer.from(d.content, 'base64').toString());
    } catch (e) { return json(res, 500, { error: 'status' }); }
  }

  // ---------- generate (session cookie OR passcode) ----------
  if (req.method === 'POST' && u.pathname === '/api/generate') {
    const body = await readBody(req);
    try {
      const j = JSON.parse(body || '{}');
      const passOk = OWNER && String(j.owner || '').trim() === OWNER.trim();
      if (!sess && !passOk) return json(res, 403, { error: 'wrong passcode' });
      const prompt = String(j.prompt || '').trim().slice(0, 300);
      if (!prompt) return json(res, 400, { error: 'prompt required' });
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const job = { id, prompt, seconds: Math.max(5, Math.min(30, +j.seconds || 10)), ratio: ['9:16','16:9','1:1'].includes(j.ratio) ? j.ratio : '9:16', quality: ['fast','high','ultra'].includes(j.quality) ? j.quality : 'fast', voice: !!j.voice, subtitles: j.subtitles !== false, camera: 'auto', style: 'cinematic' };
      await putStatus(id, { id, status: 'queued', prompt: job.prompt, ts: Date.now() });
      const d = await gh(`https://api.github.com/repos/${REPO}/actions/workflows/render.yml/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { job: JSON.stringify(job) } }) });
      if (!d.ok) { await putStatus(id, { id, status: 'failed', error: 'dispatch HTTP ' + d.status, ts: Date.now() }); return json(res, 502, { error: 'dispatch failed' }); }
      return json(res, 200, { id });
    } catch (e) { return json(res, 500, { error: 'server' }); }
  }

  // ---------- YouTube upload (session required, explicit click only, uploads as PRIVATE) ----------
  if (req.method === 'POST' && u.pathname === '/api/youtube-upload') {
    if (!sess) return json(res, 401, { error: 'sign in first', needsAuth: true });
    const body = await readBody(req);
    try {
      const j = JSON.parse(body || '{}');
      const videoUrl = String(j.video || '');
      if (!/^https:\/\/github\.com\/cikpa6701l-cmyk\/shorts-render\/releases\/download\/videos\/job-[a-z0-9]+\.mp4$/.test(videoUrl)) return json(res, 400, { error: 'bad video url' });
      const title = String(j.title || 'Shorts AI Studio video').slice(0, 95) || 'Shorts AI Studio video';
      const desc = String(j.description || '').slice(0, 800);
      const at = await getAccessToken();
      const vr = await fetch(videoUrl);
      if (!vr.ok) throw new Error('video download failed');
      const vbuf = Buffer.from(await vr.arrayBuffer());
      const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + at, 'content-type': 'application/json', 'x-upload-content-type': 'video/mp4', 'x-upload-content-length': String(vbuf.length) },
        body: JSON.stringify({ snippet: { title, description: desc, categoryId: '22' }, status: { privacyStatus: 'private', selfDeclaredMadeForKids: false } }) });
      if (!init.ok) throw new Error('youtube init HTTP ' + init.status + ' ' + (await init.text()).slice(0, 200));
      const loc = init.headers.get('location');
      if (!loc) throw new Error('no upload location');
      const up = await fetch(loc, { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(vbuf.length) }, body: vbuf });
      const ud = await up.json().catch(() => ({}));
      if (!up.ok || !ud.id) throw new Error('youtube upload HTTP ' + up.status + ' ' + JSON.stringify(ud).slice(0, 200));
      return json(res, 200, { youtubeId: ud.id, url: 'https://www.youtube.com/watch?v=' + ud.id, privacy: 'private' });
    } catch (e) {
      if (e.code === 'needsAuth') return json(res, 401, { error: 'google session expired - sign in again', needsAuth: true });
      return json(res, 502, { error: String(e.message || e).slice(0, 250) });
    }
  }

  res.writeHead(404); res.end('not found');
});
server.listen(PORT, () => console.log('listening', PORT));
