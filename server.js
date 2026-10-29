#!/usr/bin/env node
// Sprite Studio: local web UI for the sprite pipeline — prompt a sprite,
// generate it, review the animation, export it.
//
// Generation runs scripts/generate-sprites.js as a child process, one job at a
// time so a character's state.json never has two writers; the browser polls
// the job log. Binds to localhost only: it spends Apiframe credits.
//
// Usage: node server.js   (or npm run studio) → http://localhost:5178

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { VIDEO_MODELS, DEFAULTS, SPRITES_DIR, allSprites, pickDuration, parseKeyframeSource } = require('./scripts/generate-sprites');
const { PROVIDER_INFO } = require('./scripts/lib/providers');
const { SPRITE_STYLE, PRESET_ANIMATIONS } = require('./scripts/sprite-prompts');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5178;
const WEB_DIR = path.join(ROOT, 'web');
const EXPORT_DIR = path.join(ROOT, 'exports');
const SCRIPT = path.join(ROOT, 'scripts', 'generate-sprites.js');
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.svg': 'image/svg+xml' };

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function mtime(file) {
  try { return Math.round(fs.statSync(file).mtimeMs); } catch { return null; }
}

// ---- jobs ------------------------------------------------------------------

const jobs = new Map();
const queue = [];
let running = null;
let nextJobId = 1;

// Translates a job request from the UI into generate-sprites.js flags.
function cliArgs(body) {
  if (!ID_RE.test(body.id || '')) throw httpError(400, 'Invalid sprite id');
  const args = [`--id=${body.id}`];
  const anims = (body.anims || []).filter(a => ID_RE.test(a));
  if (anims.length) args.push(`--anim=${anims.join(',')}`);
  if (body.model) {
    if (!VIDEO_MODELS[body.model]) throw httpError(400, `Unknown model ${body.model}`);
    args.push(`--model=${body.model}`);
  }
  if (body.matte) {
    if (!['chroma', 'bria'].includes(body.matte)) throw httpError(400, 'matte must be chroma or bria');
    args.push(`--matte=${body.matte}`);
  }
  for (const key of ['frames', 'fps', 'despeckle', 'height', 'variant']) {
    const v = body[key];
    if (v == null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 10000) throw httpError(400, `Invalid ${key}`);
    args.push(`--${key}=${n}`);
  }
  const regen = (body.regen || []).filter(r => r === 'keyframe' || r === 'video');
  if (regen.length) args.push(`--regen=${regen.join(',')}`);
  return args;
}

function publicJob(job) {
  const { child, ...rest } = job;
  return rest;
}

function enqueue(body) {
  const job = { id: String(nextJobId++), sprite: body.id, anims: body.anims || [], label: body.label || 'Generate', args: cliArgs(body), status: 'queued', log: '', createdAt: Date.now() };
  jobs.set(job.id, job);
  queue.push(job);
  pump();
  return job;
}

function pump() {
  if (running || !queue.length) return;
  const job = running = queue.shift();
  job.status = 'running';
  job.startedAt = Date.now();
  job.log += `$ node scripts/generate-sprites.js ${job.args.join(' ')}\n`;
  const child = spawn(process.execPath, [SCRIPT, ...job.args], { cwd: ROOT });
  job.child = child;
  const append = d => { job.log = (job.log + d.toString()).slice(-200000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('close', code => {
    job.status = job.cancelled ? 'cancelled' : code === 0 ? 'done' : 'failed';
    job.exitCode = code;
    job.finishedAt = Date.now();
    delete job.child;
    running = null;
    pump();
  });
}

// Stopping mid-poll is safe: the paid job id is already in state.json, so
// the next run resumes it instead of paying again.
function cancel(job) {
  job.cancelled = true;
  if (job.status === 'queued') {
    queue.splice(queue.indexOf(job), 1);
    job.status = 'cancelled';
  } else if (job.child) {
    job.child.kill();
  }
}

function dryRun(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args, '--dry-run'], { cwd: ROOT });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => {
      if (code !== 0) return reject(httpError(400, out.trim()));
      const m = out.match(/~(\d+) credits/);
      resolve({ plan: out.trim(), credits: m ? Number(m[1]) : 0 });
    });
  });
}

// ---- sprites ---------------------------------------------------------------

function describeSprite(id, def) {
  const dir = path.join(SPRITES_DIR, id);
  const work = path.join(dir, '_work');
  const state = readJson(path.join(work, 'state.json')) || { keyframe: {}, anims: {} };
  const names = (def ? def.animations : []).map(a => a.name);
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const name = f.slice(0, -5);
      if (f.endsWith('.json') && f !== 'sprite.json' && !names.includes(name)) names.push(name);
    }
  }
  const url = (...parts) => `/sprites/${[id, ...parts].join('/')}`;
  const animations = names.map(name => {
    const sheetJson = path.join(dir, `${name}.json`);
    const sheetTime = mtime(sheetJson);
    const exportTime = mtime(path.join(EXPORT_DIR, id, `${name}.json`));
    const video = (state.anims && state.anims[name] && state.anims[name].video) || null;
    return {
      name,
      def: def ? def.animations.find(a => a.name === name) || null : null,
      sheet: sheetTime ? {
        json: `${url(name + '.json')}?v=${sheetTime}`,
        png: `${url(name + '.png')}?v=${sheetTime}`,
        webp: `${url(name + '.webp')}?v=${sheetTime}`,
        updatedAt: sheetTime,
        meta: (readJson(sheetJson) || {}).meta || null
      } : null,
      video: fs.existsSync(path.join(work, name, 'video.mp4')) ? url('_work', name, 'video.mp4') : null,
      videoPending: !!(video && video.jobId && !video.result),
      exportedAt: exportTime,
      exportStale: !!(exportTime && sheetTime && sheetTime > exportTime)
    };
  });
  const variantsDir = path.join(work, 'variants');
  const variants = fs.existsSync(variantsDir)
    ? fs.readdirSync(variantsDir).filter(f => f.endsWith('.png')).sort().map(f => url('_work', 'variants', f))
    : [];
  const source = (state.keyframe && state.keyframe.source) || '';
  const keyframeTime = mtime(path.join(work, 'keyframe.png'));
  return {
    id,
    name: def ? def.name : id,
    subject: def ? def.subject || null : null,
    prompt: def ? def.prompt || null : null,
    image: def ? def.image || null : null,
    model: def ? def.model || null : null,
    builtIn: !!(def && def.builtIn),
    defined: !!def,
    keyframe: keyframeTime ? `${url('_work', 'keyframe.png')}?v=${keyframeTime}` : null,
    variant: parseKeyframeSource(source) ? parseKeyframeSource(source).variant : null,
    variants,
    animations
  };
}

function listSprites() {
  const defs = allSprites();
  const ids = defs.map(d => d.id);
  if (fs.existsSync(SPRITES_DIR)) {
    for (const d of fs.readdirSync(SPRITES_DIR)) {
      if (!ids.includes(d) && fs.statSync(path.join(SPRITES_DIR, d)).isDirectory()) ids.push(d);
    }
  }
  return ids.map(id => describeSprite(id, defs.find(d => d.id === id)));
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// Saves (or updates) a UI-defined character as assets/sprites/<id>/sprite.json.
function saveSprite(body) {
  const id = String(body.id || '');
  if (!ID_RE.test(id)) throw httpError(400, 'Id must be lowercase letters, digits, - or _');
  const existing = allSprites().find(s => s.id === id);
  if (existing && existing.builtIn) throw httpError(409, `"${id}" is defined in scripts/sprite-prompts.js — edit it there`);
  const subject = String(body.subject || '').trim();
  if (!subject) throw httpError(400, 'Describe the character');
  if (subject.length > 3000) throw httpError(400, 'Prompt is too long');
  const animations = (body.animations || []).map(a => {
    if (!ID_RE.test(a.name || '')) throw httpError(400, `Invalid animation name "${a.name}"`);
    const motion = String(a.motion || '').trim();
    if (!motion) throw httpError(400, `Describe the ${a.name} motion`);
    return {
      name: a.name,
      motion: motion.slice(0, 1500),
      frames: Math.round(clampNum(a.frames, 1, 64, 12)),
      fps: clampNum(a.fps, 1, 60, 12),
      cycle: a.cycle !== false,
      minCycle: clampNum(a.minCycle, 0.2, 5, 0.8),
      scale: clampNum(a.scale, 0.3, 0.8, 0.6)
    };
  });
  if (!animations.length) throw httpError(400, 'Pick at least one animation');
  if (new Set(animations.map(a => a.name)).size !== animations.length) throw httpError(400, 'Animation names must be unique');
  const def = {
    id,
    name: String(body.name || id).slice(0, 80),
    subject,
    useStyle: body.useStyle !== false,
    prompt: body.useStyle !== false ? `${subject}, ${SPRITE_STYLE}` : subject,
    ...(VIDEO_MODELS[body.model] && { model: body.model }),
    animations
  };
  fs.mkdirSync(path.join(SPRITES_DIR, id), { recursive: true });
  fs.writeFileSync(path.join(SPRITES_DIR, id, 'sprite.json'), JSON.stringify(def, null, 2));
  return describeSprite(id, { ...def, builtIn: false });
}

// Copies an approved sheet (png + json + webp) into exports/<id>/.
function exportAnim(body) {
  const { id, anim } = body;
  if (!ID_RE.test(id || '') || !ID_RE.test(anim || '')) throw httpError(400, 'Invalid id');
  const outDir = path.join(EXPORT_DIR, id);
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const ext of ['png', 'json', 'webp']) {
    const src = path.join(SPRITES_DIR, id, `${anim}.${ext}`);
    if (!fs.existsSync(src)) throw httpError(404, `No generated ${anim}.${ext} for ${id}`);
    fs.copyFileSync(src, path.join(outDir, `${anim}.${ext}`));
    files.push(`/exports/${id}/${anim}.${ext}`);
  }
  return { files, dir: path.relative(ROOT, outDir) };
}

// ---- http ------------------------------------------------------------------

function send(res, status, body) {
  const json = typeof body !== 'string';
  res.writeHead(status, { 'Content-Type': json ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) { reject(httpError(413, 'Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(httpError(400, 'Invalid JSON')); }
    });
  });
}

function serveFile(res, baseDir, relPath) {
  const file = path.resolve(baseDir, '.' + path.sep + decodeURIComponent(relPath));
  if (!file.startsWith(baseDir + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const jobMatch = url.pathname.match(/^\/api\/jobs\/(\d+)$/);

  if (route === 'GET /api/config') {
    return send(res, 200, {
      // DEFAULTS.model is null on the CLI (it resolves per provider), but the
      // UI needs a concrete model to preselect.
      defaults: { ...DEFAULTS, model: DEFAULTS.model || PROVIDER_INFO[DEFAULTS.provider].defaultVideoModel },
      style: SPRITE_STYLE,
      presets: PRESET_ANIMATIONS,
      models: Object.entries(VIDEO_MODELS).map(([id, m]) => {
        const duration = pickDuration(m, DEFAULTS.duration);
        return { id, duration, credits: m.credits(duration) };
      })
    });
  }
  if (route === 'GET /api/sprites') return send(res, 200, listSprites());
  if (route === 'POST /api/sprites') return send(res, 200, saveSprite(await readBody(req)));
  if (route === 'POST /api/estimate') return send(res, 200, await dryRun(cliArgs(await readBody(req))));
  if (route === 'POST /api/export') return send(res, 200, exportAnim(await readBody(req)));
  if (route === 'GET /api/jobs') return send(res, 200, [...jobs.values()].reverse().slice(0, 30).map(publicJob));
  if (route === 'POST /api/jobs') return send(res, 200, publicJob(enqueue(await readBody(req))));
  if (jobMatch && req.method === 'GET') {
    const job = jobs.get(jobMatch[1]);
    return job ? send(res, 200, publicJob(job)) : send(res, 404, { error: 'No such job' });
  }
  if (jobMatch && req.method === 'DELETE') {
    const job = jobs.get(jobMatch[1]);
    if (!job) return send(res, 404, { error: 'No such job' });
    cancel(job);
    return send(res, 200, publicJob(job));
  }
  send(res, 404, { error: 'Unknown endpoint' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
    if (url.pathname.startsWith('/sprites/')) return serveFile(res, SPRITES_DIR, url.pathname.slice('/sprites/'.length));
    if (url.pathname.startsWith('/exports/')) return serveFile(res, EXPORT_DIR, url.pathname.slice('/exports/'.length));
    if (url.pathname === '/game' || url.pathname === '/game/') return serveFile(res, path.join(ROOT, 'game'), 'index.html');
    // the game uses relative asset paths (it deploys under a sub-path on
    // aislop.cloud), so its asset routes hang off /game/ here too
    if (url.pathname.startsWith('/game/sprites/')) return serveFile(res, SPRITES_DIR, url.pathname.slice('/game/sprites/'.length));
    if (url.pathname.startsWith('/game/tiles/')) return serveFile(res, path.join(ROOT, 'assets', 'tiles'), url.pathname.slice('/game/tiles/'.length));
    if (url.pathname.startsWith('/game/props/')) return serveFile(res, path.join(ROOT, 'assets', 'props'), url.pathname.slice('/game/props/'.length));
    if (url.pathname === '/game/vendor/phaser.js') return serveFile(res, path.join(ROOT, 'node_modules', 'phaser', 'dist'), 'phaser.min.js');
    if (url.pathname.startsWith('/game/')) return serveFile(res, path.join(ROOT, 'game'), url.pathname.slice('/game/'.length));
    serveFile(res, WEB_DIR, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Sprite Studio → http://localhost:${PORT}`));
