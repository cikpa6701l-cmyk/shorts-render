// Shorts AI Studio render pipeline - runs on GitHub Actions. Node 22; workflow installs ffmpeg.
// Input: env JOB (JSON). Output: out/<id>.mp4 + out/segs/*, then POSTs everything to the CF worker.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import sharp from 'sharp';
import { Resvg } from '@resvg/resvg-js';

const job = JSON.parse(process.env.JOB);
const id = job.id;
const CB = process.env.CB_URL;           // e.g. https://shorts-ai-studio.pages.dev
const SECRET = process.env.JOB_SECRET;
const HF_TOKEN = process.env.HF_TOKEN || '';
const POLL_KEY = process.env.POLL_KEY || '';
const PIXAZO_KEY = process.env.PIXAZO_KEY || '';
const HF_SPACE = process.env.HF_SPACE_URL || 'https://lightricks-ltx-2-3.hf.space';
const FONT = path.join(process.cwd(), 'render', 'NotoSansTamil-Regular.ttf');
const out = (...p) => path.join('/tmp', 'job-' + id, ...p);
fs.mkdirSync(out('segs'), { recursive: true });

const run = (args) => new Promise((res, rej) => execFile('ffmpeg', args, { timeout: 600000, maxBuffer: 8e6 },
  (e, so, se) => e ? rej(new Error((se || e.message).slice(-600))) : res(so)));
const runCmd = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { timeout: 90000, maxBuffer: 8e6 },
  (e, so, se) => e ? rej(new Error((se || e.message || cmd).slice(-300))) : res(so)));
const BGM = path.join(process.cwd(), 'render', 'assets', 'bgm.mp3');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function status(stage, detail, extra) {
  await fetch(CB + '/api/job-status', { method: 'POST', headers: { 'content-type': 'application/json', 'x-job-secret': SECRET },
    body: JSON.stringify(Object.assign({ id, stage, detail }, extra || {})) }).catch(() => {});
}

async function fetchRetry(url, opts, tries, label) {
  let last;
  for (let i = 0; i < (tries || 4); i++) {
    try {
      const r = await fetch(url, opts);
      if (r.ok) return r;
      last = new Error(label + ' HTTP ' + r.status);
      if (r.status === 429 || r.status >= 500) { await sleep(20000 + i * 15000); continue; }
      throw last;
    } catch (e) { last = e; await sleep(8000); }
  }
  throw last;
}

async function hfUpload(buf, name) {
  const to = AbortSignal.timeout(45000);
  const fd = new FormData();
  fd.append('files', new Blob([buf], { type: 'image/jpeg' }), name);
  const r = await fetchRetry(HF_SPACE + '/gradio_api/upload', { method: 'POST', body: fd, signal: to }, 3, 'upload');
  const arr = await r.json();
  return arr[0];
}
let ltxUnavailable = false;
async function hfVideoOnce(serverPath, motionPrompt, seconds, height, width, enhance) {
  // A down ZeroGPU queue should not hold each scene for minutes. One bounded attempt per job.
  const deadline = AbortSignal.timeout(30000);
  const data = [{ path: serverPath, meta: { _type: 'gradio.FileData' } }, motionPrompt, seconds, enhance !== false, Math.floor(Math.random() * 1e9), true, height, width];
  const headers = { 'content-type': 'application/json' };
  if (HF_TOKEN) headers['Authorization'] = 'Bearer ' + HF_TOKEN;
  const r = await fetch(HF_SPACE + '/gradio_api/call/generate_video', { method: 'POST', headers, body: JSON.stringify({ data }), signal: deadline });
  if (!r.ok) throw new Error('hf call HTTP ' + r.status);
  const { event_id } = await r.json();
  if (!event_id) throw new Error('hf no event id');
  const rr = await fetch(`${HF_SPACE}/gradio_api/call/generate_video/${event_id}`, { headers, signal: deadline });
  if (!rr.ok) throw new Error('hf status HTTP ' + rr.status);
  const txt = await rr.text();
  if (txt.includes('event: error')) throw new Error('hf generation error');
  if (!txt.includes('event: complete')) throw new Error('hf did not complete in fast health window');
  const dataLine = txt.split('\n').filter(l => l.startsWith('data: ')).pop();
  const payload = JSON.parse(dataLine.slice(6));
  const v = payload[0] && (payload[0].video || payload[0]);
  const vurl = v && (v.url || v.path);
  if (!vurl) throw new Error('hf complete but no video url');
  const full = vurl.startsWith('http') ? vurl : HF_SPACE + '/gradio_api/file=' + vurl;
  const dl = await fetch(full, { headers, signal: AbortSignal.timeout(30000) });
  if (!dl.ok) throw new Error('hf download HTTP ' + dl.status);
  return Buffer.from(await dl.arrayBuffer());
}
async function hfVideo(...a) { return await hfVideoOnce(...a); }

// Pixazo free-tier LTX fallback: text-to-video only, landscape 1280x704 ~4.4s, no audio.
async function pixazoVideo(promptText) {
  if (!PIXAZO_KEY) throw new Error('no pixazo key');
  const h = { 'content-type': 'application/json', 'Ocp-Apim-Subscription-Key': PIXAZO_KEY };
  const r = await fetch('https://gateway.pixazo.ai/ltx-video/v1/text-to-video', { method: 'POST', headers: h,
    body: JSON.stringify({ prompt: String(promptText).slice(0, 800), duration: 6 }) });
  if (!r.ok) throw new Error('pixazo submit HTTP ' + r.status);
  const { request_id } = await r.json();
  if (!request_id) throw new Error('pixazo no request_id');
  for (let i = 0; i < 40; i++) {
    await sleep(15000);
    const sr = await fetch('https://gateway.pixazo.ai/v2/requests/status/' + request_id, { headers: h });
    const d = await sr.json();
    if (d.status === 'COMPLETED' && d.output && d.output.media_url && d.output.media_url[0]) {
      const dl = await fetch(d.output.media_url[0]);
      if (!dl.ok) throw new Error('pixazo download HTTP ' + dl.status);
      return Buffer.from(await dl.arrayBuffer());
    }
    if (d.status === 'ERROR' || d.status === 'FAILED') throw new Error('pixazo ' + d.status + ': ' + (d.error || ''));
  }
  throw new Error('pixazo timeout');
}

const CAMERA = { auto: '', pushin: 'slow cinematic camera push in', pullout: 'slow camera pull back revealing the scene', pan: 'smooth horizontal camera pan', orbit: 'camera slowly orbiting the subject', tracking: 'camera tracking alongside the action', static: 'static camera, only the scene moves' };
const STYLE = { cinematic: 'cinematic, film look, dramatic light', realistic: 'photorealistic, natural light', devotional: 'devotional, divine glow, warm golden light', anime: 'anime style', cartoon: 'stylized 3D animation look' };
const MOTION = { subtle: 'gentle, subtle motion', moderate: '', dynamic: 'energetic, dynamic motion, fast action' };

function dims(ratio, quality) {
  const base = { '16:9': [576, 1024], '1:1': [768, 768], '9:16': [1024, 576] }[ratio] || [1024, 576];
  const q = { fast: 0.8, high: 1.0, ultra: 1.25 }[job.quality] || 1.0;
  return [Math.round(base[0] * q / 16) * 16, Math.round(base[1] * q / 16) * 16];
}

async function planScenes(n) {
  const styleTxt = STYLE[job.style] || STYLE.cinematic;
  const neg = job.negative ? ' Avoid: ' + String(job.negative).slice(0, 120) + '.' : '';
  const mot = MOTION[job.motionStrength] || '';
  const cam = CAMERA[job.camera] ? ', ' + CAMERA[job.camera] : '';
  const ask = `Write a script for a ${n * 5}-second short video about: ${job.prompt}\nStyle: ${styleTxt}. Motion: ${mot || 'natural'}.${neg}\nReturn ONLY JSON like {"scenes":[{"visual":"detailed vivid image prompt","motion":"how the camera and scene should move","text":"on-screen subtitle, max 8 words","say":"spoken narration line, max 15 words"}]} with exactly ${n} scenes.`;
  try {
    const r = await fetchRetry('https://text.pollinations.ai/' + encodeURIComponent(ask), {}, 2, 'script');
    const m = (await r.text()).match(/\{[\s\S]*\}/);
    const scenes = (JSON.parse(m[0]).scenes || []).slice(0, n).map(s => ({
      visual: String(s.visual || job.prompt),
      motion: String(s.motion || 'slow cinematic camera push in, natural motion') + cam,
      text: String(s.text || '').slice(0, 60),
      say: String(s.say || s.text || '').slice(0, 120)
    }));
    while (scenes.length < n) scenes.push({ visual: job.prompt, motion: 'slow cinematic camera push in' + cam, text: '', say: '' });
    return scenes;
  } catch (e) {
    // Script service down: fall back to a simple deterministic plan so generation still works.
    console.log('[fallback] script planner unavailable:', String(e.message || e).slice(0, 120));
    const beats = ['establishing wide shot', 'closer view, key subject in focus', 'detail shot, rich texture', 'final heroic frame'];
    const devotional = /murugan|muruga|vel|devotional|peacock|tamil/i.test(String(job.prompt));
    const fixedSay = devotional
      ? ['முருகா, உமது அருள் எப்போதும் எம்முடன் இருக்கட்டும்.', 'வேல் எந்தும் வெற்றி தரும்.', 'அருள் ஒளி எங்கும் பரவட்டும்.', 'பக்தியுடன் முன்னேறுவோம்.']
      : ['A moment worth remembering.', 'Every frame tells the story.', 'Watch closely, the scene unfolds.', 'And this is where it all comes together.'];
    const out = [];
    for (let i = 0; i < n; i++) out.push({
      visual: `${job.prompt}, ${beats[Math.min(i, beats.length - 1)]}, ${styleTxt}`,
      motion: ('slow cinematic camera push in, natural motion' + cam).trim(),
      text: i === 0 ? String(job.prompt).slice(0, 40) : '',
      say: fixedSay[i % fixedSay.length]
    });
    return out;
  }
}

async function sceneImage(visual, seed) {
  const styleTxt = STYLE[job.style] || STYLE.cinematic;
  const u = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(visual + ', ' + styleTxt + ', high quality') + `?width=810&height=1440&nologo=true&seed=${seed}&model=flux`;
  const headers = POLL_KEY ? { 'Authorization': 'Bearer ' + POLL_KEY } : {};
  const r = await fetchRetry(u, { headers }, 4, 'image');
  const img = Buffer.from(await r.arrayBuffer());
  return sharp(img).resize(810, 1440, { fit: 'cover' }).extract({ left: 0, top: 0, width: 810, height: 1368 }).jpeg().toBuffer();
}

function subPng(text, width) {
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = []; let cur = "";
  for (const w of words) { if ((cur + " " + w).trim().length > 24 && cur) { lines.push(cur); cur = w; } else cur = (cur ? cur + " " : "") + w; }
  if (cur) lines.push(cur);
  const fsize = Math.round(width / 16);
  const lh = Math.round(fsize * 1.5);
  const H = lh * lines.length + Math.round(fsize * 0.6);
  const spans = lines.map((l, i) => '<text x="50%" y="' + Math.round(fsize * 1.2 + i * lh) + '" font-family="Noto Sans Tamil" font-weight="bold" font-size="' + fsize + '" fill="#FFF3B0" stroke="black" stroke-width="' + Math.max(2, Math.round(fsize / 11)) + '" style="paint-order:stroke">' + esc(l) + "</text>").join("");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + H + '">' + spans + "</svg>";
  return new Resvg(svg, { font: { fontFiles: [FONT], loadSystemFonts: false, defaultFontFamily: "Noto Sans Tamil" }, background: "rgba(0,0,0,0)" }).render().asPng();
}


function subAss(text, ww, hh) {
  const fsize = Math.max(26, Math.round(ww / 15));
  const marginV = Math.round(hh / 9);
  const marginLR = Math.round(ww * 0.08);
  const outline = Math.max(2, Math.round(fsize / 11));
  const safe = String(text).replace(/[{}]/g, '').replace(/\r?\n/g, '\\N');
  return '[Script Info]\nScriptType: v4.00+\nPlayResX: ' + ww + '\nPlayResY: ' + hh + '\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n' +
    '[V4+ Styles]\n' +
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    'Style: Sub,Noto Sans Tamil,' + fsize + ',&H00B0F3FF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,' + outline + ',0,2,' + marginLR + ',' + marginLR + ',' + marginV + ',1\n\n' +
    '[Events]\n' +
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
    'Dialogue: 0,0:00:00.00,9:59:59.00,Sub,,0,0,0,,' + safe + '\n';
}

async function tts(text) {
  // edge-tts: free Microsoft Edge Tamil neural voice (no key needed)
  try {
    const f = out('vo_edge.mp3');
    await runCmd('python3', ['-m', 'edge_tts', '--voice', 'ta-IN-ValluvarNeural', '--text', text.slice(0, 600), '--write-media', f]);
    const buf = fs.readFileSync(f);
    if (buf.length > 1000) return buf;
  } catch (e) { console.log('[voice] edge-tts failed:', String(e.message || e).slice(0, 120)); }
  if (!POLL_KEY) return null;
  try {
    const r = await fetch('https://gen.pollinations.ai/v1/audio/speech', { method: 'POST',
      headers: { 'Authorization': 'Bearer ' + POLL_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', voice: 'alloy', input: text.slice(0, 600), response_format: 'mp3' }) });
    if (r.ok) return Buffer.from(await r.arrayBuffer());
  } catch {}
  return null;
}

async function buildSeg(i, imgBuf, scene, per, hh, ww) {
  let clip, usedFallback = false;
  try {
    if (ltxUnavailable) throw new Error('LTX-2 unavailable earlier in this job');
    const sp = await hfUpload(imgBuf, 'scene' + i + '.jpg');
    clip = await hfVideo(sp, scene.motion + ', cinematic realistic motion', Math.min(10, Math.max(3, Math.round(per))), hh, ww, job.enhance);
  } catch (e) {
    ltxUnavailable = true;
    console.log('[fallback] LTX-2 HF failed, switching to Pixazo ltx-video:', String(e.message || e).slice(0, 160));
    await status('Generating real motion (backup engine)', `scene ${i + 1} - main engine down, using backup`);
    clip = await pixazoVideo(scene.visual + ', ' + scene.motion);
    usedFallback = true; globalThis._engineUsed = 'pixazo-ltx-fallback';
  }
  fs.writeFileSync(out('clip' + i + '.mp4'), clip);
  if (usedFallback) {
    // pixazo output is 1280x704 landscape, no audio: center-crop to target ratio, scale to target dims, attach silence
    const cw = Math.min(1280, Math.floor(704 * ww / hh / 2) * 2);
    await run(['-i', out('clip' + i + '.mp4'), '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-filter_complex', `[0:v]crop=${cw}:704,scale=${ww}:${hh}:flags=lanczos,setsar=1[v]`,
      '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', '-y', out('clipn' + i + '.mp4')]);
    fs.renameSync(out('clipn' + i + '.mp4'), out('clip' + i + '.mp4'));
  }
  const args = ['-stream_loop', '-1', '-i', out('clip' + i + '.mp4')];
  let vmap = '0:v', extra = 0, fc = '';
  if (job.subtitles !== false && scene.text) {
    const ap = out('sub' + i + '.ass');
    fs.writeFileSync(ap, subAss(scene.text, ww, hh));
    // libass (HarfBuzz) shapes Tamil correctly; margins keep glyphs off the edges
    fc = `[0:v]subtitles='${ap}':fontsdir='${path.dirname(FONT)}'[v]`;
    vmap = '[v]';
  }
  let aout = '0:a?';
  if (job.voice && scene.say) {
    const v = await tts(scene.say);
    if (v) {
      fs.writeFileSync(out('vo' + i + '.mp3'), v);
      args.push('-i', out('vo' + i + '.mp3'));
      const vi = 1 + extra;
      fc = (fc ? fc + ';' : '') + `[0:a]volume=0.3[amb];[${vi}:a]volume=1.2[vo];[amb][vo]amix=inputs=2:duration=first:normalize=0[aout]`;
      aout = '[aout]';
    }
  }
  if (fc) args.push('-filter_complex', fc);
  args.push('-map', vmap, '-map', aout, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-t', String(per), '-y', out('segs', i + '.mp4'));
  await run(args);
}

(async () => {
  try {
    await status('Starting', '');
    const seconds = Math.max(5, Math.min(30, Number(job.seconds) || 10));
    const ratio = ['9:16', '16:9', '1:1'].includes(job.ratio) ? job.ratio : '9:16';
    const [hh, ww] = dims(ratio, job.quality);
    let scenes;
    if (job.regen) {
      scenes = job.scenes;
    } else if (job.image_b64) {
      scenes = [{ visual: job.prompt, motion: [job.prompt, CAMERA[job.camera], 'cinematic realistic motion'].filter(Boolean).join(', '), text: '', say: '' }];
    } else if (String(job.prompt).startsWith('SCRIPT:')) {
      const nm = String(job.prompt).slice(7).replace(/[^a-z0-9-]/gi, '');
      const spec = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'render', 'scripts', nm + '.json'), 'utf8'));
      scenes = spec.scenes.map(s => ({ visual: String(s.visual), motion: String(s.motion || 'slow cinematic camera push in, natural motion'), text: String(s.text || ''), say: String(s.say || ''), dur: Number(s.dur) || 0 }));
    } else {
      await status('Writing script and scene plan', '');
      scenes = await planScenes(Math.max(2, Math.min(6, Math.round(seconds / 5))));
    }
    const per = seconds / scenes.length;
    var engineUsed = 'ltx2';
    Object.defineProperty(globalThis, '_engineUsed', { get: () => engineUsed, set: v => { engineUsed = v; }, configurable: true });
    const todo = job.regen ? [job.regen] : scenes.map((_, i) => i);
    for (const i of todo) {
      await status(`Generating real motion (LTX-2)`, `scene ${i + 1} of ${scenes.length}`);
      let img;
      if (job.image_b64) {
        img = await sharp(Buffer.from(String(job.image_b64).replace(/^data:image\/\w+;base64,/, ''), 'base64')).resize(ww, hh, { fit: 'cover' }).jpeg().toBuffer();
      } else if (job.regen && job.sceneImages && job.sceneImages[i]) {
        img = Buffer.from(job.sceneImages[i], 'base64');
      } else if (i > 0 && !job.regen) {
        // scene chaining: last frame of previous clip seeds this scene
        try {
          await run(['-sseof', '-0.1', '-i', out('clip' + (i - 1) + '.mp4'), '-frames:v', '1', '-q:v', '3', '-y', out('last.jpg')]);
          img = await sharp(out('last.jpg')).resize(810, 1440, { fit: 'cover' }).jpeg().toBuffer();
        } catch { img = await sceneImage(scenes[i].visual, 3000 + i); }
      } else {
        img = await sceneImage(scenes[i].visual, 3000 + i);
      }
      fs.writeFileSync(out('img' + i + '.jpg'), img);
      await buildSeg(i, img, scenes[i], (scenes[i].dur || per), hh, ww);
    }
    await status('Joining scenes', '');
    // regen: other segs are downloaded from KV by the workflow before this step
    const list = scenes.map((_, i) => `file '${out('segs', i + '.mp4')}'`).join('\n');
    fs.writeFileSync(out('list.txt'), list);
    await run(['-f', 'concat', '-safe', '0', '-i', out('list.txt'), '-c', 'copy', '-movflags', '+faststart', '-y', out('joined.mp4')]);
    if (fs.existsSync(BGM)) {
      // free-licensed ambient bg (Kevin MacLeod, CC-BY 4.0) looped low under voice + soft bell at start
      await run(['-i', out('joined.mp4'), '-stream_loop', '-1', '-i', BGM,
        '-f', 'lavfi', '-t', '2.2', '-i', 'sine=frequency=880:sample_rate=44100', '-f', 'lavfi', '-t', '3.5', '-i', 'sine=frequency=1046:sample_rate=44100',
        '-filter_complex', '[1:a]volume=0.16[bg];[2:a]afade=t=out:st=0:d=2.2,volume=0.30[bell];[3:a]adelay=26000|26000,afade=t=out:st=1.2:d=2.3,volume=0.38[bell2];[0:a][bg][bell][bell2]amix=inputs=4:duration=first:dropout_transition=2:normalize=0[am];[am]alimiter=limit=0.891251[a]',
        '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-y', out('final.mp4')]);
    } else { fs.renameSync(out('joined.mp4'), out('final.mp4')); }
    const buf = fs.readFileSync(out('final.mp4'));
    await status('Uploading', '');
    // Deliver via GitHub release asset (persistent public URL) + status JSON commit (UI polls raw file)
    const GT = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY;
    const ghH = { 'Authorization': 'Bearer ' + GT, 'Accept': 'application/vnd.github+json', 'content-type': 'application/json' };
    let rel = await (await fetch(`https://api.github.com/repos/${repo}/releases/tags/videos`, { headers: ghH })).json();
    if (!rel.id) {
      rel = await (await fetch(`https://api.github.com/repos/${repo}/releases`, { method: 'POST', headers: ghH, body: JSON.stringify({ tag_name: 'videos', name: 'Generated videos' }) })).json();
    }
    const up = await fetch(rel.upload_url.replace('{?name,label}', '') + '?name=job-' + id + '.mp4', { method: 'POST', headers: { 'Authorization': 'Bearer ' + GT, 'content-type': 'video/mp4' }, body: buf });
    const asset = await up.json();
    if (!asset.browser_download_url) throw new Error('release asset upload failed: ' + JSON.stringify(asset).slice(0, 200));
    const videoUrl = asset.browser_download_url;
    const st = { id, status: 'ready', video: videoUrl, engine: engineUsed, scenes: scenes.length, seconds, ratio, prompt: String(job.prompt).slice(0, 200), ts: Date.now() };
    const sc = Buffer.from(JSON.stringify(st)).toString('base64');
    const cur = await (await fetch(`https://api.github.com/repos/${repo}/contents/status/${id}.json`, { headers: ghH })).json();
    const putBody = { message: 'status ' + id, content: sc };
    if (cur && cur.sha) putBody.sha = cur.sha;
    const pr = await fetch(`https://api.github.com/repos/${repo}/contents/status/${id}.json`, { method: 'PUT', headers: ghH, body: JSON.stringify(putBody) });
    if (!pr.ok) throw new Error('status commit HTTP ' + pr.status);
    await status('Done', '', { status: 'ready', size: buf.length });
    console.log('JOB DONE', id, buf.length);
  } catch (e) {
    console.error('JOB FAIL', e);
    await status('failed', String(e.message || e).slice(0, 300), { status: 'failed', error: String(e.message || e).slice(0, 300) });
    try {
      const GT = process.env.GITHUB_TOKEN; const repo = process.env.GITHUB_REPOSITORY;
      const ghH = { 'Authorization': 'Bearer ' + GT, 'Accept': 'application/vnd.github+json', 'content-type': 'application/json' };
      const st = { id, status: 'failed', error: String(e.message || e).slice(0, 300), ts: Date.now() };
      const sc = Buffer.from(JSON.stringify(st)).toString('base64');
      const cur = await (await fetch(`https://api.github.com/repos/${repo}/contents/status/${id}.json`, { headers: ghH })).json();
      const putBody = { message: 'status ' + id, content: sc };
      if (cur && cur.sha) putBody.sha = cur.sha;
      await fetch(`https://api.github.com/repos/${repo}/contents/status/${id}.json`, { method: 'PUT', headers: ghH, body: JSON.stringify(putBody) });
    } catch {}
    process.exit(1);
  }
})();
