// Thin Apiframe v2 client: key loading, JSON posts, file uploads, job polling
// and downloads. Same submit → poll → download flow as slaythefile's
// scripts/generate-art.js.

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.apiframe.ai/v2';
const POLL_INTERVAL_MS = 5000;

function loadApiKey(root) {
  if (process.env.APIFRAME_API_KEY) return process.env.APIFRAME_API_KEY;
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) {
    const line = fs.readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .find(l => l.trim().startsWith('APIFRAME_API_KEY='));
    if (line) return line.split('=').slice(1).join('=').trim();
  }
  throw new Error('APIFRAME_API_KEY not found in environment or .env file.');
}

function extractJobId(r) { return r.jobId || r.id || r.task_id || null; }

function extractImages(r) {
  const src = r.result || r;
  if (Array.isArray(src.images)) return src.images;
  if (Array.isArray(src.image_urls)) return src.image_urls;
  if (src.image) return [src.image];
  if (src.output_url) return [src.output_url];
  if (src.url) return [src.url];
  return null;
}

function extractVideo(r) {
  const src = r.result || r;
  return src.videoUrl || (Array.isArray(src.videos) && src.videos[0]) || src.video || null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4' };

// Transient network failures (fetch failed, ECONNRESET, 502/503) get retried
// with backoff — paid jobs are already idempotent via the state cache, and a
// one-off blip shouldn't fail a whole animation.
async function withRetry(label, fn, attempts = 4) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const transient = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|network/i.test(e.message) ||
        e.status === 502 || e.status === 503 || e.status === 504;
      if (!transient || i >= attempts) throw e;
      const wait = 2000 * i * i;
      console.warn(`  [retry ${i}/${attempts - 1}] ${label}: ${e.message} — waiting ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

// Provider-agnostic download, shared with lib/providers.js: the result urls
// of every provider are plain HTTPS and need the same retry treatment.
async function downloadTo(url, destPath) {
  const buf = await withRetry(`download ${path.basename(destPath)}`, async () => {
    const res = await fetch(url);
    if (!res.ok) {
      const err = new Error(`Failed to download ${url}: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return Buffer.from(await res.arrayBuffer());
  });
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
}

class Apiframe {
  constructor(apiKey) { this.apiKey = apiKey; }

  async request(pathname, init = {}) {
    const res = await withRetry(pathname, () => fetch(`${API_BASE}${pathname}`, {
      ...init,
      headers: { 'X-API-Key': this.apiKey, ...(init.headers || {}) }
    }));
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { error: text }; }
    if (!res.ok) {
      const detail = json.error || json.message || `HTTP ${res.status}`;
      const err = new Error(`${pathname}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    return json;
  }

  post(pathname, body) {
    return this.request(pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  // Hosts a local file on Apiframe's CDN so it can be used as a model input.
  // Uploads expire after 1–2 hours, so only upload right before submitting.
  async upload(filePath) {
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(filePath)], { type }), path.basename(filePath));
    const json = await this.request('/uploads', { method: 'POST', body: form });
    if (!json.url) throw new Error('Upload returned no url: ' + JSON.stringify(json));
    return json.url;
  }

  getJob(id) { return this.request(`/jobs/${id}`); }

  async waitForJob(jobId, { timeoutMs = 15 * 60 * 1000, onTick } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await this.getJob(jobId);
      const status = String(job.status || '').toUpperCase();
      if (status === 'COMPLETED' || status === 'DONE' || status === 'SUCCESS') return job.result || job;
      if (status === 'FAILED' || status === 'ERROR') {
        const err = new Error(`Job ${jobId} failed: ${job.error || JSON.stringify(job)}`);
        err.jobFailed = true;
        throw err;
      }
      if (onTick) onTick(job);
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out waiting for job ${jobId}`);
  }

  download(url, destPath) { return downloadTo(url, destPath); }
}

module.exports = { Apiframe, loadApiKey, extractJobId, extractImages, extractVideo, withRetry, downloadTo };
