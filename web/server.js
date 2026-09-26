// Shorts AI Studio - free-tier host: UI + job dispatch. No secrets client-side.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PORT = process.env.PORT || 3000;
const GH_PAT = process.env.GH_PAT || '';
const REPO = process.env.GH_REPO || 'cikpa6701l-cmyk/shorts-render';
const OWNER = process.env.OWNER_CODE || '';
const ROOT = path.dirname(fileURLToPath(import.meta.url));

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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
  }
  if (req.method === 'GET' && u.pathname.startsWith('/api/status/')) {
    const id = u.pathname.split('/').pop().replace(/[^a-z0-9]/g, '');
    try {
      const r = await gh(`https://api.github.com/repos/${REPO}/contents/status/${id}.json`);
      if (!r.ok) { res.writeHead(404); return res.end('{"error":"not found"}'); }
      const d = await r.json();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(Buffer.from(d.content, 'base64').toString());
    } catch (e) { res.writeHead(500); return res.end('{"error":"status"}'); }
  }
  if (req.method === 'POST' && u.pathname === '/api/generate') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const j = JSON.parse(body || '{}');
        if (OWNER && String(j.owner||'').trim() !== OWNER.trim()) { res.writeHead(403); return res.end('{"error":"wrong passcode"}'); }
        const prompt = String(j.prompt || '').trim().slice(0, 300);
        if (!prompt) { res.writeHead(400); return res.end('{"error":"prompt required"}'); }
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const job = { id, prompt, seconds: Math.max(5, Math.min(30, +j.seconds || 10)), ratio: ['9:16','16:9','1:1'].includes(j.ratio) ? j.ratio : '9:16', quality: ['fast','high','ultra'].includes(j.quality) ? j.quality : 'fast', voice: !!j.voice, subtitles: j.subtitles !== false, camera: 'auto', style: 'cinematic' };
        await putStatus(id, { id, status: 'queued', prompt: job.prompt, ts: Date.now() });
        const d = await gh(`https://api.github.com/repos/${REPO}/actions/workflows/render.yml/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { job: JSON.stringify(job) } }) });
        if (!d.ok) { await putStatus(id, { id, status: 'failed', error: 'dispatch HTTP ' + d.status, ts: Date.now() }); res.writeHead(502); return res.end('{"error":"dispatch failed"}'); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id }));
      } catch (e) { res.writeHead(500); res.end('{"error":"server"}'); }
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});
server.listen(PORT, () => console.log('listening', PORT));
