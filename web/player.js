// Plays one animation from a TexturePacker-style sheet (the <anim>.json +
// <anim>.png pair the pipeline writes) on a canvas, over a chosen background,
// with the character's pivot pinned to a fixed ground point.

class SheetPlayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.frames = [];
    this.image = null;
    this.index = 0;
    this.fps = 12;
    this.loop = true;
    this.playing = true;
    this.bg = 'dungeon';
    this.zoom = 'fit';
    this.showPivot = false;
    this.onFrame = null;
    this._last = 0;
    this._acc = 0;
    this._hold = 0;
    new ResizeObserver(() => this._resize()).observe(canvas);
    requestAnimationFrame(t => this._tick(t));
  }

  async load(jsonUrl, pngUrl) {
    const [data, image] = await Promise.all([
      fetch(jsonUrl).then(r => r.json()),
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = pngUrl;
      })
    ]);
    const names = Object.values(data.animations || {})[0] || Object.keys(data.frames);
    this.frames = names.map(n => data.frames[n]);
    this.image = image;
    this.fps = (data.meta && data.meta.fps) || 12;
    this.loop = !data.meta || data.meta.loop !== false;
    this.index = Math.min(this.index, this.frames.length - 1);
    this._acc = 0;
    this._hold = 0;
    this.draw();
    this._emit();
    return data;
  }

  clear() {
    this.frames = [];
    this.image = null;
    this.index = 0;
    this.draw();
    this._emit();
  }

  setFrame(i) {
    if (!this.frames.length) return;
    this.index = ((i % this.frames.length) + this.frames.length) % this.frames.length;
    this.draw();
    this._emit();
  }

  step(delta) {
    this.playing = false;
    this.setFrame(this.index + delta);
  }

  set(options) {
    Object.assign(this, options);
    this.draw();
  }

  _emit() {
    if (this.onFrame) this.onFrame(this.index, this.frames.length);
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.draw();
  }

  _tick(t) {
    requestAnimationFrame(tt => this._tick(tt));
    const dt = this._last ? Math.min(250, t - this._last) : 0;
    this._last = t;
    if (!this.playing || this.frames.length < 2) return;
    // One-shots (deaths) hold their last frame for a beat before replaying.
    if (this._hold > 0) {
      this._hold -= dt;
      if (this._hold <= 0) this.setFrame(0);
      return;
    }
    this._acc += dt;
    const frameMs = 1000 / this.fps;
    while (this._acc >= frameMs) {
      this._acc -= frameMs;
      if (!this.loop && this.index === this.frames.length - 1) {
        this._hold = 900;
        this._acc = 0;
        return;
      }
      this.setFrame(this.index + 1);
    }
  }

  draw() {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    this._drawBackground(W, H, dpr);
    const f = this.frames[this.index];
    if (!f || !this.image) return;
    const { x, y, w, h } = f.frame;
    const pivot = f.pivot || { x: 0.5, y: 1 };
    const ground = { x: W / 2, y: H * 0.84 };
    let scale;
    if (this.zoom === 'fit') {
      // Fit the cell with its pivot on the ground point.
      const up = (ground.y - H * 0.05) / (pivot.y * h);
      const down = (H - ground.y - H * 0.02) / Math.max(1, (1 - pivot.y) * h);
      const side = (W * 0.46) / (Math.max(pivot.x, 1 - pivot.x) * w);
      scale = Math.min(up, down, side);
    } else {
      scale = Number(this.zoom) * dpr;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const dx = ground.x - pivot.x * w * scale;
    const dy = ground.y - pivot.y * h * scale;
    if (this.bg === 'dungeon') this._drawShadow(ground, w * scale);
    ctx.drawImage(this.image, x, y, w, h, dx, dy, w * scale, h * scale);
    if (this.showPivot) this._drawPivot(ground, W, dpr, dx, dy, w * scale, h * scale);
  }

  _drawBackground(W, H, dpr) {
    const ctx = this.ctx;
    const flat = { black: '#000', white: '#fff', magenta: '#f0f' }[this.bg];
    if (flat) {
      ctx.fillStyle = flat;
      ctx.fillRect(0, 0, W, H);
      return;
    }
    if (this.bg === 'checker') {
      const s = 16 * dpr;
      ctx.fillStyle = '#5a5a5a';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#737373';
      for (let yy = 0; yy < H; yy += s) {
        for (let xx = (yy / s) % 2 ? s : 0; xx < W; xx += 2 * s) ctx.fillRect(xx, yy, s, s);
      }
      return;
    }
    // Dungeon: torch-lit stone with an isometric floor grid, roughly what the
    // sprite will stand on in game.
    const g = ctx.createRadialGradient(W / 2, H * 0.62, 0, W / 2, H * 0.62, Math.max(W, H) * 0.75);
    g.addColorStop(0, '#4a3322');
    g.addColorStop(0.45, '#241a14');
    g.addColorStop(1, '#0d0a09');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 220, 180, 0.06)';
    ctx.lineWidth = dpr;
    const step = 56 * dpr;
    ctx.beginPath();
    for (let k = -H; k < W + H; k += step) {
      ctx.moveTo(k, H * 0.45);
      ctx.lineTo(k + (H * 0.55) * 2, H);
      ctx.moveTo(k, H * 0.45);
      ctx.lineTo(k - (H * 0.55) * 2, H);
    }
    ctx.stroke();
    ctx.restore();
  }

  _drawShadow(ground, width) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(ground.x, ground.y);
    ctx.scale(1, 0.28);
    const r = width * 0.32;
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawPivot(ground, W, dpr, dx, dy, dw, dh) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(232, 116, 59, 0.9)';
    ctx.lineWidth = dpr;
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.strokeRect(dx, dy, dw, dh);
    ctx.beginPath();
    ctx.moveTo(0, ground.y);
    ctx.lineTo(W, ground.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(ground.x - 8 * dpr, ground.y);
    ctx.lineTo(ground.x + 8 * dpr, ground.y);
    ctx.moveTo(ground.x, ground.y - 8 * dpr);
    ctx.lineTo(ground.x, ground.y + 8 * dpr);
    ctx.stroke();
    ctx.restore();
  }
}
