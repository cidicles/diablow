#!/usr/bin/env node
// Generates the environment art for the game via Apiframe: seamless ground
// tiles (Midjourney's tile param), and cutout props/pickups (Midjourney →
// Bria background removal → trimmed RGBA), saved under assets/tiles/ and
// assets/props/.
//
// Same paid-job caching idea as generate-sprites.js: job ids and results are
// recorded in assets/env-state.json as soon as they're submitted, so reruns
// never pay twice. Finished files are skipped unless --force.
//
// Usage:
//   node scripts/generate-env.js               # everything missing
//   node scripts/generate-env.js --only=ground_grave,gem
//   node scripts/generate-env.js --variant=2 --only=deadtree  # re-cut from another variant
//   node scripts/generate-env.js --dry-run

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Apiframe, loadApiKey, extractJobId, extractImages } = require('./lib/apiframe');
const { loadRgba, saveTrimmed } = require('./lib/image');

const ROOT = path.join(__dirname, '..');
const STATE_PATH = path.join(ROOT, 'assets', 'env-state.json');
const MIDJOURNEY_CREDITS = 10;
const BRIA_CREDITS = 2;

const TILE_STYLE = 'hand-painted dark fantasy game terrain texture, Diablo II style, top-down orthographic, perfectly even non-directional lighting, uniform detail density across the whole image, no objects, no creatures, no borders, no text, no watermark';
const PROP_STYLE = 'dark gothic fantasy, Diablo II style hand-painted 2D game prop, three-quarter isometric view from slightly above, single object centered in frame, full object visible with margin on all sides, plain flat light grey studio background, crisp readable silhouette, even lighting, no ground shadow, no text, no watermark --no scenery, cropped, photorealistic, photo, 3d render';

// kind: 'tile' → square seamless texture, resized to `size`.
//       'prop' → Bria-cutout RGBA, trimmed, feet/base at the bottom.
const ENTRIES = [
  { kind: 'tile', id: 'ground_grave', size: 512, prompt: 'seamless repeating texture of cursed graveyard earth, dark withered grass, bare dirt patches, scattered tiny bones and pebbles, muted desaturated greens and browns, ' + TILE_STYLE },
  { kind: 'tile', id: 'ground_blight', size: 512, prompt: 'seamless repeating texture of blighted cracked dirt, dead roots, faint grey moss, dry fissured earth, muted cold browns and greys, ' + TILE_STYLE },
  { kind: 'prop', id: 'gravestone', prompt: 'one old crooked granite tombstone, mossy and cracked, leaning slightly, ' + PROP_STYLE },
  { kind: 'prop', id: 'deadtree', prompt: 'one spooky bare dead oak tree, twisted black leafless branches, ' + PROP_STYLE },
  { kind: 'prop', id: 'boneheap', prompt: 'a single small heap of old bones and a cracked skull, ' + PROP_STYLE },
  { kind: 'prop', id: 'gem', prompt: 'a single glowing cyan soul crystal shard, faceted translucent gem with bright inner light, dark fantasy hand-painted game pickup, ' + PROP_STYLE },
  { kind: 'prop', id: 'blade', prompt: 'a single curved engraved steel throwing glaive with three blades arranged around a central ring, dark fantasy hand-painted game weapon, ' + PROP_STYLE }
];

function outPath(e) {
  return path.join(ROOT, 'assets', e.kind === 'tile' ? 'tiles' : 'props', `${e.id}.png`);
}

function parseArgs(argv) {
  const args = { only: null, force: false, dryRun: false, variant: 1 };
  for (const a of argv) {
    if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--only=')) args.only = a.slice(7).split(',').map(s => s.trim()).filter(Boolean);
    else if (a.startsWith('--variant=')) args.variant = Number(a.slice(10));
    else throw new Error(`Unknown option: ${a}`);
  }
  return args;
}

let api, state;

function saveState() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// Submit-once-and-remember, same contract as generate-sprites.js.
async function runJob(holder, slot, label, submit) {
  if (holder[slot] && holder[slot].result) return holder[slot].result;
  if (holder[slot] && holder[slot].jobId) {
    console.log(`  ${label}: resuming job ${holder[slot].jobId}`);
  } else {
    const res = await submit();
    const jobId = extractJobId(res);
    if (!jobId) throw new Error(`${label}: no job id in ${JSON.stringify(res)}`);
    holder[slot] = { jobId };
    saveState();
    console.log(`  ${label}: job ${jobId}`);
  }
  process.stdout.write('  waiting');
  try {
    const result = await api.waitForJob(holder[slot].jobId, { onTick: () => process.stdout.write('.') });
    console.log(' done');
    holder[slot].result = result;
    saveState();
    return result;
  } catch (e) {
    console.log('');
    if (e.jobFailed) { delete holder[slot]; saveState(); }
    throw e;
  }
}

async function generateOne(e, args) {
  const dest = outPath(e);
  const st = state[e.id] = state[e.id] || {};
  console.log(`[env] ${e.kind}/${e.id}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // Seamlessness comes from Midjourney's --tile prompt flag; the structured
  // midjourneyParams object rejects a tile key.
  const mj = await runJob(st, 'midjourney', 'midjourney', () =>
    api.post('/images/generate', {
      prompt: e.prompt + (e.kind === 'tile' ? ' --tile' : ''),
      model: 'midjourney',
      midjourneyParams: { aspect_ratio: '1:1' }
    }));
  const images = extractImages(mj);
  if (!images || !images.length) throw new Error('Midjourney returned no images: ' + JSON.stringify(mj));
  const variantsDir = path.join(path.dirname(dest), '_variants');
  for (let i = 0; i < images.length; i++) {
    const f = path.join(variantsDir, `${e.id}-${i + 1}.png`);
    if (!fs.existsSync(f)) await api.download(images[i], f);
  }
  const pick = images[Math.min(args.variant, images.length) - 1];

  if (e.kind === 'tile') {
    // The picked variant is already seamless (tile param); just square+resize.
    const img = sharp(path.join(variantsDir, `${e.id}-${args.variant}.png`));
    const meta = await img.metadata();
    const side = Math.min(meta.width, meta.height);
    await img.extract({ left: (meta.width - side) >> 1, top: (meta.height - side) >> 1, width: side, height: side })
      .resize(e.size, e.size, { kernel: 'lanczos3' }).png().toFile(dest);
  } else {
    const briaSlot = `bria${args.variant > 1 ? args.variant : ''}`;
    const bria = await runJob(st, briaSlot, 'background removal', () =>
      api.post('/images/background-remove', { model: 'bria-bg-remove', briaBgRemoveParams: { image: pick } }));
    const tmp = dest + '.bria.png';
    await api.download(extractImages(bria)[0], tmp);
    await saveTrimmed(await loadRgba(tmp), dest);
    fs.rmSync(tmp, { force: true });
  }
  console.log(`[saved] ${path.relative(ROOT, dest)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : {};
  let entries = args.only ? ENTRIES.filter(e => args.only.includes(e.id)) : ENTRIES;
  if (!args.force) entries = entries.filter(e => !fs.existsSync(outPath(e)));
  if (!entries.length) { console.log('Nothing to do — all environment art exists.'); return; }

  if (args.dryRun) {
    let credits = 0;
    for (const e of entries) {
      const st = state[e.id] || {};
      const c = (st.midjourney ? 0 : MIDJOURNEY_CREDITS) + (e.kind === 'prop' && !st.bria ? BRIA_CREDITS : 0);
      credits += c;
      console.log(`[plan] ${e.kind}/${e.id} (${c} cr)`);
    }
    console.log(`~${credits} credits total.`);
    return;
  }

  api = new Apiframe(loadApiKey(ROOT));
  let failures = 0;
  for (const e of entries) {
    try { await generateOne(e, args); }
    catch (err) {
      failures++;
      console.error(`[error] ${e.id}: ${err.message}`);
      if (err.status === 402 || /insufficient credits/i.test(err.message)) { console.error('Out of credits — stopping.'); break; }
    }
  }
  console.log(failures ? `Done with ${failures} failure(s).` : 'Done — all environment art generated.');
  if (failures) process.exitCode = 1;
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
