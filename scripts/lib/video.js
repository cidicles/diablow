// ffmpeg frame extraction and animation-range selection.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { meanAbsDiff } = require('./image');

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-hide_banner', '-nostats', ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error('ffmpeg failed: ' + stderr.trim().split('\n').slice(-3).join(' | ')));
      else resolve(stderr);
    });
  });
}

function listPngs(dir) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort().map(f => path.join(dir, f));
}

// Decodes every frame of the clip to PNG (once; cached with its fps in
// info.json) and returns { fps, files }.
async function loadFrames(videoPath, outDir, { force = false } = {}) {
  const infoPath = path.join(outDir, 'info.json');
  if (!force && fs.existsSync(infoPath)) {
    return { fps: JSON.parse(fs.readFileSync(infoPath, 'utf8')).fps, files: listPngs(outDir) };
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const log = await ffmpeg(['-i', videoPath, '-fps_mode', 'passthrough', path.join(outDir, '%04d.png')]);
  const m = log.match(/,\s*([\d.]+)\s*fps/);
  const fps = m ? parseFloat(m[1]) : 24;
  fs.writeFileSync(infoPath, JSON.stringify({ fps, source: videoPath }, null, 2));
  return { fps, files: listPngs(outDir) };
}

// Chooses which source frames go into the sheet.
//
// Cycles: the motion's true period is found by autocorrelation — the lag
// that best maps the clip onto itself between minCycle and maxCycle. That
// yields ONE clean stride/sway even when the model drifted over five of
// them (matching against frame 0 alone fails then, and sampling across
// multiple strides shuffles phases). The lead-in from the rest pose is
// skipped so the loop is all motion. If no confident period exists (slow
// aperiodic idles), fall back to the best return-to-frame-0 match.
//
// One-shots (deaths, attacks): run from where motion starts (leading
// stillness auto-trimmed; trimStart overrides for clips with a moving
// pre-amble) to where it stops, dropping any static tail.
//
// `maxFrames` is the sheet's frame budget and `targetFps` its playback rate.
// If the motion needs more frames than the budget at that rate, time is
// compressed to fit (`speed` > 1): video models render motions far slower
// than games play them.
function selectFrames(thumbs, fps, anim, maxFrames, targetFps, gait) {
  const n = thumbs.length;
  const stepDiff = [];
  for (let i = 0; i + 1 < n; i++) stepDiff.push(meanAbsDiff(thumbs[i], thumbs[i + 1]));
  const motion = stepDiff.reduce((a, b) => a + b, 0) / Math.max(1, stepDiff.length);

  const pack = (indices, extra) => ({ indices, fps: targetFps, ...extra });

  if (anim.cycle) {
    const minGap = Math.min(n - 2, Math.max(3, Math.round((anim.minCycle || 0.8) * fps)));
    const maxGap = Math.min(n - 2, Math.round((anim.maxCycle || 2.4) * fps));

    // Gait-signal path (center anims): 1-D body-shape series (bbox width /
    // height, detrended) expose a stride period that image matching misses
    // under tracking jitter. Candidate lags come from the scalar curves;
    // each is validated by the best 2-D seam over all phases, which also
    // rejects the half-gait alias (opposite legs ≈ same silhouette width).
    if (gait && gait[0].length === n) {
      const gs = p => {
        let s = 0, c = 0;
        for (const series of gait) for (let i = 0; i + p < n; i++) { s += Math.abs(series[i] - series[i + p]); c++; }
        return c ? s / c : Infinity;
      };
      const curve = [];
      for (let p = minGap; p <= maxGap; p++) curve.push(gs(p));
      const cands = [];
      for (let i = 1; i < curve.length - 1; i++) {
        if (curve[i] <= curve[i - 1] && curve[i] <= curve[i + 1]) cands.push({ p: minGap + i, s: curve[i] });
      }
      cands.sort((a, b) => a.s - b.s);
      const lead = Math.round(0.5 * fps);
      let best = null;
      for (const cand of cands.slice(0, 4)) {
        for (let s = lead; s + cand.p <= n - 1; s++) {
          const seam = meanAbsDiff(thumbs[s], thumbs[s + cand.p]);
          if (!best || seam < best.seam) best = { p: cand.p, start: s, seam };
        }
      }
      if (best) {
        const count = Math.max(2, Math.min(maxFrames, Math.round((best.p / fps) * targetFps), best.p));
        const indices = Array.from({ length: count }, (_, k) => best.start + Math.floor(k * best.p / count));
        return pack(indices, {
          mode: 'gait', start: best.start, end: best.start + best.p, loopDiff: best.seam,
          seconds: round1(best.p / fps), speed: round1((best.p / fps) / (count / targetFps))
        });
      }
    }
    const lagScore = p => {
      let sum = 0, c = 0;
      for (let i = 0; i + p < n; i += 2) { sum += meanAbsDiff(thumbs[i], thumbs[i + p]); c++; }
      return c ? sum / c : Infinity;
    };
    const scores = [];
    for (let p = minGap; p <= maxGap; p++) scores.push(lagScore(p));
    // the period must be a LOCAL minimum of the curve (aperiodic clips rise
    // monotonically, putting their "best" at the trivial smallest lag), and
    // clearly better than its own anti-phase lag (p/2: opposite pose)
    let period = null, periodScore = Infinity;
    for (let i = 1; i < scores.length - 1; i++) {
      if (scores[i] <= scores[i - 1] && scores[i] <= scores[i + 1] && scores[i] < periodScore) {
        periodScore = scores[i];
        period = minGap + i;
      }
    }
    if (period && periodScore < 0.7 * lagScore(Math.max(2, Math.round(period / 2)))) {
      const start = Math.min(Math.max(0, n - 1 - period), Math.round(0.8 * fps));
      const count = Math.max(2, Math.min(maxFrames, Math.round((period / fps) * targetFps), period));
      const indices = Array.from({ length: count }, (_, k) => start + Math.floor(k * period / count));
      return pack(indices, {
        mode: 'period', start, end: start + period,
        loopDiff: meanAbsDiff(thumbs[start], thumbs[start + period]),
        seconds: round1(period / fps), speed: round1((period / fps) / (count / targetFps))
      });
    }
    // aperiodic: best return to the rest pose (frame 0)
    const diff0 = thumbs.map(t => meanAbsDiff(thumbs[0], t));
    let end = n - 1;
    for (let i = minGap; i < n; i++) if (diff0[i] < diff0[end]) end = i;
    const count = Math.max(2, Math.min(maxFrames, Math.round((end / fps) * targetFps), end));
    const indices = Array.from({ length: count }, (_, k) => Math.floor(k * end / count));
    return pack(indices, {
      mode: 'return', start: 0, end, loopDiff: diff0[end],
      seconds: round1(end / fps), speed: round1((end / fps) / (count / targetFps))
    });
  }

  // one-shot
  let first;
  if (anim.trimStart != null) {
    first = Math.min(Math.round(anim.trimStart * fps), n - 3);
  } else {
    first = 0;
    const startThresh = Math.max(0.5, motion * 0.35);
    while (first < n - 3 && stepDiff[first] < startThresh) first++;
    first = Math.max(0, first - Math.round(fps * 0.08));
  }
  // end at the first sustained quiet AFTER the motion peak: one-shots often
  // carry a long tail (a flourish, settling) that pads the sheet with mush
  let peak = first;
  for (let i = first; i < stepDiff.length; i++) if (stepDiff[i] > stepDiff[peak]) peak = i;
  const quiet = Math.max(1.0, motion * 0.45);
  const win = Math.max(2, Math.round(0.3 * fps));
  let last = n - 1;
  for (let i = peak + Math.round(0.2 * fps); i + win <= stepDiff.length; i++) {
    let s = 0;
    for (let k = 0; k < win; k++) s += stepDiff[i + k];
    if (s / win < quiet) { last = Math.min(n - 1, i + 1); break; }
  }
  const span = last - first;
  const count = Math.max(1, Math.min(maxFrames, Math.round((span / fps) * targetFps) + 1, span + 1));
  const indices = count === 1 ? [first] : Array.from({ length: count }, (_, k) => first + Math.round(k * span / (count - 1)));
  return pack(indices, {
    mode: 'one-shot', start: first, end: last + 1, loopDiff: null,
    seconds: round1(span / fps), speed: round1((span / fps) / (Math.max(1, count - 1) / targetFps))
  });
}

function round1(x) { return Math.round(x * 10) / 10; }

// Lossless animated WebP (keeps alpha) from a numbered PNG sequence.
function encodeWebp(pattern, fps, outPath) {
  return ffmpeg(['-y', '-framerate', String(fps), '-i', pattern, '-c:v', 'libwebp_anim', '-lossless', '1', '-loop', '0', outPath]);
}

module.exports = { ffmpeg, loadFrames, selectFrames, encodeWebp };
