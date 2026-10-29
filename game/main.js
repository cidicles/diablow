// DIABLOW client: Phaser 3.90 renderer over game/sim.js.
// The renderer never decides gameplay — it feeds inputs to Sim.step and
// mirrors state + drains state.events for effects.

/* global Phaser, Sim, Sfx */
(() => {
  'use strict';

  const W = 1280, H = 720;
  const TILE_SCALE = 0.5;             // 512px tile → 256 world px
  const CHUNK = 640;                  // decor chunk size in world px
  const params = new URLSearchParams(location.search);
  const SEED = Number(params.get('seed')) || ((Math.random() * 1e6) | 0);
  const AUTO = params.get('auto') === '1';
  const T0 = Number(params.get('t0')) || 0;
  const TIMESCALE = Number(params.get('ts')) || 1;
  const HOLD = params.get('hold') === '1'; // QA: autopilot never confirms level-ups

  // characters: sim type → art id, with graceful fallback while art is
  // still generating (missing atlas → try fallback char, then any).
  const CHARS = {
    player: { id: 'warrior', anims: ['idle', 'walk', 'attack'], fallback: 'engineer', height: 118 },
    skeleton: { id: 'skeleton', anims: ['idle', 'walk', 'attack', 'death'], fallback: 'engineer', height: 108 },
    ghoul: { id: 'ghoul', anims: ['walk', 'death'], fallback: 'skeleton', height: 92 }
  };
  const TILES = ['ground_grave', 'ground_blight'];
  const PROPS = ['gravestone', 'deadtree', 'boneheap', 'gem', 'blade'];
  // one line per surviving minute; the last one repeats once you are past it
  const MILESTONES = [
    'the dead take notice', 'the ground will not hold them', 'the horde thickens',
    'something older stirs', 'the night has no bottom'
  ];

  const loaded = { atlas: new Set(), meta: {}, img: new Set() };

  function hash2(x, y, s) {
    let h = (x * 374761393 + y * 668265263 + s * 2246822519) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // ---------------------------------------------------------------- Boot --

  class Boot extends Phaser.Scene {
    constructor() { super('boot'); }

    preload() {
      this.load.on('loaderror', f => console.warn('missing asset:', f.key));
      // relative paths: the game must work from a sub-path (aislop.cloud/diablow/)
      for (const c of Object.values(CHARS)) {
        for (const a of c.anims) {
          const base = `sprites/${c.id}/${a}`;
          this.load.atlas(`${c.id}-${a}`, `${base}.png`, `${base}.json`);
          this.load.json(`${c.id}-${a}-meta`, `${base}.json`);
        }
      }
      for (const t of TILES) this.load.image(t, `tiles/${t}.png`);
      for (const p of PROPS) this.load.image(p, `props/${p}.png`);
    }

    create() {
      // record what actually arrived
      for (const c of Object.values(CHARS)) {
        for (const a of c.anims) {
          const key = `${c.id}-${a}`;
          if (this.textures.exists(key) && this.cache.json.has(`${key}-meta`)) {
            loaded.atlas.add(key);
            loaded.meta[key] = this.cache.json.get(`${key}-meta`);
          }
        }
      }
      for (const k of [...TILES, ...PROPS]) if (this.textures.exists(k)) loaded.img.add(k);

      // build animations from the sheet metadata (fps/loop/pivot travel
      // inside the TexturePacker JSON our pipeline writes)
      for (const key of loaded.atlas) {
        const meta = loaded.meta[key];
        const names = Object.keys(meta.frames);
        this.anims.create({
          key,
          frames: names.map(frame => ({ key, frame })),
          frameRate: meta.meta.fps || 12,
          repeat: meta.meta.loop === false ? 0 : -1
        });
      }

      this.makeGeneratedTextures();
      this.scene.start('game');
    }

    // Small procedural textures: soft light, glow dot, slash arc, shadow,
    // particles, blight patch (tile × radial alpha).
    makeGeneratedTextures() {
      // gradient ends INSIDE the canvas (0.93r): if it touches the border,
      // edge-clamp smearing under ADD blend draws a faint hard-edged plate
      const radial = (key, size, stops) => {
        const cv = this.textures.createCanvas(key, size, size);
        const ctx = cv.getContext();
        const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.465);
        for (const [p, c] of stops) g.addColorStop(p, c);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        cv.refresh();
      };
      radial('light', 780, [[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.9)'], [0.7, 'rgba(255,255,255,0.45)'], [1, 'rgba(255,255,255,0)']]);
      radial('glowdot', 64, [[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]);
      radial('shadow', 128, [[0, 'rgba(0,0,0,0.5)'], [0.7, 'rgba(0,0,0,0.35)'], [1, 'rgba(0,0,0,0)']]);

      { // slash: a sword trail pointing +x. Drawn as many short tapered
        // segments rather than one constant-width band: a uniform stroke under
        // ADD saturates to a white banana that buries the hero mid-swing.
        const s = 256, cv = this.textures.createCanvas('slash', s, s);
        const ctx = cv.getContext();
        ctx.translate(s / 2, s / 2);
        ctx.lineCap = 'round';
        const A = 1.05, SEG = 48;
        for (let pass = 0; pass < 2; pass++) {
          const halo = pass === 0;
          for (let i = 0; i < SEG; i++) {
            const t0 = i / SEG, t1 = (i + 1) / SEG;
            // thick and bright at the leading edge, tapering to nothing
            const taper = Math.pow(Math.sin(Math.PI * (0.12 + t0 * 0.88)), 1.5) * (0.35 + t0 * 0.65);
            ctx.beginPath();
            ctx.arc(0, 0, 104, -A + t0 * 2 * A, -A + t1 * 2 * A);
            ctx.strokeStyle = halo
              ? `rgba(255,196,120,${0.16 * taper})`
              : `rgba(255,238,206,${0.62 * taper})`;
            ctx.lineWidth = halo ? 34 * taper + 6 : 13 * taper + 1.5;
            ctx.stroke();
          }
        }
        cv.refresh();
      }
      // A dark pool drawn OVER a character's feet. The generated hero sheets
      // are framed knee-up, so the sprite ends on a hard horizontal cut; this
      // sinks that edge into shadow and reads as standing in the dark.
      radial('pool', 128, [[0, 'rgba(255,255,255,1)'], [0.55, 'rgba(255,255,255,0.82)'], [1, 'rgba(255,255,255,0)']]);
      // low graveyard mist: the other half of hiding that crop line, and the
      // one that adds atmosphere rather than just subtracting light
      radial('mist', 128, [[0, 'rgba(255,255,255,0.85)'], [0.5, 'rgba(255,255,255,0.4)'], [1, 'rgba(255,255,255,0)']]);
      { // tiny particle square
        const cv = this.textures.createCanvas('px', 4, 4);
        cv.getContext().fillStyle = '#fff';
        cv.getContext().fillRect(0, 0, 4, 4);
        cv.refresh();
      }
      // soft-edged terrain patches: blight (contrast variation) and a grave
      // self-patch (rotated over the base tile it breaks the repeat cadence)
      const patch = (key, srcKey) => {
        if (!loaded.img.has(srcKey)) return;
        const s = 512, cv = this.textures.createCanvas(key, s, s);
        const ctx = cv.getContext();
        ctx.drawImage(this.textures.get(srcKey).getSourceImage(), 0, 0, s, s);
        ctx.globalCompositeOperation = 'destination-in';
        const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        g.addColorStop(0, 'rgba(0,0,0,1)');
        g.addColorStop(0.55, 'rgba(0,0,0,0.85)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
        cv.refresh();
      };
      patch('blightpatch', 'ground_blight');
      patch('gravepatch', 'ground_grave');
    }
  }

  // -------------------------------------------------------- helpers -------

  function bestAtlas(charKey, anim) {
    const c = CHARS[charKey];
    const chain = [c.id, c.fallback, 'skeleton', 'engineer'];
    for (const id of chain) {
      if (loaded.atlas.has(`${id}-${anim}`)) return `${id}-${anim}`;
      if (loaded.atlas.has(`${id}-idle`)) return `${id}-idle`;
      if (loaded.atlas.has(`${id}-walk`)) return `${id}-walk`;
    }
    return null;
  }

  function pivotOf(atlasKey) {
    const meta = loaded.meta[atlasKey];
    const first = meta && meta.frames[Object.keys(meta.frames)[0]];
    return (first && first.pivot) || { x: 0.5, y: 0.95 };
  }

  function frameH(atlasKey) {
    const meta = loaded.meta[atlasKey];
    const first = meta && meta.frames[Object.keys(meta.frames)[0]];
    return first ? first.sourceSize.h : 256;
  }

  // ---------------------------------------------------------------- Game --

  class Game extends Phaser.Scene {
    constructor() { super('game'); }

    create() {
      this.sim = Sim.create(SEED);
      this.acc = 0;
      this.started = AUTO;         // title screen until a key is pressed
      this.botChoiceT = 0;
      this.enemyViews = new Map(); // id → {sprite, shadow}
      this.gemViews = new Map();
      this.bladeViews = new Map();
      this.chunks = new Map();
      this.viewScale = {};

      // -- ground
      if (loaded.img.has('ground_grave')) {
        this.ground = this.add.tileSprite(0, 0, W + 64, H + 64, 'ground_grave')
          .setOrigin(0).setScrollFactor(0).setDepth(-1e6).setTileScale(TILE_SCALE);
      } else {
        this.add.rectangle(0, 0, W * 2, H * 2, 0x1a1712).setScrollFactor(0).setDepth(-1e6);
      }

      // -- player
      const pAtlas = bestAtlas('player', 'idle');
      this.playerShadow = this.add.image(0, 0, 'shadow').setDisplaySize(92, 34).setAlpha(0.9);
      // warm under-glow separates the hero from the ground palette
      this.playerGlow = this.add.image(0, 0, 'glowdot').setBlendMode('ADD')
        .setTint(0xffc070).setDisplaySize(120, 60).setAlpha(0.4);
      this.player = this.add.sprite(0, 0, pAtlas || '__DEFAULT');
      if (pAtlas) this.setAnim(this.player, 'player', 'idle', true);
      // drawn ON TOP of the hero: the sheet is framed knee-up, so without this
      // he ends on a razor-straight line and reads as amputated
      this.playerFeet = this.add.image(0, 0, 'pool').setTint(0x06030a)
        .setDisplaySize(124, 76).setAlpha(0.86);
      // two wisps drifting out of phase: one static puff reads as a smudge
      this.playerMist = [0, 1].map(i => this.add.image(0, 0, 'mist')
        .setBlendMode('ADD').setTint(0x9f8f78).setDisplaySize(150, 40).setAlpha(0.09));

      // -- darkness + torchlight (render texture with erased light holes)
      this.darkness = this.add.renderTexture(0, 0, W, H)
        .setOrigin(0).setScrollFactor(0).setDepth(8000);
      // warm additive torch glow under the darkness layer
      this.torchGlow = this.add.image(0, 0, 'light')
        .setBlendMode('ADD').setTint(0xff9a4d).setAlpha(0.13).setDepth(7900).setScale(1.15);

      // -- particles
      // feedback layers sit ABOVE the darkness layer (8000): dimming your
      // own damage numbers and blood defeats their purpose
      this.blood = this.add.particles(0, 0, 'px', {
        speed: { min: 80, max: 260 }, angle: { min: 0, max: 360 },
        scale: { start: 2.4, end: 0.4 }, lifespan: 520, gravityY: 320,
        tint: [0xc22a2a, 0x8f1616, 0xe04848], emitting: false
      }).setDepth(8500);
      this.bones = this.add.particles(0, 0, 'px', {
        speed: { min: 40, max: 180 }, angle: { min: 0, max: 360 },
        scale: { start: 1.8, end: 0.4 }, alpha: { start: 1, end: 0 },
        lifespan: 700, gravityY: 260, tint: [0xd8d2c0, 0x8a8272], emitting: false
      }).setDepth(8500);
      this.sparkle = this.add.particles(0, 0, 'glowdot', {
        speed: { min: 10, max: 60 }, scale: { start: 0.32, end: 0 },
        lifespan: 500, blendMode: 'ADD', tint: 0x7dfbe9, emitting: false
      }).setDepth(8500);

      // -- damage number pool
      this.dmgPool = [];
      for (let i = 0; i < 40; i++) {
        this.dmgPool.push(this.add.text(0, 0, '', {
          fontFamily: 'Georgia, serif', fontSize: '20px', color: '#ffd75e',
          stroke: '#402808', strokeThickness: 4
        }).setOrigin(0.5).setDepth(8600).setVisible(false));
      }

      // -- camera
      const cam = this.cameras.main;
      cam.startFollow({ x: 0, y: 0 }, false, 0.12, 0.12);
      this.camTarget = cam._follow;
      if (this.renderer.type === Phaser.WEBGL) {
        cam.postFX.addVignette(0.5, 0.5, 0.92, 0.42);
      }

      // -- input
      this.keys = this.input.keyboard.addKeys('W,A,S,D,UP,LEFT,DOWN,RIGHT,ONE,TWO,THREE,R,M,P,ESC,SPACE,ENTER');
      this.paused = false;
      this.restartRequested = false;
      this.pendingChoice = null;
      this.choiceIndex = 0;
      // WebAudio may only start from a gesture, so the same press that leaves
      // the title screen is what opens the context
      const begin = () => { Sfx.unlock(); if (!this.started) { this.started = true; Sfx.startAmbience(); } };
      this.input.keyboard.on('keydown', begin);
      this.input.on('pointerdown', begin);

      // Discrete actions are driven by key EVENTS, not by polling JustDown in
      // update(). Polling silently eats any press that starts and ends inside
      // one 16ms frame, which is a real (if quick) tap - pausing or picking a
      // boon must never be dropped. Movement still polls isDown, as it should.
      const kb = this.input.keyboard;
      const onKey = (name, fn) => kb.on('keydown-' + name, fn);
      const deathReady = () => this.sim.over && this.time.now - (this.overAt || 0) > 900;

      onKey('M', () => { Sfx.unlock(); Sfx.toggleMute(); });
      ['ESC', 'P'].forEach(k => onKey(k, () => {
        if (!this.sim.over) this.setPaused(!this.paused);
      }));
      // restarts are deferred to update(): tearing the scene down from inside
      // an input callback destroys the objects the rest of the callback needs
      onKey('R', () => { if (this.sim.over || this.paused) this.restartRequested = true; });
      kb.on('keydown', () => { if (deathReady()) this.restartRequested = true; });
      this.input.on('pointerdown', () => { if (deathReady()) this.restartRequested = true; });

      [['ONE', 0], ['TWO', 1], ['THREE', 2]].forEach(([k, i]) => onKey(k, () => {
        if (this.sim.choosing) this.pendingChoice = i;
      }));
      ['LEFT', 'A'].forEach(k => onKey(k, () => { if (this.sim.choosing) this.setChoiceIndex(this.choiceIndex - 1); }));
      ['RIGHT', 'D'].forEach(k => onKey(k, () => { if (this.sim.choosing) this.setChoiceIndex(this.choiceIndex + 1); }));
      ['ENTER', 'SPACE'].forEach(k => onKey(k, () => {
        if (this.sim.choosing) this.pendingChoice = this.choiceIndex;
      }));
      // a tabbed-out game that keeps taking damage is the oldest bug in the
      // genre; re-bound each restart, so drop the previous one first
      this.game.events.off('blur', this._onBlur);
      this._onBlur = () => { if (this.started && !this.sim.over) this.setPaused(true); };
      this.game.events.on('blur', this._onBlur);

      this.buildHud();
      this.buildOverlays();
      if (!this.started) this.showTitle();
      if (AUTO) Sfx.unlock();

      // debug/QA handle
      const scene = this;
      window.__game = {
        get state() { return scene.sim; },
        renderer: this.renderer.type === Phaser.WEBGL ? 'webgl' : 'canvas',
        loaded,
        forceLevelup() { scene.sim.player.xp = scene.sim.player.xpNext; },
        forceGameover() { scene.sim.player.hp = 0; },
        spawnBurst(n) { Sim.debugSpawn(scene.sim, n || 40); },
        setPaused(on) { scene.setPaused(on); },
        get audio() { return { ready: Sfx.ready, muted: Sfx.muted }; },
        get scene() { return scene; }
      };

      // fast-forward for QA screenshots (drain events silently). The scrub
      // ALWAYS answers a pending level-up, even under ?hold=1 - the hold flag
      // is about freezing the live overlay, and letting it apply here instead
      // stalls the whole fast-forward on the first boon (the sim returns early
      // while `choosing`, so time stops advancing and t0 is never reached).
      if (T0 > 0) {
        let guard = 0;
        while (this.sim.time < T0 && !this.sim.over && guard++ < 40000) {
          const input = this.botInput(1 / 30);
          if (this.sim.choosing && input.choice == null) input.choice = (this.sim.time * 7 | 0) % 3;
          Sim.step(this.sim, 1 / 30, input);
          this.sim.events.length = 0;
        }
      }
    }

    // ------------------------------------------------------------- HUD --

    buildHud() {
      this.hudItems = [];
      const ui = n => { n.setScrollFactor(0).setDepth(9000); this.hudItems.push(n); return n; };
      this.hud = {};
      // XP bar (top) — gold, framed
      ui(this.add.rectangle(W / 2, 14, W - 24, 14, 0x000000, 0.55).setStrokeStyle(1, 0x6b5a2e));
      this.hud.xp = ui(this.add.rectangle(13, 8, 0, 12, 0xd8b45a).setOrigin(0, 0));
      this.hud.level = ui(this.add.text(W - 18, 26, 'LV 1', { fontFamily: 'Georgia, serif', fontSize: '16px', color: '#d8b45a' }).setOrigin(1, 0));
      // HP bar (bottom-left) — framed
      ui(this.add.rectangle(24, H - 30, 260, 18, 0x000000, 0.55).setOrigin(0, 0.5).setStrokeStyle(1, 0x6b3a2e));
      this.hud.hp = ui(this.add.rectangle(26, H - 30, 256, 14, 0xb3202a).setOrigin(0, 0.5));
      this.hud.hpText = ui(this.add.text(154, H - 31, '', { fontFamily: 'Georgia, serif', fontSize: '13px', color: '#ffd9d9' }).setOrigin(0.5));
      // timer + kills
      this.hud.timer = ui(this.add.text(W / 2, 44, '0:00', { fontFamily: 'Georgia, serif', fontSize: '30px', color: '#e8dcc0', stroke: '#000', strokeThickness: 5 }).setOrigin(0.5, 0));
      this.hud.kills = ui(this.add.text(W - 18, H - 40, '☠ 0', { fontFamily: 'Georgia, serif', fontSize: '20px', color: '#d0c8b0', stroke: '#000', strokeThickness: 4 }).setOrigin(1, 0.5));
      this.hud.hurt = this.add.rectangle(W / 2, H / 2, W, H, 0xaa0000, 0).setScrollFactor(0).setDepth(8990);
      // a separate, slower red wash for the "about to die" state — the hit
      // flash is a blink, this one breathes
      this.hud.danger = this.add.rectangle(W / 2, H / 2, W, H, 0x8c0010, 0).setScrollFactor(0).setDepth(8985);
      this.hud.mute = ui(this.add.text(18, 20, '', { fontFamily: 'Georgia, serif', fontSize: '15px', color: '#6b6354' }).setOrigin(0, 0));
      // milestone banner, parked invisible and reused
      this.banner = this.add.text(W / 2, H * 0.3, '', {
        fontFamily: 'Georgia, serif', fontSize: '34px', color: '#c8a44a',
        stroke: '#000', strokeThickness: 6, align: 'center'
      }).setOrigin(0.5).setScrollFactor(0).setDepth(9100).setAlpha(0);
      this.xpShown = 0;
      this._dmgSeq = 0;
    }

    // ------------------------------------------------------ overlays ----

    buildOverlays() {
      const ui = n => n.setScrollFactor(0).setDepth(9400).setVisible(false);
      this.pauseGroup = [
        ui(this.add.rectangle(W / 2, H / 2, W, H, 0x050308, 0.72)),
        // kept off centre so the frozen hero stays visible underneath
        ui(this.add.text(W / 2, H * 0.3, 'PAUSED', { fontFamily: 'Georgia, serif', fontSize: '64px', color: '#c8a44a', stroke: '#2a1608', strokeThickness: 8 }).setOrigin(0.5)),
        ui(this.add.text(W / 2, H * 0.385, 'ESC or P to resume   ·   M to mute   ·   R to abandon the run', { fontFamily: 'Georgia, serif', fontSize: '18px', color: '#9a917d' }).setOrigin(0.5))
      ];
    }

    setPaused(on) {
      if (this.sim.over || !this.started || this.paused === on) return;
      this.paused = on;
      this.pauseGroup.forEach(o => o.setVisible(on));
      this.acc = 0; // never bank the wall-clock spent in the menu
    }

    // A short centred announcement. Used for minute milestones; deliberately
    // above the darkness and gone in under two seconds.
    showBanner(text) {
      this.banner.setText(text).setAlpha(0).setScale(0.86);
      this.tweens.killTweensOf(this.banner);
      this.tweens.add({ targets: this.banner, alpha: 1, scale: 1, duration: 260, ease: 'Back.Out' });
      this.tweens.add({ targets: this.banner, alpha: 0, delay: 1500, duration: 500 });
    }

    bestRun() {
      try {
        const board = JSON.parse(localStorage.getItem('diablow_scores') || '[]');
        return board.length ? board[0] : null;
      } catch (e) { return null; }
    }

    // The HUD belongs to active play only — overlays (title, level-up,
    // game over) get a clean stage.
    setHudVisible(on) {
      if (this._hudOn === on) return;
      this._hudOn = on;
      for (const n of this.hudItems) n.setVisible(on);
    }

    showTitle() {
      // Text framed above/below the hero, who stands centre-stage in the
      // torchlight; nothing overlaps him.
      const ui = n => n.setScrollFactor(0).setDepth(9500);
      const title = ui(this.add.text(W / 2, H * 0.2, 'DIABLOW', { fontFamily: 'Georgia, serif', fontSize: '92px', color: '#c8a44a', stroke: '#2a1608', strokeThickness: 10 }).setOrigin(0.5));
      const prompt = ui(this.add.text(W / 2, H * 0.88, 'press any key', { fontFamily: 'Georgia, serif', fontSize: '21px', color: '#cfc6ae' }).setOrigin(0.5));
      this.titleGroup = [
        ui(this.add.rectangle(W / 2, H / 2, W, H, 0x050308, 0.48)),
        // a band of torchlight behind the name lifts it off the ground tile
        ui(this.add.image(W / 2, H * 0.2, 'light').setBlendMode('ADD').setTint(0xff9a4d).setAlpha(0.06).setDisplaySize(900, 260)),
        title,
        ui(this.add.text(W / 2, H * 0.31, '— NIGHT OF THE RISEN —', { fontFamily: 'Georgia, serif', fontSize: '24px', color: '#9a8f77', letterSpacing: 8 }).setOrigin(0.5)),
        ui(this.add.text(W / 2, H * 0.755, 'WASD / arrows to move   ·   attacks swing themselves', { fontFamily: 'Georgia, serif', fontSize: '19px', color: '#cfc6ae' }).setOrigin(0.5)),
        ui(this.add.text(W / 2, H * 0.81, 'ESC pause   ·   M mute   ·   1 2 3 pick a boon', { fontFamily: 'Georgia, serif', fontSize: '16px', color: '#7e7667' }).setOrigin(0.5)),
        prompt
      ];
      // the hero is the art this whole pipeline exists for — show him at size
      this.titleHeroScale = 1.5;
      const best = this.bestRun();
      if (best) {
        const m = Math.floor(best.time / 60), ss = Math.floor(best.time % 60);
        this.titleGroup.push(ui(this.add.text(W / 2, H * 0.375,
          `your longest night  ·  ${m}:${String(ss).padStart(2, '0')}  ·  ${best.kills} slain`,
          { fontFamily: 'Georgia, serif', fontSize: '17px', color: '#8a7c55' }).setOrigin(0.5)));
      }
      this.tweens.add({ targets: prompt, alpha: 0.35, yoyo: true, repeat: -1, duration: 700 });
      // the logo breathes a little; a dead-still title screen reads as a crash
      this.tweens.add({ targets: title, scale: 1.015, yoyo: true, repeat: -1, duration: 2600, ease: 'Sine.InOut' });
    }

    // ------------------------------------------------------- decor ------

    ensureChunks() {
      const cam = this.cameras.main;
      const cx0 = Math.floor(cam.scrollX / CHUNK) - 1, cy0 = Math.floor(cam.scrollY / CHUNK) - 1;
      const want = new Set();
      for (let cx = cx0; cx <= cx0 + Math.ceil(W / CHUNK) + 1; cx++) {
        for (let cy = cy0; cy <= cy0 + Math.ceil(H / CHUNK) + 1; cy++) {
          const key = cx + ',' + cy;
          want.add(key);
          if (this.chunks.has(key)) continue;
          const objs = [];
          // terrain patches under everything: rotated grave self-patches
          // break the tile's repeat cadence, blight patches add real
          // material variation (they need enough alpha to read as terrain)
          for (const [key, count, alpha, depth] of [['gravepatch', 2, 0.55, 8], ['blightpatch', hash2(cx, cy, 7) < 0.45 ? 2 : 3, 0.85, 10]]) {
            if (!this.textures.exists(key)) continue;
            for (let i = 0; i < count; i++) {
              const r1 = hash2(cx, cy, 11 + i + depth), r2 = hash2(cx, cy, 23 + i + depth), r3 = hash2(cx, cy, 37 + i + depth);
              objs.push(this.add.image(cx * CHUNK + r1 * CHUNK, cy * CHUNK + r2 * CHUNK, key)
                .setScale(0.7 + r3 * 0.7).setAlpha(alpha).setAngle(r3 * 360).setDepth(-1e6 + depth));
            }
          }
          // props, depth-sorted with entities (shaded by torch distance in update)
          const propKeys = ['gravestone', 'deadtree', 'boneheap'].filter(k => loaded.img.has(k));
          if (propKeys.length) {
            const n = 1 + (hash2(cx, cy, 41) < 0.5 ? 1 : 0) + (hash2(cx, cy, 43) < 0.3 ? 1 : 0);
            for (let i = 0; i < n; i++) {
              const pick = propKeys[(hash2(cx, cy, 53 + i) * propKeys.length) | 0];
              const x = cx * CHUNK + hash2(cx, cy, 61 + i) * CHUNK;
              const y = cy * CHUNK + hash2(cx, cy, 71 + i) * CHUNK;
              const target = pick === 'deadtree' ? 240 : pick === 'gravestone' ? 88 : 44;
              const img = this.add.image(x, y, pick).setOrigin(0.5, 0.94);
              img.setScale((target * (0.8 + hash2(cx, cy, 83 + i) * 0.4)) / img.height);
              img.setFlipX(hash2(cx, cy, 97 + i) < 0.5);
              img.setDepth(y);
              objs.push(this.add.image(x, y + 2, 'shadow')
                .setDisplaySize(img.displayWidth * 0.9, img.displayWidth * 0.3).setAlpha(0.7).setDepth(y - 0.5));
              objs.push(img);
            }
          }
          this.chunks.set(key, objs);
        }
      }
      for (const [key, objs] of this.chunks) {
        if (!want.has(key)) { objs.forEach(o => o.destroy()); this.chunks.delete(key); }
      }
    }

    // ------------------------------------------------------ sprites -----

    setAnim(sprite, charKey, anim, force) {
      const atlasKey = bestAtlas(charKey, anim);
      if (!atlasKey) return;
      if (!force && sprite.anims.currentAnim && sprite.anims.currentAnim.key === atlasKey) return;
      const pv = pivotOf(atlasKey);
      sprite.setOrigin(pv.x, pv.y);
      // scale by the CHARACTER's normalized height in the sheet (charHeight),
      // never the cell height — cells vary per animation (a sword swing needs
      // a big cell) and scaling by them shrinks the character mid-animation
      const scaleKey = charKey + ':' + atlasKey;
      if (!this.viewScale[scaleKey]) {
        const meta = loaded.meta[atlasKey];
        this.viewScale[scaleKey] = CHARS[charKey].height / ((meta && meta.meta && meta.meta.charHeight) || 256);
      }
      // sizeMult is the per-individual variation set when the view is made;
      // without it a horde of one enemy type is a photocopy wall
      const flip = sprite.flipX;
      sprite.baseScale = this.viewScale[scaleKey] * (sprite.sizeMult || 1);
      sprite.setScale(sprite.baseScale);
      sprite.setFlipX(flip);
      sprite.play({ key: atlasKey, startFrame: force ? 0 : ((Math.random() * 4) | 0) }, true);
    }

    // seconds one full playthrough of an animation takes
    animDuration(charKey, anim) {
      const atlasKey = bestAtlas(charKey, anim);
      const meta = atlasKey && loaded.meta[atlasKey];
      if (!meta) return 0.55;
      return Object.keys(meta.frames).length / (meta.meta.fps || 12);
    }

    enemyView(e) {
      let v = this.enemyViews.get(e.id);
      if (!v) {
        const m = e.scale || 1;
        const shadow = this.add.image(e.x, e.y, 'shadow').setDisplaySize(74 * m, 26 * m).setAlpha(0.85);
        const sprite = this.add.sprite(e.x, e.y, '__DEFAULT');
        sprite.sizeMult = m;
        this.setAnim(sprite, e.type, 'walk', true);
        v = { sprite, shadow, dead: false, hitT: 0 };
        this.enemyViews.set(e.id, v);
      }
      return v;
    }

    // ------------------------------------------------------ bot ---------

    botInput(dt) {
      const s = this.sim, p = s.player;
      if (s.choosing) {
        if (HOLD) return {};
        this.botChoiceT += dt;
        if (this.botChoiceT > 0.4) { this.botChoiceT = 0; return { choice: (s.time * 7 | 0) % 3 }; }
        return {};
      }
      let ax = 0, ay = 0;
      for (const e of s.enemies) {
        if (e.dying) continue;
        const dx = p.x - e.x, dy = p.y - e.y;
        const d = Math.hypot(dx, dy);
        if (d < 260 && d > 1) { const w = ((260 - d) / 260) ** 2 * 3; ax += (dx / d) * w; ay += (dy / d) * w; }
      }
      let bestGem = null, bestD = 520;
      for (const g of s.gems) {
        const d = Math.hypot(g.x - p.x, g.y - p.y);
        if (d < bestD) { bestD = d; bestGem = g; }
      }
      if (bestGem) {
        const d = bestD || 1;
        ax += (bestGem.x - p.x) / d; ay += (bestGem.y - p.y) / d;
      }
      ax += Math.sin(s.time * 0.9) * 0.35; ay += Math.cos(s.time * 0.53) * 0.35;
      const l = Math.hypot(ax, ay) || 1;
      return { mx: ax / l, my: ay / l };
    }

    keyInput() {
      const k = this.keys;
      let mx = (k.D.isDown || k.RIGHT.isDown ? 1 : 0) - (k.A.isDown || k.LEFT.isDown ? 1 : 0);
      let my = (k.S.isDown || k.DOWN.isDown ? 1 : 0) - (k.W.isDown || k.UP.isDown ? 1 : 0);
      // Boon picking arrives via this.pendingChoice from the key handlers in
      // create(); the world is frozen while choosing, so drop movement too.
      if (this.sim.choosing) return { mx: 0, my: 0 };
      return { mx, my };
    }

    // ------------------------------------------------------ events ------

    handleEvents() {
      const s = this.sim;
      for (const ev of s.events) {
        switch (ev.t) {
          case 'hit': {
            this.blood.explode(ev.crit ? 16 : 7, ev.x, ev.y - 40);
            const v = this.enemyViews.get(ev.id);
            if (v && !v.dead) {
              // A FILLED silhouette reads as a brand-new ghost enemy inside a
              // horde, which is worse than no feedback at all. A multiply tint
              // plus a squash pop says "this one got hit" without erasing the
              // art underneath it.
              v.hitT = ev.crit ? 0.2 : 0.11;
              v.sprite.setTint(ev.crit ? 0xffd2d2 : 0xffb98e);
              const pop = ev.crit ? 1.2 : 1.09;
              this.tweens.killTweensOf(v.sprite);
              const bs = v.sprite.baseScale || 1;
              v.sprite.setScale(bs * pop, bs * (2 - pop));
              this.tweens.add({ targets: v.sprite, scaleX: bs, scaleY: bs, duration: ev.crit ? 190 : 120, ease: 'Back.Out' });
            }
            this.spawnDmg(ev.x, ev.y - 70, ev.dmg, ev.crit);
            if (ev.crit) { Sfx.play('crit'); this.cameras.main.shake(70, 0.003); }
            else Sfx.play('hit');
            break;
          }
          case 'death': {
            const v = this.enemyViews.get(ev.id);
            this.bones.explode(9, ev.x, ev.y - 30);
            Sfx.play('death');
            if (v) {
              v.dead = true;
              const atlasKey = bestAtlas(ev.type, 'death');
              if (atlasKey && atlasKey.endsWith('-death')) {
                this.setAnim(v.sprite, ev.type, 'death', true);
                v.sprite.setDepth(v.sprite.y - 1);
              } else {
                this.tweens.add({ targets: v.sprite, alpha: 0, angle: v.sprite.flipX ? 80 : -80, duration: 500 });
              }
              this.tweens.add({ targets: [v.sprite, v.shadow], alpha: 0, delay: 700, duration: 500 });
            }
            break;
          }
          case 'sweep': {
            // The arc used to finish wider than the hero and nearly opaque,
            // burying him at the exact moment you need to read him. Now it
            // starts tight, SWEEPS through the aim angle, and stays thin.
            const ang = Math.atan2(ev.ay, ev.ax);
            const img = this.add.image(ev.x, ev.y - 46, 'slash')
              .setRotation(ang - 0.55).setBlendMode('ADD').setDepth(8400)
              .setScale(0.52).setTint(0xffd8a4).setAlpha(0.6);
            this.tweens.add({
              targets: img, scale: 0.88, rotation: ang + 0.5, alpha: 0,
              duration: 270, ease: 'Cubic.Out', onComplete: () => img.destroy()
            });
            Sfx.play('swing');
            const pAtlas = bestAtlas('player', 'attack');
            if (pAtlas && pAtlas.endsWith('-attack')) {
              this.setAnim(this.player, 'player', 'attack', true);
              this.playerAttackT = this.animDuration('player', 'attack');
            }
            break;
          }
          case 'hurt': {
            const attacker = this.enemyViews.get(ev.by);
            if (attacker && !attacker.dead) {
              const s2 = this.sim.enemies.find(e => e.id === ev.by);
              const atlasKey = s2 && bestAtlas(s2.type, 'attack');
              if (atlasKey && atlasKey.endsWith('-attack')) {
                this.setAnim(attacker.sprite, s2.type, 'attack', true);
                attacker.attackT = this.animDuration(s2.type, 'attack');
              }
            }
            Sfx.play('hurt');
            this.cameras.main.shake(130, 0.0062);
            this.hud.hurt.setAlpha(0.3);
            this.tweens.add({ targets: this.hud.hurt, alpha: 0, duration: 320 });
            break;
          }
          case 'pickup': this.sparkle.explode(6, ev.x, ev.y - 8); Sfx.play('pickup'); break;
          case 'fire': Sfx.play('blade'); break;
          case 'levelup': this.showLevelUp(ev); Sfx.play('levelup'); break;
          case 'chosen': this.hideLevelUp(); Sfx.play('chosen'); break;
          case 'gameover': this.showGameOver(ev); Sfx.play('gameover'); break;
          case 'milestone': {
            const line = MILESTONES[Math.min(MILESTONES.length - 1, ev.minute - 1)];
            this.showBanner(ev.minute + ':00  —  ' + line);
            Sfx.play('milestone');
            break;
          }
        }
      }
      s.events.length = 0;
    }

    spawnDmg(x, y, dmg, crit) {
      const t = this.dmgPool.find(o => !o.visible);
      if (!t) return;
      // above the flash, gold, bigger for bigger hits; crits get their own
      // colour and a pop so they land as an event, not just a larger number
      t.setText(crit ? dmg + '!' : String(dmg))
        .setColor(crit ? '#fff0b4' : '#ffd75e')
        .setStroke(crit ? '#8a1f10' : '#402808', crit ? 6 : 4)
      // One sweep hits a dozen enemies standing on top of each other, and
      // stacked numbers read as a single nonsense figure ("26" + "26" = 2626).
      // Random jitter is not enough - two draws collide often. Numbers spawned
      // in the same frame are fanned by their index instead, which cannot.
      const seq = this._dmgSeq++;
      const spread = (seq % 5) - 2;
      t.setPosition(x + spread * 30 + (Math.random() * 14 - 7), y - 16 - Math.abs(spread) * 11)
        .setVisible(true).setAlpha(1)
        .setScale(Math.min(1.5, 0.95 + dmg / 70) * (crit ? 1.4 : 1));
      this.tweens.add({
        targets: t, y: t.y - (crit ? 62 : 44), x: t.x + spread * 22,
        alpha: 0, duration: crit ? 760 : 620, ease: 'Cubic.Out',
        onComplete: () => t.setVisible(false)
      });
    }

    // ----------------------------------------------- level-up / gameover --

    // What a boon will actually do to your sheet, derived by applying it to a
    // throwaway copy of the player. Hard-coding the numbers here would mean
    // every balance tweak in sim.js silently lies on this screen.
    previewOf(up, p) {
      const before = { maxHp: p.maxHp, hp: p.hp, stats: Object.assign({}, p.stats) };
      const after = { maxHp: p.maxHp, hp: p.hp, stats: Object.assign({}, p.stats) };
      try { up.apply(after); } catch (e) { return ''; }
      const x = v => '×' + v.toFixed(2);
      if (after.stats.dmg !== before.stats.dmg) return `damage  ${x(before.stats.dmg)}  →  ${x(after.stats.dmg)}`;
      if (after.stats.cd !== before.stats.cd) return `attack rate  ${x(1 / before.stats.cd)}  →  ${x(1 / after.stats.cd)}`;
      if (after.stats.speed !== before.stats.speed) return `move speed  ${x(before.stats.speed)}  →  ${x(after.stats.speed)}`;
      if (after.stats.magnet !== before.stats.magnet) return `lure range  ${x(before.stats.magnet)}  →  ${x(after.stats.magnet)}`;
      if (after.stats.blades !== before.stats.blades) return `glaives  ${before.stats.blades}  →  ${after.stats.blades}`;
      if (after.stats.crit !== before.stats.crit) return `crit chance  ${Math.round(before.stats.crit * 100)}%  →  ${Math.round(after.stats.crit * 100)}%`;
      if (after.maxHp !== before.maxHp) return `max HP  ${before.maxHp}  →  ${after.maxHp}`;
      return '';
    }

    showLevelUp(ev) {
      const ui = n => n.setScrollFactor(0).setDepth(9600);
      // One icon language: flat gold serif sigils for every boon (mixing
      // glossy renders with glyphs reads as two different UIs).
      const sigils = { dmg: '†', cd: '‡', speed: '»', hp: '♥', magnet: '✦', blade: '◆', crit: '✗' };
      const dim = ui(this.add.rectangle(W / 2, H / 2, W, H, 0x050308, 0).setDepth(9550));
      this.tweens.add({ targets: dim, fillAlpha: 0.72, duration: 180 });
      const head = ui(this.add.text(W / 2, 120, `LEVEL ${ev.level}`, { fontFamily: 'Georgia, serif', fontSize: '44px', color: '#c8a44a', stroke: '#000', strokeThickness: 6 }).setOrigin(0.5));
      this.levelUpGroup = [dim, head,
        ui(this.add.text(W / 2, 168, 'choose a boon', { fontFamily: 'Georgia, serif', fontSize: '18px', color: '#8f8674' }).setOrigin(0.5)),
        ui(this.add.text(W / 2, H - 56, '1 2 3  or  ← →  then ENTER', { fontFamily: 'Georgia, serif', fontSize: '15px', color: '#6b6354' }).setOrigin(0.5))
      ];
      // the heading lands rather than appears
      head.setScale(0.8);
      this.tweens.add({ targets: head, scale: 1, duration: 320, ease: 'Back.Out' });

      this.cards = [];
      this.choiceIndex = 0;
      ev.choices.forEach((id, i) => {
        const up = Sim.UPGRADES.find(u => u.id === id);
        const x = W / 2 + (i - 1) * 300, y = H / 2 + 30;
        const card = ui(this.add.rectangle(x, y, 260, 320, 0x1a1208, 0.96).setStrokeStyle(2, 0x6b5a2e));
        card.setInteractive({ useHandCursor: true });
        card.on('pointerover', () => this.setChoiceIndex(i));
        card.on('pointerdown', () => { this.pendingChoice = i; });
        // a warm glow behind the card, revealed only for the selected one
        const glow = ui(this.add.image(x, y, 'light').setBlendMode('ADD').setTint(0xffb860)
          .setDisplaySize(380, 440).setAlpha(0).setDepth(9590));
        const parts = [
          ui(this.add.text(x, y - 86, sigils[id] || '✦', { fontFamily: 'Georgia, serif', fontSize: '64px', color: '#c8a44a', stroke: '#2a1608', strokeThickness: 6 }).setOrigin(0.5)),
          ui(this.add.text(x, y + 14, up.name, { fontFamily: 'Georgia, serif', fontSize: '22px', color: '#e8dcc0', align: 'center', wordWrap: { width: 230 } }).setOrigin(0.5)),
          ui(this.add.text(x, y + 58, up.desc, { fontFamily: 'Georgia, serif', fontSize: '16px', color: '#9a917d', align: 'center', wordWrap: { width: 230 } }).setOrigin(0.5)),
          ui(this.add.text(x, y + 104, this.previewOf(up, this.sim.player), { fontFamily: 'Georgia, serif', fontSize: '14px', color: '#7fae8c', align: 'center', wordWrap: { width: 230 } }).setOrigin(0.5)),
          ui(this.add.text(x, y + 140, `[${i + 1}]`, { fontFamily: 'Georgia, serif', fontSize: '15px', color: '#6b5a2e' }).setOrigin(0.5))
        ];
        const members = [card, glow].concat(parts);
        this.levelUpGroup.push.apply(this.levelUpGroup, members);
        this.cards.push({ card, glow, members: [card].concat(parts) });
        // staggered rise: three cards appearing at once reads as a page load
        members.forEach(o => { o.y += 34; o.setAlpha(o === glow ? 0 : 0); });
        this.tweens.add({ targets: parts.concat([card]), y: '-=34', alpha: 1, duration: 260, delay: 80 + i * 70, ease: 'Cubic.Out' });
        glow.y -= 34;
      });
      this.setChoiceIndex(0);
    }

    // The selected card is the one the keyboard will confirm; mouse hover and
    // arrow keys drive the same cursor so the two never disagree.
    setChoiceIndex(i) {
      if (!this.cards || !this.cards.length) return;
      this.choiceIndex = ((i % this.cards.length) + this.cards.length) % this.cards.length;
      this.cards.forEach((c, k) => {
        const on = k === this.choiceIndex;
        c.card.setStrokeStyle(on ? 3 : 2, on ? 0xd8b45a : 0x6b5a2e);
        this.tweens.killTweensOf(c.glow);
        this.tweens.add({ targets: c.glow, alpha: on ? 0.16 : 0, duration: 140 });
        c.members.forEach(o => o.setScale(on ? 1.04 : 1));
      });
    }

    hideLevelUp() {
      (this.levelUpGroup || []).forEach(o => { this.tweens.killTweensOf(o); o.destroy(); });
      this.levelUpGroup = null;
      this.cards = null;
    }

    showGameOver(ev) {
      const ui = n => n.setScrollFactor(0).setDepth(9700);
      // stamped so a key still held from the last frame of play cannot
      // instantly skip the screen you just earned
      this.overAt = this.time.now;
      const mins = Math.floor(ev.time / 60), secs = Math.floor(ev.time % 60);
      const timeStr = `${mins}:${String(secs).padStart(2, '0')}`;
      // local leaderboard (server-side comes with multiplayer)
      let board = [];
      try {
        board = JSON.parse(localStorage.getItem('diablow_scores') || '[]');
        board.push({ time: ev.time, kills: ev.kills, level: ev.level, when: new Date().toISOString().slice(0, 10), me: true });
        board.sort((a, b) => b.time - a.time);
        board = board.slice(0, 8);
        localStorage.setItem('diablow_scores', JSON.stringify(board.map(({ me, ...r }) => r)));
      } catch (e) { /* private mode */ }

      ui(this.add.rectangle(W / 2, H / 2, W, H, 0x080304, 0.82));
      // framed parchment-dark panel sized to its rows (min 3 so a fresh
      // profile doesn't collapse); missing rows show as dimmed placeholders
      const rows = Math.max(3, board.length);
      const panelTop = 96, panelH = Math.min(H - 150, 240 + rows * 32 + 84);
      ui(this.add.rectangle(W / 2, panelTop + panelH / 2, 680, panelH, 0x160f08, 0.95).setStrokeStyle(2, 0x6b5a2e));
      ui(this.add.text(W / 2, panelTop + 52, 'YOU HAVE FALLEN', { fontFamily: 'Georgia, serif', fontSize: '52px', color: '#c22a36', stroke: '#000', strokeThickness: 8 }).setOrigin(0.5));
      ui(this.add.text(W / 2, panelTop + 112, `survived ${timeStr}   ·   ${ev.kills} slain   ·   level ${ev.level}`, { fontFamily: 'Georgia, serif', fontSize: '21px', color: '#d0c8b0' }).setOrigin(0.5));
      ui(this.add.text(W / 2, panelTop + 162, '—  NIGHTLY RECORDS  —', { fontFamily: 'Georgia, serif', fontSize: '17px', color: '#c8a44a', letterSpacing: 4 }).setOrigin(0.5));
      // aligned columns: rank | time | level | kills | date
      const cols = [-230, -150, -35, 90, 230];
      // a bare grid of numbers needs saying what the numbers are
      const headStyle = { fontFamily: 'Georgia, serif', fontSize: '12px', color: '#5e5748', letterSpacing: 2 };
      [[1, 'SURVIVED'], [2, 'LEVEL'], [3, 'SLAIN'], [4, 'NIGHT']].forEach(([c, label]) => {
        ui(this.add.text(W / 2 + cols[c], panelTop + 190, label, headStyle).setOrigin(c === 4 ? 1 : 0.5, 0.5));
      });
      for (let i = 0; i < rows; i++) {
        const r = board[i];
        const y = panelTop + 216 + i * 32;
        const style = {
          fontFamily: 'Georgia, serif', fontSize: '17px',
          color: r ? (r.me ? '#e8c96a' : '#8f8674') : '#4a4438'
        };
        if (!r) { // dimmed placeholder row
          ui(this.add.text(W / 2 + cols[0], y, `${i + 1}.`, style).setOrigin(0, 0.5));
          ui(this.add.text(W / 2, y, '— unclaimed —', style).setOrigin(0.5, 0.5));
          continue;
        }
        const m = Math.floor(r.time / 60), s2 = Math.floor(r.time % 60);
        ui(this.add.text(W / 2 + cols[0], y, `${i + 1}.`, style).setOrigin(0, 0.5));
        ui(this.add.text(W / 2 + cols[1], y, `${m}:${String(s2).padStart(2, '0')}`, style).setOrigin(0.5, 0.5));
        ui(this.add.text(W / 2 + cols[2], y, String(r.level), style).setOrigin(0.5, 0.5));
        ui(this.add.text(W / 2 + cols[3], y, String(r.kills), style).setOrigin(0.5, 0.5));
        ui(this.add.text(W / 2 + cols[4], y, r.when || '', style).setOrigin(1, 0.5));
      }
      const prompt = ui(this.add.text(W / 2, panelTop + panelH - 42, 'press R — or click — to rise again', { fontFamily: 'Georgia, serif', fontSize: '20px', color: '#cfc6ae' }).setOrigin(0.5));
      this.tweens.add({ targets: prompt, alpha: 0.45, yoyo: true, repeat: -1, duration: 700 });
    }

    // ------------------------------------------------------ update ------

    update(_, dms) {
      const dt = Math.min(dms / 1000, 0.1);
      const s = this.sim;

      if (this.titleGroup && this.started) {
        this.titleGroup.forEach(o => o.destroy());
        this.titleGroup = null;
      }

      if (this.restartRequested) {
        this.restartRequested = false;
        this.scene.restart();
        return;
      }

      // fixed-step sim
      if (this.started && !s.over && !this.paused) {
        this.acc += dt * TIMESCALE;
        const STEP = 1 / 60;
        let n = 0;
        while (this.acc >= STEP && n++ < 8) {
          let input = AUTO ? this.botInput(STEP) : this.keyInput();
          if (this.pendingChoice != null) { input.choice = this.pendingChoice; this.pendingChoice = null; }
          Sim.step(s, STEP, input);
          this.acc -= STEP;
        }
        if (n >= 8) this.acc = 0;
      }
      this._dmgSeq = 0;
      this.handleEvents();
      this.setHudVisible(this.started && !this.titleGroup && !s.over && !s.choosing);

      const p = s.player;

      // player view
      this.player.setPosition(p.x, p.y).setDepth(p.y);
      this.player.setFlipX(p.facingX > 0); // art faces left natively
      if (this.playerAttackT > 0) this.playerAttackT -= dt;
      else this.setAnim(this.player, 'player', p.moving ? 'walk' : 'idle');
      // the hero is the whole show on the title card, so he stands taller there
      const heroZoom = this.titleGroup ? (this.titleHeroScale || 1) : 1;
      if (heroZoom !== 1) this.player.setScale(this.player.baseScale * heroZoom);
      this.playerShadow.setPosition(p.x, p.y + 2).setDepth(p.y - 0.5)
        .setDisplaySize(92 * heroZoom, 34 * heroZoom);
      this.playerGlow.setPosition(p.x, p.y - 2).setDepth(p.y - 0.4)
        .setDisplaySize(120 * heroZoom, 60 * heroZoom);
      // sits just above the hero and sinks the sheet's hard bottom crop into
      // shadow; a small bob keeps it from looking like a decal
      const feetBob = Math.sin(this.time.now / 420) * 1.5;
      const poolZoom = Math.sqrt(heroZoom); // sublinear: a 1.5x hero over a 1.5x pool reads as a crater
      this.playerFeet.setPosition(p.x, p.y - 5 * heroZoom + feetBob).setDepth(p.y + 0.5)
        .setDisplaySize(132 * poolZoom, 76 * poolZoom)
        .setAlpha(p.moving ? 0.8 : 0.86);
      this.playerMist.forEach((m, i) => {
        const ph = this.time.now / (2100 + i * 700) + i * 2.1;
        m.setPosition(p.x + Math.sin(ph) * 22, p.y - 6 + Math.cos(ph * 1.3) * 3)
          .setDepth(p.y + 0.6)
          .setDisplaySize((150 + Math.sin(ph * 0.7) * 26) * poolZoom, 40 * poolZoom)
          .setAlpha(0.07 + Math.sin(ph * 1.7) * 0.025);
      });
      if (p.hurtT > 0) this.player.setTint(0xff6060); else this.player.clearTint();

      // enemies
      // One id set per frame. The old `enemies.some(...)` inside the reap loop
      // was O(n^2): at the 230-enemy cap that is ~53k comparisons every frame,
      // and the gem loop below was worse.
      const liveIds = this._liveIds || (this._liveIds = new Set());
      liveIds.clear();
      for (const e of s.enemies) {
        liveIds.add(e.id);
        const v = this.enemyView(e);
        if (v.dead) continue;
        v.sprite.setPosition(e.x, e.y).setDepth(e.y);
        v.shadow.setPosition(e.x, e.y + 2).setDepth(e.y - 0.5);
        // the art faces left natively, so an enemy standing to our LEFT has to
        // be flipped to look at the player (this was inverted: the whole horde
        // walked in backwards)
        v.sprite.setFlipX(e.x < p.x);
        if (v.attackT > 0) v.attackT -= dt;
        else this.setAnim(v.sprite, e.type, 'walk');
        // torchlight falloff on the sprite itself: distant enemies sink into
        // the night instead of floating flat-lit over dark ground
        if (v.hitT > 0) {
          v.hitT -= dt;
        } else {
          const d = Math.hypot(e.x - p.x, e.y - p.y);
          const shade = Math.max(0.26, Math.min(1, 1 - (d - 190) / 520));
          const c = Math.round(255 * shade);
          v.sprite.setTint((c << 16) | (Math.round(c * 0.97) << 8) | Math.round(c * 0.92));
        }
      }
      for (const [id, v] of this.enemyViews) {
        if (!liveIds.has(id)) {
          v.sprite.destroy(); v.shadow.destroy();
          this.enemyViews.delete(id);
        }
      }

      // gems
      liveIds.clear();
      for (const g of s.gems) {
        liveIds.add(g.id);
        let v = this.gemViews.get(g.id);
        if (!v) {
          const glow = this.add.image(g.x, g.y, 'glowdot').setBlendMode('ADD').setTint(0x2bbfa8).setDisplaySize(44, 44).setAlpha(0.45);
          const img = loaded.img.has('gem')
            ? this.add.image(g.x, g.y, 'gem')
            : this.add.image(g.x, g.y, 'glowdot').setTint(0x64ffe0).setDisplaySize(16, 16);
          if (loaded.img.has('gem')) img.setScale(26 / img.height);
          v = { img, glow, seed: Math.random() * 6 };
          this.gemViews.set(g.id, v);
        }
        const bob = Math.sin(this.time.now / 300 + v.seed) * 4;
        v.img.setPosition(g.x, g.y - 10 + bob).setDepth(g.y);
        // glow rides above the darkness so gems gleam in the night
        v.glow.setPosition(g.x, g.y - 8 + bob).setDepth(8300)
          .setAlpha(0.34 + Math.sin(this.time.now / 200 + v.seed) * 0.1);
      }
      for (const [id, v] of this.gemViews) {
        if (!liveIds.has(id)) { v.img.destroy(); v.glow.destroy(); this.gemViews.delete(id); }
      }

      // glaives
      liveIds.clear();
      for (const b of s.blades) {
        liveIds.add(b.id);
        let v = this.bladeViews.get(b.id);
        if (!v) {
          v = loaded.img.has('blade')
            ? this.add.image(b.x, b.y, 'blade')
            : this.add.image(b.x, b.y, 'glowdot').setTint(0xcccccc).setDisplaySize(20, 20);
          if (loaded.img.has('blade')) v.setScale(40 / v.height);
          this.bladeViews.set(b.id, v);
        }
        v.setPosition(b.x, b.y - 34).setDepth(b.y + 100).setRotation(this.time.now / 60);
      }
      for (const [id, v] of this.bladeViews) {
        if (!liveIds.has(id)) { v.destroy(); this.bladeViews.delete(id); }
      }

      // camera + ground + decor
      this.camTarget.x = p.x;
      // on the title card the camera rides high so the hero stands in the gap
      // between the subtitle and the controls, overlapping neither
      this.camTarget.y = p.y - (this.titleGroup ? 150 : 30);
      const cam = this.cameras.main;
      if (this.ground) {
        this.ground.setTilePosition(cam.scrollX / TILE_SCALE, cam.scrollY / TILE_SCALE);
      }
      this.ensureChunks();

      // darkness with flickering torchlight
      const flicker = 0.46 + Math.sin(this.time.now / 90) * 0.012 + Math.sin(this.time.now / 37) * 0.008;
      this.darkness.clear();
      this.darkness.fill(0x06030a, flicker);
      // wobble sells an in-world flame; a fixed circle reads screen-space
      const wob = { x: Math.sin(this.time.now / 143) * 8 + Math.sin(this.time.now / 61) * 3, y: Math.cos(this.time.now / 177) * 7 };
      const px = p.x - cam.scrollX + wob.x, py = p.y - cam.scrollY - 40 + wob.y;
      this.darkness.erase('light', px - 390, py - 390);
      this.torchGlow.setPosition(p.x + wob.x, p.y - 40 + wob.y)
        .setAlpha(0.11 + Math.sin(this.time.now / 83) * 0.02);
      let gemLights = 0;
      for (const g of s.gems) {
        const gx = g.x - cam.scrollX, gy = g.y - cam.scrollY;
        if (gx > -60 && gx < W + 60 && gy > -60 && gy < H + 60 && gemLights++ < 50) {
          this.darkness.erase('glowdot', gx - 32, gy - 40);
        }
      }

      // HUD
      // the XP bar chases its target instead of snapping: a bar that jumps is
      // read as a glitch, a bar that fills is read as progress
      const xpTarget = Math.min(1, p.xp / p.xpNext);
      this.xpShown += (xpTarget - this.xpShown) * Math.min(1, dt * 9);
      if (xpTarget < this.xpShown - 0.25) this.xpShown = xpTarget; // level rollover
      this.hud.xp.width = Math.max(2, (W - 26) * this.xpShown);
      this.hud.level.setText('LV ' + p.level);

      const hpFrac = Math.max(0, p.hp / p.maxHp);
      this.hud.hp.width = 256 * hpFrac;
      // the bar itself goes from blood red to a hot warning red near death
      this.hud.hp.setFillStyle(hpFrac < 0.3 ? 0xe8503a : 0xb3202a);
      this.hud.hpText.setText(`${Math.ceil(p.hp)} / ${p.maxHp}`);

      // low-health state: a slow red breath at the edges plus a heartbeat, so
      // you feel the danger without having to watch the corner of the screen
      const dying = this.started && !s.over && !this.paused && hpFrac > 0 && hpFrac < 0.3;
      if (dying) {
        const urgency = 1 - hpFrac / 0.3;
        this.hud.danger.setAlpha((0.1 + urgency * 0.16) * (0.55 + 0.45 * Math.sin(this.time.now / (260 - urgency * 110))));
        this.heartT = (this.heartT || 0) - dt;
        if (this.heartT <= 0) { Sfx.play('heartbeat'); this.heartT = 1.5 - urgency * 0.6; }
      } else {
        this.hud.danger.setAlpha(0);
        this.heartT = 0;
      }

      const mins = Math.floor(s.time / 60), secs = Math.floor(s.time % 60);
      this.hud.timer.setText(`${mins}:${String(secs).padStart(2, '0')}`);
      this.hud.kills.setText('☠ ' + p.kills);
      this.hud.mute.setText(Sfx.muted ? '♪ muted  [M]' : '');
    }
  }

  // ---------------------------------------------------------------- boot --

  window.addEventListener('load', () => {
    new Phaser.Game({
      type: Phaser.AUTO,
      width: W, height: H,
      parent: 'game',
      backgroundColor: '#0a0709',
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      render: { antialias: true, pixelArt: false },
      scene: [Boot, Game]
    });
  });
})();
