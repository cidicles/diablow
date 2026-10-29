// Packs matted frames into a sprite sheet with TexturePacker "JSON Hash"
// metadata (readable by Phaser, Pixi and most engines), plus an animated
// WebP preview and a checkerboard contact sheet for eyeballing the alpha.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { toSharp, alphaBBox, unionBox } = require('./image');
const { encodeWebp } = require('./video');

// frames:  full-size RGBA frames, all the same dimensions
// anchor:  pivot point (the character's feet) in source-frame pixels
// scale:   source → output pixel scale, shared by all of a character's anims
async function buildSheet({ frames, anchor, scale, name, cols, spacing = 2, fps, loop, pngPath, jsonPath, webpPath, previewPath, cellsDir, meta = {} }) {
  // One crop box for every frame so the character never jitters between cells.
  let box = null;
  for (const f of frames) box = unionBox(box, alphaBBox(f));
  if (!box) throw new Error('every frame is fully transparent — the key removed the whole character');
  const W = frames[0].width, H = frames[0].height;
  const pad = Math.round(Math.max(box.w, box.h) * 0.03);
  const clamp = (v, max) => Math.max(0, Math.min(max, v));
  const x0 = clamp(Math.min(box.x - pad, Math.floor(anchor.x)), W);
  const y0 = clamp(Math.min(box.y - pad, Math.floor(anchor.y)), H);
  const x1 = clamp(Math.max(box.x + box.w + pad, Math.ceil(anchor.x) + 1), W);
  const y1 = clamp(Math.max(box.y + box.h + pad, Math.ceil(anchor.y) + 1), H);
  const crop = { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
  const cellW = Math.max(1, Math.round(crop.width * scale));
  const cellH = Math.max(1, Math.round(crop.height * scale));

  const cells = await Promise.all(frames.map(f =>
    toSharp(f).extract(crop).resize(cellW, cellH, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer()));

  cols = cols || Math.ceil(Math.sqrt(cells.length));
  const rows = Math.ceil(cells.length / cols);
  const sheetW = cols * cellW + (cols - 1) * spacing;
  const sheetH = rows * cellH + (rows - 1) * spacing;
  const round4 = v => Math.round(v * 1e4) / 1e4;
  const pivot = { x: round4((anchor.x - x0) * scale / cellW), y: round4((anchor.y - y0) * scale / cellH) };

  const json = { frames: {}, animations: { [name]: [] }, meta: {} };
  const composites = cells.map((input, i) => {
    const x = (i % cols) * (cellW + spacing);
    const y = Math.floor(i / cols) * (cellH + spacing);
    const frameName = `${name}/${String(i).padStart(3, '0')}`;
    json.frames[frameName] = {
      frame: { x, y, w: cellW, h: cellH },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: cellW, h: cellH },
      sourceSize: { w: cellW, h: cellH },
      pivot
    };
    json.animations[name].push(frameName);
    return { input, left: x, top: y };
  });
  json.meta = {
    app: 'diablow scripts/generate-sprites.js',
    image: path.basename(pngPath),
    format: 'RGBA8888',
    size: { w: sheetW, h: sheetH },
    scale: '1',
    fps,
    loop,
    ...meta
  };

  await sharp({ create: { width: sheetW, height: sheetH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites).png().toFile(pngPath);
  fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2));

  fs.rmSync(cellsDir, { recursive: true, force: true });
  fs.mkdirSync(cellsDir, { recursive: true });
  cells.forEach((buf, i) => fs.writeFileSync(path.join(cellsDir, `${String(i).padStart(3, '0')}.png`), buf));
  await encodeWebp(path.join(cellsDir, '%03d.png'), fps, webpPath);

  await checkerboard(sheetW, sheetH).composite([{ input: pngPath }]).png().toFile(previewPath);

  return { cellW, cellH, cols, rows, sheetW, sheetH, pivot };
}

function checkerboard(width, height, size = 16) {
  const buf = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = ((Math.floor(x / size) + Math.floor(y / size)) & 1) ? 150 : 100;
      buf.fill(v, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  }
  return sharp(buf, { raw: { width, height, channels: 3 } });
}

module.exports = { buildSheet };
