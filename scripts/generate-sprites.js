#!/usr/bin/env node
// Generates transparent sprite-sheet animations via Apiframe and saves them
// into assets/sprites/<character>/.
//
// No video model outputs alpha, so the clip is generated on a flat key colour
// and matted afterwards. Per character:
//   1. keyframe  Midjourney still (or --image) → Bria background removal →
//                RGBA cutout shared by every animation of that character
//   2. start     cutout composited onto a flat key colour (green, magenta or
//                blue — whichever the character's palette uses least)
//   3. video     image-to-video; cycles also get the start image as their
//                LAST frame so the clip returns to the rest pose
//   4. frames    ffmpeg decodes the clip; cycle length is detected by
//                matching frames back against frame 0
//   5. matte     each sampled frame → RGBA via colour-difference key, edge
//                un-mixing and despill (or --matte=bria, 2 credits/frame)
//   6. sheet     frames cropped to one shared box, scaled so the character is
//                the same size in every animation, packed into
//                <anim>.png + <anim>.json (TexturePacker JSON Hash, pivot at
//                the feet) + <anim>.webp animated preview
//
// Paid results are recorded in assets/sprites/<id>/_work/state.json the moment
// a job is submitted, so reruns (and interrupted runs) never pay twice; the
// free local stages 4–6 re-run every time, so matte/sheet tweaks are free.
//
// Usage:
//   node scripts/generate-sprites.js                          # everything missing
//   node scripts/generate-sprites.js --only=skeleton --anim=idle,attack
//   node scripts/generate-sprites.js --id=hero --image=art.png --anim=idle
//   node scripts/generate-sprites.js --only=skeleton --anim=idle --video=clip.mp4
//   node scripts/generate-sprites.js --model=seedance-1-pro-fast --matte=bria
//   node scripts/generate-sprites.js --regen=video            # resubmit video jobs
//   node scripts/generate-sprites.js --dry-run                # plan + credit estimate
//
// Options:
//   --only=a,b         character ids from scripts/sprite-prompts.js
//   --anim=a,b         animation names
//   --id=NAME          one character; with --image, may be ad-hoc (default anims)
//   --image=FILE       keyframe source instead of Midjourney (cutouts skip Bria)
//   --video=FILE       use a local clip (on a key colour) for the one selected anim
//   --provider=NAME    apiframe (default) or fal; see lib/providers.js
//   --model=ID         video model (default: the provider's own default)
//   --matte=chroma|bria
//   --key=auto|green|magenta|blue   key colour for newly generated clips
//   --despeckle=PX     drop alpha islands smaller than this (default 0.01% of the frame; 0 = off)
//   --frames=N         frame budget per sheet (overrides the animation's setting)
//   --fps=N            playback rate; slow clips are time-compressed to fit the budget
//   --height=PX        character height in the output cells (default 256)
//   --cols=N           sheet columns (default: roughly square)
//   --variant=N        which Midjourney image (1–4) to use as the keyframe
//   --duration=S       clip length in seconds (snapped to what the model offers)
//   --seed=N           seed, for models that take one
//   --regen=keyframe,video   pay to regenerate those stages

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createProvider, PROVIDER_INFO, PROVIDER_NAMES } = require('./lib/providers');
const { loadRgba, savePng, alphaBBox, hasTransparency, saveTrimmed, translateRgba, thumb } = require('./lib/image');
const { KEYS, chooseKey, sampleBackground, detectKey, chromaAlpha, despeckle, alphaFromImage, applyMatte } = require('./lib/matte');
const { loadFrames, selectFrames } = require('./lib/video');
const { buildSheet } = require('./lib/sheet');
const { SPRITES, DEFAULT_ANIMATIONS } = require('./sprite-prompts');

const ROOT = path.join(__dirname, '..');
// A hosted caller runs one workspace per customer and points the pipeline at
// it; locally it is this repo's own asset folder.
const SPRITES_DIR = process.env.SPRITE_WORKSPACE ? path.resolve(process.env.SPRITE_WORKSPACE) : path.join(ROOT, 'assets', 'sprites');
const START_SIZE = 1024;   // square start image, matching 1:1 video
const FOOT_Y = 0.88;       // where the character's feet sit in the start image
const DEFAULTS = { provider: 'apiframe', model: null, matte: 'chroma', key: 'auto', height: 256, duration: 5 };

// Which models exist, what they cost and how they are called now lives per
// provider in lib/providers.js. VIDEO_MODELS stays exported as the default
// provider's table so server.js keeps working unchanged.
const VIDEO_MODELS = PROVIDER_INFO.apiframe.videoModels;

// The provider chosen for this run; set in main().
let provider;

function info(args) { return PROVIDER_INFO[args.provider]; }

// Paid-job slots in state.json are per provider: a cached Midjourney keyframe
// must never be handed back to a run that asked for flux, or the sprite would
// carry a licence its buyer never agreed to — the whole reason --provider
// exists. Apiframe keeps the bare legacy slot names ('midjourney', 'bria') so
// jobs already paid for stay cached.
function keyframeSlot(args) {
  return args.provider === 'apiframe' ? 'midjourney' : `${args.provider}:${info(args).defaultKeyframeModel}`;
}

function bgRemoveSlot(args) {
  return args.provider === 'apiframe' ? 'bria' : `${args.provider}:bg`;
}
function videoModel(args) { return info(args).videoModels[args.model]; }


function parseArgs(argv) {
  const args = { ...DEFAULTS, only: null, anim: null, regen: new Set(), dryRun: false };
  for (const a of argv) {
    const [flag, ...rest] = a.replace(/^--/, '').split('=');
    const value = rest.join('=');
    switch (flag) {
      case 'dry-run': args.dryRun = true; break;
      case 'only': case 'anim': args[flag] = value.split(',').map(s => s.trim()).filter(Boolean); break;
      case 'regen': value.split(',').map(s => s.trim()).filter(Boolean).forEach(s => args.regen.add(s)); break;
      case 'frames': case 'fps': case 'despeckle': case 'height': case 'cols': case 'duration': case 'variant': case 'seed': args[flag] = Number(value); break;
      case 'id': case 'image': case 'video': case 'model': case 'matte': case 'key': case 'provider': args[flag] = value; break;
      default: throw new Error(`Unknown option: ${a}`);
    }
  }
  if (!PROVIDER_INFO[args.provider]) throw new Error(`Unknown --provider=${args.provider}. Known: ${PROVIDER_NAMES.join(', ')}`);
  // Each provider has its own model table, so --model is resolved against it.
  const models = info(args).videoModels;
  args.model = args.model || info(args).defaultVideoModel;
  if (!models[args.model]) throw new Error(`Unknown --model=${args.model} for --provider=${args.provider}. Known: ${Object.keys(models).join(', ')}`);
  if (!['chroma', 'bria'].includes(args.matte)) throw new Error('--matte must be chroma or bria');
  if (args.key !== 'auto' && !KEYS[args.key]) throw new Error(`--key must be auto or one of ${Object.keys(KEYS).join(', ')}`);
  for (const s of args.regen) if (!['keyframe', 'video'].includes(s)) throw new Error(`--regen accepts keyframe,video (got ${s})`);
  if (args.image && !args.id) throw new Error('--image needs --id=<character name>');
  return args;
}

// Characters created in the web UI live beside their output as
// assets/sprites/<id>/sprite.json and override built-ins with the same id.
function allSprites() {
  // DIABLOW's own cast is built in. A tenant workspace should see only its own
  // characters, so SPRITE_BUILTINS=0 drops them.
  const byId = new Map(process.env.SPRITE_BUILTINS === '0' ? [] : SPRITES.map(s => [s.id, { ...s, builtIn: true }]));
  if (fs.existsSync(SPRITES_DIR)) {
    for (const id of fs.readdirSync(SPRITES_DIR)) {
      const defPath = path.join(SPRITES_DIR, id, 'sprite.json');
      if (!fs.existsSync(defPath)) continue;
      const def = JSON.parse(fs.readFileSync(defPath, 'utf8'));
      if (def.image) def.image = path.resolve(path.dirname(defPath), def.image);
      byId.set(id, { ...def, id, builtIn: false });
    }
  }
  return [...byId.values()];
}

function resolveCharacters(args) {
  const sprites = allSprites();
  let list;
  if (args.id) {
    const known = sprites.find(s => s.id === args.id);
    if (!known && !args.image) throw new Error(`--id=${args.id} has no definition; add --image to use a local picture.`);
    list = [{ ...(known || { id: args.id, name: args.id, animations: DEFAULT_ANIMATIONS }), image: args.image || (known && known.image) }];
  } else if (args.only) {
    const missing = args.only.filter(id => !sprites.some(s => s.id === id));
    if (missing.length) throw new Error(`Unknown character id(s): ${missing.join(', ')}`);
    list = sprites.filter(s => args.only.includes(s.id));
  } else {
    list = sprites;
  }
  return list.map(ch => {
    const animations = args.anim ? ch.animations.filter(a => args.anim.includes(a.name)) : ch.animations;
    return { ...ch, animations };
  }).filter(ch => ch.animations.length);
}

function rel(p) { return path.relative(ROOT, p); }

function pickDuration(model, wanted) {
  return model.durations.reduce((best, d) => (Math.abs(d - wanted) < Math.abs(best - wanted) ? d : best));
}

function openContext(ch, args) {
  const outDir = path.join(SPRITES_DIR, ch.id);
  const work = path.join(outDir, '_work');
  const statePath = path.join(work, 'state.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
  state.keyframe = state.keyframe || {};
  state.anims = state.anims || {};
  return {
    ch, args, outDir, work, state,
    save() {
      fs.mkdirSync(work, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    }
  };
}

// Submits a paid job once and remembers it: the jobId is saved before
// polling, so an interrupted run resumes the same job instead of paying for
// a new one. Failed jobs are forgotten so the next run resubmits.
async function runJob(ctx, holder, slot, label, submit) {
  if (holder[slot] && holder[slot].result) return holder[slot].result;
  if (holder[slot] && holder[slot].jobId) {
    console.log(`  ${label}: resuming job ${holder[slot].jobId}`);
  } else {
    const res = await submit();
    const jobId = provider.extractJobId(res);
    if (!jobId) throw new Error(`${label}: no job id in response ${JSON.stringify(res)}`);
    holder[slot] = { ...(holder[slot] || {}), jobId };
    ctx.save();
    console.log(`  ${label}: job ${jobId}`);
  }
  process.stdout.write('  waiting');
  let lastProgress = null;
  try {
    const result = await provider.waitForJob(holder[slot].jobId, {
      onTick: job => {
        if (job.progress != null && job.progress !== lastProgress) { lastProgress = job.progress; process.stdout.write(` ${job.progress}%`); }
        else process.stdout.write('.');
      }
    });
    console.log(' done');
    holder[slot].result = result;
    ctx.save();
    return result;
  } catch (e) {
    console.log('');
    if (e.jobFailed) { delete holder[slot]; ctx.save(); }
    throw e;
  }
}

// Every clip starts from the keyframe, so a new keyframe invalidates them all.
function invalidateVideos(ctx) {
  for (const name of Object.keys(ctx.state.anims)) {
    delete ctx.state.anims[name].video;
    fs.rmSync(path.join(ctx.work, name, 'video.mp4'), { force: true });
    fs.rmSync(path.join(ctx.work, name, 'raw'), { recursive: true, force: true });
  }
}

// Where the keyframe comes from: the character's image, or a generated
// variant — --variant if given, else the one the cached cutout used, so a
// plain rerun never silently switches variants (and re-pays for videos).
// The id carries the provider and model, because the same variant number from
// a different model is a different picture.
function keyframeSource(ctx) {
  if (ctx.ch.image) return path.resolve(ctx.ch.image);
  const cached = parseKeyframeSource(ctx.state.keyframe.source);
  const model = info(ctx.args).defaultKeyframeModel;
  return `${ctx.args.provider}:${model}#${ctx.args.variant || (cached ? cached.variant : 1)}`;
}

// Keyframe ids were once just `midjourney#N`, when Apiframe was the only
// provider. Canonicalising the legacy form is what keeps this change free:
// without it every cached character would read as a changed source, which
// invalidates its cutout AND every clip built on it — re-paying for all of them.
function canonicalSource(s) {
  return /^midjourney#\d+$/.test(s || '') ? `apiframe:${s}` : s;
}

function parseKeyframeSource(s) {
  const m = /^(?:([a-z0-9-]+):([a-z0-9._-]+)|())#(\d+)$/i.exec(canonicalSource(s) || '');
  return m ? { provider: m[1] || 'apiframe', model: m[2] || 'midjourney', variant: Number(m[4]) } : null;
}

async function ensureKeyframe(ctx) {
  const { ch, args, work, state } = ctx;
  const cutoutPath = path.join(work, 'keyframe.png');
  const source = keyframeSource(ctx);
  const variant = ch.image ? null : parseKeyframeSource(source).variant;
  if (args.regen.has('keyframe')) {
    ctx.state.keyframe = {};
    fs.rmSync(cutoutPath, { force: true });
    invalidateVideos(ctx);
    ctx.save();
  } else if (fs.existsSync(cutoutPath) && canonicalSource(state.keyframe.source) !== source) {
    // Different --image / --variant than the cached cutout: redo the cutout
    // (and the clips built on it). A cached Midjourney job is kept.
    delete state.keyframe[bgRemoveSlot(args)];
    fs.rmSync(cutoutPath, { force: true });
    invalidateVideos(ctx);
    ctx.save();
  }
  if (fs.existsSync(cutoutPath)) return cutoutPath;
  fs.mkdirSync(work, { recursive: true });

  let sourceUrl;
  if (ch.image) {
    if (!fs.existsSync(source)) throw new Error(`--image not found: ${source}`);
    if (await hasTransparency(source)) {
      console.log(`  keyframe: using cutout ${source}`);
      await saveTrimmed(cleanCutout(await loadRgba(source)), cutoutPath);
      state.keyframe.source = source;
      ctx.save();
      return cutoutPath;
    }
    console.log('  keyframe: uploading source image for background removal');
    sourceUrl = await provider.ref(source);
  } else {
    const ctxState = ctx.state.keyframe;
    const kfModel = info(args).defaultKeyframeModel;
    const mj = await runJob(ctx, ctxState, keyframeSlot(args), `keyframe (${kfModel})`, () =>
      provider.submitKeyframe({ prompt: ch.prompt, model: kfModel }));
    const images = provider.extractImages(mj);
    if (!images) throw new Error(`${kfModel} job returned no images: ` + JSON.stringify(mj));
    for (let i = 0; i < images.length; i++) {
      const f = path.join(work, 'variants', `${i + 1}.png`);
      if (!fs.existsSync(f)) await provider.download(images[i], f);
    }
    sourceUrl = images[variant - 1];
    if (!sourceUrl) throw new Error(`--variant=${variant} but the model returned ${images.length} image(s)`);
    console.log(`  keyframe: using variant ${variant} of ${images.length} (all in ${rel(path.join(work, 'variants'))})`);
  }

  const bria = await runJob(ctx, state.keyframe, bgRemoveSlot(args), 'keyframe background removal', () =>
    provider.submitBackgroundRemove({ image: sourceUrl }));
  const briaPath = path.join(work, 'keyframe-bria.png');
  await provider.download(provider.extractImages(bria)[0], briaPath);
  await saveTrimmed(cleanCutout(await loadRgba(briaPath)), cutoutPath);
  state.keyframe.source = source;
  ctx.save();
  return cutoutPath;
}

// Drops detached bits the background removal kept (a pebble, a shadow blob):
// anything under 0.5% of the character's area. Left in the keyframe, the
// video model animates them into every frame of every animation.
function cleanCutout(img) {
  const alpha = alphaFromImage(img);
  let area = 0;
  for (const a of alpha) if (a >= 0.03) area++;
  const cleared = despeckle(alpha, img.width, img.height, Math.round(area * 0.005));
  if (cleared) {
    for (let p = 0; p < alpha.length; p++) if (alpha[p] === 0) img.data[p * 4 + 3] = 0;
    console.log(`  keyframe: removed ${cleared} px of detached bits`);
  }
  return img;
}

// Cutout centred on a flat key-colour square with the feet at FOOT_Y.
async function composeStart(cutout, keyName, scale) {
  const aspect = cutout.width / cutout.height;
  let h = Math.round(START_SIZE * scale), w = Math.round(h * aspect);
  if (w > START_SIZE * 0.9) { w = Math.round(START_SIZE * 0.9); h = Math.round(w / aspect); }
  const subject = await sharp(cutout.data, { raw: { width: cutout.width, height: cutout.height, channels: 4 } })
    .resize(w, h, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
  const [r, g, b] = KEYS[keyName].rgb;
  return sharp({ create: { width: START_SIZE, height: START_SIZE, channels: 3, background: { r, g, b } } })
    .composite([{ input: subject, left: Math.round((START_SIZE - w) / 2), top: Math.round(START_SIZE * FOOT_Y - h) }])
    .png().toBuffer();
}

function videoPrompt(anim, keyName) {
  const key = KEYS[keyName];
  return `${anim.motion} Smooth 2D game sprite animation; the character's design, colors and art style stay exactly the same. ` +
    'The camera is completely static and locked off: no camera movement, no zoom, no pan. The character stays centered on the same spot and never leaves the frame. ' +
    `The background stays a perfectly flat, uniform, solid pure ${keyName} (${key.hex}) for the whole clip: no floor, no ground shadow, no lighting change, no scenery, no particles.`;
}

async function generateVideo(ctx, anim, cutout, dir, videoPath) {
  const { args, state } = ctx;
  const as = state.anims[anim.name];
  const model = videoModel(args);
  const result = await runJob(ctx, as, 'video', `video (${args.model})`, async () => {
    const choice = args.key === 'auto' ? chooseKey(cutout) : { key: args.key, conflict: null };
    if (choice.conflict > 0.05) console.warn(`  warning: ${Math.round(choice.conflict * 100)}% of the character is close to ${choice.key}; expect some keying loss`);
    const startPath = path.join(dir, 'start.png');
    fs.writeFileSync(startPath, await composeStart(cutout, choice.key, anim.scale || 0.6));
    const url = await provider.ref(startPath);
    const duration = pickDuration(model, args.duration);
    const prompt = videoPrompt(anim, choice.key);
    // pin:false skips the end-frame pin — pinning start==end makes models
    // minimise excursion, which flattens big motions like attack swings.
    // center anims never pin: they need real travel, which a pinned end
    // frame forbids (the model must finish exactly where it started).
    const end = anim.cycle && model.end && anim.pin !== false && !anim.center ? url : null;
    as.request = { provider: provider.name, model: args.model, key: choice.key, duration, prompt };
    console.log(`  start image: ${choice.key} key → ${rel(startPath)}`);
    return provider.submitVideo({ model: args.model, prompt, start: url, end, duration, seed: args.seed });
  });
  const url = provider.extractVideo(result);
  if (!url) throw new Error('Video job returned no video: ' + JSON.stringify(result));
  await provider.download(url, videoPath);
}

async function briaAlpha(ctx, as, file, slot, width, height) {
  const cache = path.join(path.dirname(file), 'bria', path.basename(file));
  if (!fs.existsSync(cache)) {
    const holder = bgRemoveSlot(ctx.args);
    as[holder] = as[holder] || {};
    const result = await runJob(ctx, as[holder], slot, `bg-remove ${slot}`, async () =>
      provider.submitBackgroundRemove({ image: await provider.ref(file) }));
    await provider.download(provider.extractImages(result)[0], cache);
  }
  return alphaFromImage(await loadRgba(await sharp(cache).resize(width, height, { fit: 'fill' }).png().toBuffer()));
}

async function processAnimation(ctx, anim, cutout) {
  const { ch, args, work, outDir, state } = ctx;
  const dir = path.join(work, anim.name);
  fs.mkdirSync(dir, { recursive: true });
  const as = state.anims[anim.name] = state.anims[anim.name] || {};
  console.log(`[anim] ${ch.id}/${anim.name}`);

  let videoPath = path.join(dir, 'video.mp4');
  let rawDir = path.join(dir, 'raw');
  if (args.video) {
    videoPath = path.resolve(args.video);
    rawDir = path.join(dir, 'raw-local');
  } else {
    if (args.regen.has('video')) {
      delete as.video;
      fs.rmSync(videoPath, { force: true });
      fs.rmSync(rawDir, { recursive: true, force: true });
      ctx.save();
    }
    if (!fs.existsSync(videoPath)) await generateVideo(ctx, anim, cutout, dir, videoPath);
  }

  const { fps, files } = await loadFrames(videoPath, rawDir, { force: !!args.video });
  const first = await loadRgba(files[0]);
  const bg = sampleBackground(first);
  const key = detectKey(bg);
  const minIsland = args.despeckle != null ? args.despeckle : Math.round(first.width * first.height * 0.0001);

  // center mode: the clip shows real travel (models animate a natural
  // forward walk far better than a treadmill one). Track the feet across
  // the whole clip so (a) thumbnails can be stabilized BEFORE period
  // detection — autocorrelation can't see a stride while it translates —
  // and (b) sampled frames can be pinned to frame 0's feet.
  let offsets = null;
  let gait = null;
  let thumbs;
  if (anim.center) {
    const traj = [];
    for (const f of files) {
      const img = f === files[0] ? first : await loadRgba(f);
      const alpha = chromaAlpha(img, key, bg);
      despeckle(alpha, img.width, img.height, minIsland);
      let x0 = img.width, x1 = -1, y0 = img.height, yBottom = -1;
      for (let p = 0; p < alpha.length; p++) {
        if (alpha[p] < 0.5) continue;
        const x = p % img.width, y = (p - x) / img.width;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        yBottom = y;
      }
      traj.push(x1 < 0 ? null : { x: (x0 + x1) / 2, y: yBottom, w: x1 - x0, h: yBottom - y0 });
    }
    for (let i = 0; i < traj.length; i++) if (!traj[i]) traj[i] = traj[i - 1] || traj.find(Boolean);
    // detrended, amplitude-normalized body-shape series → gait signal
    const detrend = a => a.map((v, i) => {
      const w = a.slice(Math.max(0, i - 6), i + 7);
      return v - w.reduce((s, x) => s + x, 0) / w.length;
    });
    gait = [detrend(traj.map(t => t.w)), detrend(traj.map(t => t.h))].map(series => {
      const mad = series.reduce((s, v) => s + Math.abs(v), 0) / series.length || 1;
      return series.map(v => v / mad);
    });
    const smooth = traj.map((_, i) => {
      const win = traj.slice(Math.max(0, i - 2), i + 3);
      return { x: win.reduce((s, t) => s + t.x, 0) / win.length, y: win.reduce((s, t) => s + t.y, 0) / win.length };
    });
    offsets = smooth.map(t => ({ dx: Math.round(smooth[0].x - t.x), dy: Math.round(smooth[0].y - t.y) }));
    const travel = Math.max(...offsets.map(o => Math.hypot(o.dx, o.dy)));
    console.log(`  center: tracked ${Math.round(travel)} px of travel`);
    // stabilized thumbs: a fixed-size window riding on the feet
    const win = { w: Math.round(first.width * 0.55), h: Math.round(first.height * 0.6) };
    thumbs = await Promise.all(files.map((f, i) => {
      const left = Math.max(0, Math.min(first.width - win.w, Math.round(smooth[i].x - win.w / 2)));
      const top = Math.max(0, Math.min(first.height - win.h, Math.round(smooth[i].y - win.h * 0.92)));
      return sharp(f).extract({ left, top, width: win.w, height: win.h }).resize(64, 64, { fit: 'fill' }).greyscale().raw().toBuffer();
    }));
  } else {
    thumbs = await Promise.all(files.map(thumb));
  }

  const sel = selectFrames(thumbs, fps, anim, args.frames || anim.frames, args.fps || anim.fps || 12, gait);
  const seam = sel.loopDiff != null ? ` (loop seam Δ${sel.loopDiff.toFixed(1)})` : '';
  const speed = sel.speed > 1.05 ? ` (${sel.speed}× faster than the clip)` : '';
  console.log(`  frames: ${files.length} @ ${fps}fps, ${sel.mode} ${sel.start}–${sel.end} of ${files.length} = ${sel.seconds}s${seam}, sampling ${sel.indices.length} @ ${sel.fps}fps${speed}`);
  console.log(`  matte: ${args.matte}, background rgb(${bg.join(',')}) → ${key} key`);

  const matteDir = path.join(dir, 'matte');
  fs.rmSync(matteDir, { recursive: true, force: true });
  fs.mkdirSync(matteDir, { recursive: true });
  let specks = 0;
  const matted = [];
  for (const [i, idx] of sel.indices.entries()) {
    const img = idx === 0 ? first : await loadRgba(files[idx]);
    const alpha = args.matte === 'bria'
      ? await briaAlpha(ctx, as, files[idx], `${path.basename(rawDir)}/${idx}`, img.width, img.height)
      : chromaAlpha(img, key, bg);
    specks += despeckle(alpha, img.width, img.height, minIsland);
    let out = applyMatte(img, alpha, key, bg);
    // per-character grading (e.g. lift a too-dark palette for in-game reads)
    if (ch.adjust) {
      out.data = await sharp(out.data, { raw: { width: out.width, height: out.height, channels: 4 } })
        .modulate({ brightness: ch.adjust.brightness || 1, saturation: ch.adjust.saturation || 1 })
        .raw().toBuffer();
    }
    if (offsets && (offsets[idx].dx || offsets[idx].dy)) out = translateRgba(out, offsets[idx].dx, offsets[idx].dy);
    await savePng(out, path.join(matteDir, `${String(i).padStart(3, '0')}.png`));
    matted.push(out);
  }

  if (specks) console.log(`  despeckle: cleared ${specks} px in islands < ${minIsland} px`);


  // The clip's frame 0 is the shared keyframe rest pose in EVERY animation,
  // so its body height defines the character's height — measure it even when
  // sampling starts mid-clip, and scale it to --height so the character is
  // exactly the same size in every sheet (cells vary, the character doesn't).
  let ref = matted[sel.indices.indexOf(0)] || null;
  if (!ref) {
    const alpha0 = chromaAlpha(first, key, bg);
    despeckle(alpha0, first.width, first.height, minIsland);
    ref = applyMatte(first, alpha0, key, bg);
  }
  const body = alphaBBox(ref);
  if (!body) throw new Error('frame 0 matted to nothing — check the key colour');

  // center mode, part 2: cancel perspective scale drift — every sampled
  // frame's body height is normalized to the keyframe pose's (frame 0), so
  // a character that grew while approaching stays one size, and cross-
  // animation sizing (charHeight) stays exact.
  if (anim.center) {
    const ax = body.x + body.w / 2, ay = body.y + body.h;
    let maxDrift = 0;
    for (let i = 0; i < matted.length; i++) {
      const b = alphaBBox(matted[i]);
      if (!b) continue;
      const s = body.h / b.h;
      maxDrift = Math.max(maxDrift, Math.abs(1 - s));
      if (Math.abs(1 - s) < 0.03) continue;
      const m = matted[i];
      const scaled = await sharp(m.data, { raw: { width: m.width, height: m.height, channels: 4 } })
        .resize(Math.max(1, Math.round(m.width * s)), Math.max(1, Math.round(m.height * s)), { kernel: 'lanczos3' })
        .png().toBuffer();
      const canvas = sharp({ create: { width: m.width, height: m.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: scaled, left: Math.round(ax - ax * s), top: Math.round(ay - ay * s) }]);
      const raw = await canvas.raw().toBuffer();
      matted[i] = { data: raw, width: m.width, height: m.height };
      await savePng(matted[i], path.join(matteDir, `${String(i).padStart(3, '0')}.png`));
    }
    if (maxDrift > 0.03) console.log(`  center: normalized up to ${Math.round(maxDrift * 100)}% scale drift`);
  }
  const sheet = await buildSheet({
    frames: matted,
    anchor: { x: body.x + body.w / 2, y: body.y + body.h },
    scale: args.height / body.h,
    name: `${ch.id}/${anim.name}`,
    cols: args.cols,
    fps: sel.fps,
    loop: !!anim.cycle,
    pngPath: path.join(outDir, `${anim.name}.png`),
    jsonPath: path.join(outDir, `${anim.name}.json`),
    webpPath: path.join(outDir, `${anim.name}.webp`),
    previewPath: path.join(dir, 'sheet-preview.png'),
    cellsDir: path.join(dir, 'cells'),
    meta: { character: ch.id, animation: anim.name, charHeight: args.height, key, matte: args.matte, source: { video: rel(videoPath), fps, frames: sel.indices, seconds: sel.seconds, speed: sel.speed, mode: sel.mode }, request: as.request }
  });
  console.log(`[saved] ${rel(path.join(outDir, anim.name + '.png'))} — ${sel.indices.length} frames, ${sheet.cellW}×${sheet.cellH} cells, ${sheet.cols}×${sheet.rows} grid, pivot (${sheet.pivot.x}, ${sheet.pivot.y})`);
}

async function planCharacter(ctx) {
  const { ch, args, work } = ctx;
  let credits = 0;
  const regenKeyframe = args.regen.has('keyframe');
  const cutoutCached = fs.existsSync(path.join(work, 'keyframe.png')) && !regenKeyframe && canonicalSource(ctx.state.keyframe.source) === keyframeSource(ctx);
  let keyframeCost = 0;
  const kfModel = info(args).defaultKeyframeModel;
  const bgCost = info(args).backgroundRemoveCredits;
  if (!cutoutCached) {
    if (!ch.image) keyframeCost = (ctx.state.keyframe[keyframeSlot(args)] && !regenKeyframe ? 0 : info(args).keyframeModels[kfModel].credits) + bgCost;
    else if (!(fs.existsSync(ch.image) && await hasTransparency(path.resolve(ch.image)))) keyframeCost = bgCost;
  }
  credits += keyframeCost;
  console.log(`[plan] ${ch.id}: keyframe ${cutoutCached ? 'cached' : ch.image ? `from ${ch.image}` : `${kfModel} + bg-remove`} (${keyframeCost} cr)`);
  const model = videoModel(args);
  for (const anim of ch.animations) {
    const cached = args.video || (!cutoutCached ? false : fs.existsSync(path.join(work, anim.name, 'video.mp4')) && !args.regen.has('video'));
    const videoCost = cached ? 0 : model.credits(pickDuration(model, args.duration));
    const matteCost = args.matte === 'bria' ? bgCost * (args.frames || anim.frames) : 0;
    credits += videoCost + matteCost;
    console.log(`  ${anim.name}: video ${args.video ? 'local' : cached ? 'cached' : args.model} (${videoCost} cr), matte ${args.matte} (${matteCost ? '≤' + matteCost : 0} cr), ${args.frames || anim.frames} frames`);
  }
  return credits;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const characters = resolveCharacters(args);
  if (!characters.length) throw new Error('Nothing selected.');
  if (args.video && (characters.length !== 1 || characters[0].animations.length !== 1)) {
    throw new Error('--video needs exactly one character and one --anim');
  }

  if (args.dryRun) {
    let total = 0;
    for (const ch of characters) total += await planCharacter(openContext(ch, args));
    console.log(`~${total} credits total (provider: ${args.provider}).`);
    return;
  }

  provider = createProvider(args.provider, ROOT);
  let failures = 0;
  for (const ch of characters) {
    const ctx = openContext(ch, args);
    console.log(`[sprite] ${ch.id} (${ch.name})`);
    let cutout;
    try {
      cutout = await loadRgba(await ensureKeyframe(ctx));
    } catch (e) {
      failures++;
      console.error(`[error] ${ch.id}/keyframe: ${e.message}`);
      if (e.status === 402 || /insufficient credits/i.test(e.message)) break;
      continue;
    }
    for (const anim of ch.animations) {
      try {
        await processAnimation(ctx, anim, cutout);
      } catch (e) {
        failures++;
        console.error(`[error] ${ch.id}/${anim.name}: ${e.message}`);
        if (e.status === 402 || /insufficient credits/i.test(e.message)) { console.error('Out of credits — stopping.'); return finish(failures); }
      }
    }
  }
  finish(failures);
}

function finish(failures) {
  console.log(failures ? `Done with ${failures} failure(s).` : 'Done — all requested sprites generated.');
  if (failures) process.exitCode = 1;
}

if (require.main === module) main().catch(e => { console.error(e.message || e); process.exit(1); });

module.exports = { VIDEO_MODELS, DEFAULTS, SPRITES_DIR, allSprites, pickDuration, parseKeyframeSource, canonicalSource };
