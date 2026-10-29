// Provider abstraction for the three paid stages of the sprite pipeline:
// keyframe (text->image), background removal, and image->video.
//
// Why this exists: Apiframe is an *unofficial* Midjourney proxy. That is fine
// for generating art for our own game, but a paid product cannot depend on it
// — neither for uptime nor for the licence its customers resell under. This
// module keeps Apiframe as the default (nothing about existing runs changes)
// and adds `fal`, which serves officially licensed models.
//
//   node scripts/generate-sprites.js --provider=fal --only=skeleton
//
// A provider exposes:
//   keyframeModels / videoModels   what it can run, with per-job cost
//   submitKeyframe / submitBackgroundRemove / submitVideo   -> submit response
//   extractJobId / extractImages / extractVideo             -> read a response
//   waitForJob(jobId) / download(url, dest)
//   ref(localFile)   how a local file is handed to a model (upload, or inline)
//
// Cost is normalised to CREDITS so one number means the same thing across
// providers and can be billed: 1 credit = $0.01 of provider spend. Apiframe
// prices in credits already (~$0.01 each), so its numbers are unchanged.
//
// !! The fal USD figures below are list prices as of 2026-09-30 and are the
// one thing here that must be re-checked against https://fal.ai/pricing
// before anyone is charged for a sprite. Everything else is from the API docs.

const fs = require('fs');
const path = require('path');
const { Apiframe, withRetry, downloadTo } = require('./apiframe');

const USD_PER_CREDIT = 0.01;
const cr = usd => Math.ceil(usd / USD_PER_CREDIT);

// Shared across providers: what the video model must never draw. A clean flat
// key colour is the whole reason the matte works.
const NEGATIVE_PROMPT = 'camera movement, zoom, pan, camera shake, shadow, floor, ground, scenery, background change, gradient background, lighting change, extra characters, text, scene cut, morphing, motion blur, smoke, dust cloud, mist, fog, gas, particles';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4' };

function loadKey(root, varName) {
  if (process.env[varName]) return process.env[varName];
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) {
    const line = fs.readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .find(l => l.trim().startsWith(varName + '='));
    if (line) return line.split('=').slice(1).join('=').trim();
  }
  throw new Error(varName + ' not found in environment or .env file.');
}

// ---- apiframe ---------------------------------------------------------------

const APIFRAME_VIDEO = {
  'kling-2.5-turbo-pro': {
    paramsKey: 'klingParams', end: true, durations: [5, 10], credits: d => (d <= 5 ? 22 : 44),
    params: ({ start, end, duration }) => ({ start_image: start, ...(end && { end_image: end }), duration, aspect_ratio: '1:1', negative_prompt: NEGATIVE_PROMPT })
  },
  'kling-2.6': {
    paramsKey: 'klingParams', end: true, durations: [5, 10], credits: d => (d <= 5 ? 22 : 44),
    params: ({ start, end, duration }) => ({ start_image: start, ...(end && { end_image: end }), duration, aspect_ratio: '1:1', negative_prompt: NEGATIVE_PROMPT, generate_audio: false })
  },
  'seedance-1-pro-fast': {
    paramsKey: 'seedanceParams', end: true, durations: [5, 10], credits: d => Math.round(9 * d / 5),
    params: ({ start, end, duration, seed }) => ({ start_image: start, ...(end && { end_image: end }), duration, resolution: '480p', aspect_ratio: '1:1', camera_fixed: true, ...(seed != null && { seed }) })
  },
  'hailuo-02': {
    paramsKey: 'hailuoParams', end: true, durations: [6, 10], credits: d => (d <= 6 ? 34 : 57),
    params: ({ start, end, duration }) => ({ image: start, ...(end && { end_image: end }), duration, resolution: '768p' })
  }
};

const APIFRAME_KEYFRAME = {
  // Unofficial Midjourney proxy: great output, no licence to pass on.
  midjourney: { credits: 10, variants: 4, licence: 'unofficial proxy — NOT safe to resell outputs under' }
};

const APIFRAME_BG_REMOVE_CREDITS = 2;

function apiframeProvider(root) {
  const api = new Apiframe(loadKey(root, 'APIFRAME_API_KEY'));
  return {
    name: 'apiframe',
    keyframeModels: APIFRAME_KEYFRAME,
    defaultKeyframeModel: 'midjourney',
    backgroundRemoveCredits: APIFRAME_BG_REMOVE_CREDITS,
    videoModels: APIFRAME_VIDEO,
    defaultVideoModel: 'kling-2.5-turbo-pro',

    // Apiframe hosts the file and returns a CDN url. Uploads expire in 1-2h,
    // so this is called immediately before the submit that uses it.
    ref: file => api.upload(file),

    submitKeyframe: ({ prompt }) =>
      api.post('/images/generate', { prompt, model: 'midjourney', midjourneyParams: { aspect_ratio: '2:3' } }),

    submitBackgroundRemove: ({ image }) =>
      api.post('/images/background-remove', { model: 'bria-bg-remove', briaBgRemoveParams: { image } }),

    submitVideo: ({ model, prompt, start, end, duration, seed }) => {
      const spec = APIFRAME_VIDEO[model];
      if (!spec) throw new Error('Unknown apiframe video model ' + model);
      return api.post('/videos/generate', {
        prompt, model,
        [spec.paramsKey]: spec.params({ start, end, duration, seed })
      });
    },

    extractJobId: r => r.jobId || r.id || r.task_id || null,
    extractImages: r => {
      const src = r.result || r;
      if (Array.isArray(src.images)) return src.images;
      if (Array.isArray(src.image_urls)) return src.image_urls;
      if (src.image) return [src.image];
      if (src.output_url) return [src.output_url];
      if (src.url) return [src.url];
      return null;
    },
    extractVideo: r => {
      const src = r.result || r;
      return src.videoUrl || (Array.isArray(src.videos) && src.videos[0]) || src.video || null;
    },

    waitForJob: (jobId, opts) => api.waitForJob(jobId, opts),
    download: (url, dest) => api.download(url, dest)
  };
}

// ---- fal --------------------------------------------------------------------

const FAL_BASE = 'https://queue.fal.run';
const FAL_POLL_MS = 5000;

// FLUX.1 [schnell] is Apache-2.0 — both the model and its outputs are
// unrestricted, which is the only keyframe model here a customer can safely
// ship a commercial game with. FLUX.1 [dev] is deliberately absent: its
// licence forbids commercial *generation*, which is exactly what a paid
// product does on the customer's behalf.
const FAL_KEYFRAME = {
  'flux-schnell': {
    endpoint: 'fal-ai/flux/schnell', usd: 0.003, variants: 4,
    licence: 'Apache-2.0 — model and outputs unrestricted; safe to resell',
    params: ({ prompt, variants }) => ({
      prompt,
      image_size: { width: 832, height: 1248 },   // ~2:3, matching the MJ keyframe
      num_images: variants,
      num_inference_steps: 4,
      enable_safety_checker: true
    })
  }
};

const FAL_VIDEO = {
  'kling-2.5-turbo-pro': {
    endpoint: 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
    end: true, durations: [5, 10], usd: d => (d <= 5 ? 0.35 : 0.70),
    // fal takes the end-frame pin as `tail_image_url` and wants `duration` as
    // a STRING enum. The pin is what returns a cycle to the rest pose, so a
    // provider without it could not host this pipeline at all.
    params: ({ start, end, duration }) => ({
      image_url: start,
      ...(end && { tail_image_url: end }),
      duration: String(duration),
      negative_prompt: NEGATIVE_PROMPT,
      cfg_scale: 0.5
    })
  }
};

const FAL_BG_REMOVE = { endpoint: 'fal-ai/bria/background/remove', usd: 0.02 };

// Cost tables without credentials, so --dry-run and the UI can price a job.
function falModels() {
  return {
    keyframeModels: Object.fromEntries(Object.entries(FAL_KEYFRAME).map(([id, m]) =>
      [id, { credits: cr(m.usd * m.variants), variants: m.variants, licence: m.licence }])),
    backgroundRemoveCredits: cr(FAL_BG_REMOVE.usd),
    videoModels: Object.fromEntries(Object.entries(FAL_VIDEO).map(([id, m]) =>
      [id, { end: m.end, durations: m.durations, credits: d => cr(m.usd(d)), params: m.params }])),
    defaultKeyframeModel: 'flux-schnell',
    defaultVideoModel: 'kling-2.5-turbo-pro'
  };
}

function falProvider(root) {
  const key = loadKey(root, 'FAL_KEY');

  async function call(url, init = {}) {
    const res = await withRetry(url, () => fetch(url, {
      ...init,
      headers: { Authorization: 'Key ' + key, ...(init.headers || {}) }
    }));
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { error: text }; }
    if (!res.ok) {
      const detail = json.detail || json.error || json.message || ('HTTP ' + res.status);
      const err = new Error(url + ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)));
      // fal answers 402 for an exhausted balance, which the caller stops on.
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    return json;
  }

  // A fal request id is only meaningful next to its endpoint, but the pipeline
  // caches a single opaque job id string in state.json. Carry both.
  function submit(endpoint, body) {
    return call(FAL_BASE + '/' + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(r => ({ ...r, endpoint, jobId: endpoint + ':' + r.request_id }));
  }

  return {
    name: 'fal',
    ...falModels(),

    // fal decodes a Base64 data URI anywhere a file input is accepted, so
    // there is no upload step and no expiring url to race. The start frames
    // are ~1 MB PNGs; if they ever grow, switch to fal's storage API.
    ref: async file => {
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      return 'data:' + type + ';base64,' + fs.readFileSync(file).toString('base64');
    },

    submitKeyframe: ({ prompt, model = 'flux-schnell' }) => {
      const spec = FAL_KEYFRAME[model];
      if (!spec) throw new Error('Unknown fal keyframe model ' + model);
      return submit(spec.endpoint, spec.params({ prompt, variants: spec.variants }));
    },

    submitBackgroundRemove: ({ image }) =>
      submit(FAL_BG_REMOVE.endpoint, { image_url: image }),

    submitVideo: ({ model, prompt, start, end, duration, seed }) => {
      const spec = FAL_VIDEO[model];
      if (!spec) throw new Error('Unknown fal video model ' + model);
      return submit(spec.endpoint, { prompt, ...spec.params({ start, end, duration, seed }) });
    },

    extractJobId: r => r.jobId || null,
    extractImages: r => {
      const imgs = r.images || (r.image ? [r.image] : null);
      if (!imgs) return null;
      return imgs.map(i => (typeof i === 'string' ? i : i && i.url)).filter(Boolean);
    },
    extractVideo: r => {
      const v = r.video || (Array.isArray(r.videos) && r.videos[0]);
      if (!v) return null;
      return typeof v === 'string' ? v : v.url;
    },

    async waitForJob(jobId, { timeoutMs = 15 * 60 * 1000, onTick } = {}) {
      const sep = jobId.indexOf(':');
      if (sep < 0) throw new Error('Not a fal job id: ' + jobId + ' (was it submitted to Apiframe?)');
      const endpoint = jobId.slice(0, sep), id = jobId.slice(sep + 1);
      const base = FAL_BASE + '/' + endpoint + '/requests/' + id;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const s = await call(base + '/status');
        const status = String(s.status || '').toUpperCase();
        if (status === 'COMPLETED') return call(base);
        if (status === 'FAILED' || status === 'ERROR' || status === 'CANCELLED') {
          const err = new Error('Job ' + id + ' failed: ' + (s.error || JSON.stringify(s)));
          err.jobFailed = true;
          throw err;
        }
        // fal reports a queue position, not a percentage.
        if (onTick) onTick({ progress: null, queue: s.queue_position });
        await new Promise(r => setTimeout(r, FAL_POLL_MS));
      }
      throw new Error('Timed out waiting for job ' + id);
    },

    download: (url, dest) => downloadTo(url, dest)
  };
}

// ---- registry ---------------------------------------------------------------

const PROVIDERS = { apiframe: apiframeProvider, fal: falProvider };

// Built lazily: listing models or planning a dry run must not demand an API key.
function createProvider(name, root) {
  const make = PROVIDERS[name];
  if (!make) throw new Error('Unknown --provider=' + name + '. Known: ' + Object.keys(PROVIDERS).join(', '));
  return make(root);
}

// The model tables without the credentials, for --dry-run, --help and the UI.
const PROVIDER_INFO = {
  apiframe: {
    keyframeModels: APIFRAME_KEYFRAME,
    backgroundRemoveCredits: APIFRAME_BG_REMOVE_CREDITS,
    videoModels: APIFRAME_VIDEO,
    defaultKeyframeModel: 'midjourney',
    defaultVideoModel: 'kling-2.5-turbo-pro'
  },
  fal: falModels()
};

module.exports = {
  createProvider, PROVIDER_INFO, NEGATIVE_PROMPT, USD_PER_CREDIT,
  PROVIDER_NAMES: Object.keys(PROVIDERS)
};
