// Chroma-key matting for video frames rendered on a flat key colour.
//
// Alpha comes from a colour-difference key (how far the key channel(s)
// exceed the others) rather than a colour-distance threshold. That ignores
// the brightness drift video models introduce and keeps full-resolution edge
// detail even though the source video's chroma is subsampled. Semi-
// transparent edge pixels are then un-mixed from the measured background
// colour and despilled, so edges don't carry a green/magenta/blue fringe.

const KEYS = {
  green: { rgb: [0, 255, 0], hex: '#00FF00', excess: (r, g, b) => g - Math.max(r, b) },
  magenta: { rgb: [255, 0, 255], hex: '#FF00FF', excess: (r, g, b) => Math.min(r, b) - g },
  blue: { rgb: [0, 0, 255], hex: '#0000FF', excess: (r, g, b) => b - Math.max(r, g) }
};

// Picks the key colour that least overlaps the character's own palette,
// scored by the share of opaque pixels that would be partly keyed or
// despilled against it.
function chooseKey(cutout) {
  const { data } = cutout;
  const hits = Object.fromEntries(Object.keys(KEYS).map(k => [k, 0]));
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    total++;
    for (const name in KEYS) if (KEYS[name].excess(data[i], data[i + 1], data[i + 2]) > 40) hits[name]++;
  }
  let key = 'green';
  for (const name in KEYS) if (hits[name] < hits[key]) key = name;
  return { key, conflict: total ? hits[key] / total : 0 };
}

// Median colour of a thin band around the frame edge: the model's actual
// rendition of the key colour, which drifts from the pure value we sent.
function sampleBackground(img) {
  const { data, width, height } = img;
  const band = Math.max(2, Math.round(Math.min(width, height) * 0.015));
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let count = 0;
  const add = (x, y) => {
    const o = (y * width + x) * 4;
    hist[0][data[o]]++; hist[1][data[o + 1]]++; hist[2][data[o + 2]]++;
    count++;
  };
  for (let y = 0; y < height; y++) {
    if (y < band || y >= height - band) for (let x = 0; x < width; x++) add(x, y);
    else for (let x = 0; x < band; x++) { add(x, y); add(width - 1 - x, y); }
  }
  const median = h => {
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += h[v]; if (acc * 2 >= count) return v; }
    return 255;
  };
  return hist.map(median);
}

// Which key colour a measured background actually is.
function detectKey(bg) {
  let best = null, bestExcess = -Infinity;
  for (const name in KEYS) {
    const e = KEYS[name].excess(bg[0], bg[1], bg[2]);
    if (e > bestExcess) { best = name; bestExcess = e; }
  }
  return best;
}

// lo/hi are fractions of the background's own key excess: pixels below lo
// are fully opaque, above hi fully transparent, linear in between.
function chromaAlpha(img, keyName, bg, { lo = 0.25, hi = 0.7 } = {}) {
  const key = KEYS[keyName];
  const bgExcess = key.excess(bg[0], bg[1], bg[2]);
  if (bgExcess < 40) throw new Error(`Frame background rgb(${bg.join(',')}) is not a usable ${keyName} key.`);
  const a0 = bgExcess * lo, a1 = bgExcess * hi;
  const { data, width, height } = img;
  const alpha = new Float32Array(width * height);
  for (let p = 0, o = 0; p < alpha.length; p++, o += 4) {
    const e = key.excess(data[o], data[o + 1], data[o + 2]);
    alpha[p] = e <= a0 ? 1 : e >= a1 ? 0 : 1 - (e - a0) / (a1 - a0);
  }
  return alpha;
}

// Zeroes small islands of alpha — compression noise, or a stray pebble the
// model kept — anything under `minArea` pixels that isn't 8-connected to a
// larger shape. Returns how many pixels were cleared.
function despeckle(alpha, width, height, minArea) {
  if (!minArea) return 0;
  const label = new Int32Array(alpha.length);
  const stack = new Int32Array(alpha.length);
  const sizes = [0];
  for (let p = 0; p < alpha.length; p++) {
    if (alpha[p] < 0.03 || label[p]) continue;
    const id = sizes.length;
    let sp = 0, size = 0;
    stack[sp++] = p;
    label[p] = id;
    while (sp) {
      const q = stack[--sp];
      size++;
      const x = q % width, y = (q - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const r = ny * width + nx;
          if (!label[r] && alpha[r] >= 0.03) { label[r] = id; stack[sp++] = r; }
        }
      }
    }
    sizes.push(size);
  }
  let cleared = 0;
  for (let p = 0; p < alpha.length; p++) {
    if (label[p] && sizes[label[p]] < minArea) { alpha[p] = 0; cleared++; }
  }
  return cleared;
}

// Alpha from an externally matted image (e.g. Bria's output).
function alphaFromImage(img) {
  const alpha = new Float32Array(img.width * img.height);
  for (let p = 0; p < alpha.length; p++) alpha[p] = img.data[p * 4 + 3] / 255;
  return alpha;
}

// Final RGBA frame. Opaque pixels keep their colour, despilled. Edge pixels
// need their foreground colour estimated, since the camera saw a mix:
// C = aF + (1-a)B. Solving for F directly ("un-mixing") is exact when alpha
// is, but multiplies any alpha error by 1/a, so an under-estimated edge
// over-subtracts the key and turns magenta. Edge colour therefore blends the
// un-mixed estimate with the mean of nearby opaque pixels, trusting the
// un-mix more as alpha rises (weight a²).
function applyMatte(img, alpha, keyName, bg, { radius = 3 } = {}) {
  const key = KEYS[keyName];
  const { data, width, height } = img;
  const final = new Float32Array(width * height);
  const out = Buffer.alloc(width * height * 4);
  const f = [0, 0, 0];
  const writeDespilled = o => {
    const e = key.excess(f[0], f[1], f[2]);
    if (e > 0) for (let c = 0; c < 3; c++) if (key.rgb[c]) f[c] -= e;
    out[o] = Math.round(f[0]);
    out[o + 1] = Math.round(f[1]);
    out[o + 2] = Math.round(f[2]);
  };

  // Pass 1: final alpha everywhere, colour for opaque pixels.
  for (let p = 0, o = 0; p < alpha.length; p++, o += 4) {
    let a = alpha[p];
    if (a < 0.03) continue;
    // A visible pixel darker than the background in a key channel can't be
    // mostly background: floor alpha so un-mixing never drives it negative.
    for (let c = 0; c < 3; c++) {
      if (key.rgb[c] && bg[c] > 64) {
        const floor = 1 - data[o + c] / bg[c];
        if (floor > a) a = floor;
      }
    }
    if (a > 0.97) a = 1;
    final[p] = a;
    out[o + 3] = Math.round(a * 255);
    if (a === 1) {
      f[0] = data[o]; f[1] = data[o + 1]; f[2] = data[o + 2];
      writeDespilled(o);
    }
  }

  // Pass 2: edge colour from the un-mix blended with nearby opaque pixels.
  for (let p = 0, o = 0; p < final.length; p++, o += 4) {
    const a = final[p];
    if (a === 0 || a === 1) continue;
    const x = p % width, y = (p - x) / width;
    let sr = 0, sg = 0, sb = 0, count = 0;
    for (let ny = Math.max(0, y - radius); ny <= Math.min(height - 1, y + radius); ny++) {
      for (let nx = Math.max(0, x - radius); nx <= Math.min(width - 1, x + radius); nx++) {
        const q = ny * width + nx;
        if (final[q] === 1) { sr += out[q * 4]; sg += out[q * 4 + 1]; sb += out[q * 4 + 2]; count++; }
      }
    }
    const w = count ? a * a : 1;
    const mean = [sr / (count || 1), sg / (count || 1), sb / (count || 1)];
    for (let c = 0; c < 3; c++) {
      let v = (data[o + c] - (1 - a) * bg[c]) / a;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      f[c] = v * w + mean[c] * (1 - w);
    }
    writeDespilled(o);
  }
  return { data: out, width, height };
}

module.exports = { KEYS, chooseKey, sampleBackground, detectKey, chromaAlpha, despeckle, alphaFromImage, applyMatte };
