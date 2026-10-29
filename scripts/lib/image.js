// RGBA helpers shared by the sprite pipeline. Images move between stages as
// { data, width, height } where data is 4-channel raw pixels.

const sharp = require('sharp');

async function loadRgba(input) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function toSharp(img) {
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } });
}

function savePng(img, file) { return toSharp(img).png().toFile(file); }

// Bounding box of pixels with alpha above `threshold`, or null if none.
function alphaBBox(img, threshold = 8) {
  const { data, width, height } = img;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function unionBox(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

// True when the file is an actual cutout, not just an opaque alpha channel.
async function hasTransparency(file) {
  const { data, width, height } = await loadRgba(file);
  let clear = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) clear++;
  return clear / (width * height) > 0.01;
}

// Crops away fully transparent margins.
async function saveTrimmed(img, file) {
  const box = alphaBBox(img);
  if (!box) throw new Error(`${file}: image is fully transparent`);
  await toSharp(img).extract({ left: box.x, top: box.y, width: box.w, height: box.h }).png().toFile(file);
}

// Shifts an RGBA image by whole pixels (positive dx moves content right),
// filling vacated space with transparency. Used to cancel a walking
// character's travel so the cycle plays in place.
function translateRgba(img, dx, dy) {
  const { data, width, height } = img;
  const out = Buffer.alloc(data.length);
  for (let y = 0; y < height; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= height) continue;
    const x0 = Math.max(0, dx), x1 = Math.min(width, width + dx);
    if (x1 <= x0) continue;
    data.copy(out, (y * width + x0) * 4, (sy * width + (x0 - dx)) * 4, (sy * width + (x1 - dx)) * 4);
  }
  return { data: out, width, height };
}

// 64×64 greyscale thumbnail for cheap frame-to-frame comparison.
function thumb(file) {
  return sharp(file).resize(64, 64, { fit: 'fill' }).greyscale().raw().toBuffer();
}

function meanAbsDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

module.exports = { loadRgba, toSharp, savePng, alphaBBox, unionBox, hasTransparency, saveTrimmed, translateRgba, thumb, meanAbsDiff };
