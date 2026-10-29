// DIABLOW survivors simulation. Pure logic, no rendering, no Phaser, no DOM:
// the same file runs in the browser (window.Sim) and in Node (module.exports),
// which is the multiplayer plan — an authoritative Node server will run this
// exact module and clients will render it. Keep it that way:
//   - no Date.now()/performance.now(): time only advances via step(dt)
//   - all randomness through the seeded rng in the state
//   - renderer talks in via inputs, and listens via the state.events queue
//     (drained by whoever consumes them)
// Determinism: same seed + same (dt, input) sequence → same run, which also
// makes leaderboard runs replayable/verifiable later.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '0.2';

  const BALANCE = {
    player: { hp: 100, speed: 225, radius: 22 },
    melee: { damage: 26, cooldown: 1.0, range: 165, arcDot: -0.25, knockback: 210, swingRange: 210 },
    blades: { damage: 16, cooldown: 1.7, speed: 540, pierce: 3, ttl: 1.4, radius: 18 },
    gems: { magnet: 70, flySpeed: 460, pickupRadius: 26, cap: 350 },
    xpBase: 5, xpGrowth: 1.4,
    spawn: { base: 2.3, halfLife: 95, min: 0.38, batchEvery: 40, batchCap: 6, ringMin: 720, ringVar: 420, cap: 230 },
    hpRamp: 150, // enemy hp doubles every this many seconds
    touch: { cooldown: 0.7 },
    crit: { chance: 0.15, mult: 2.2 }
  };

  const ENEMY_TYPES = {
    skeleton: { hp: 35, speed: 66, dmg: 9, xp: 1, radius: 24, deathTime: 1.4 },
    ghoul: { hp: 16, speed: 118, dmg: 6, xp: 1, radius: 20, deathTime: 1.1 }
  };

  const UPGRADES = [
    { id: 'dmg', name: 'Sharpened Steel', desc: '+25% damage', apply: p => { p.stats.dmg *= 1.25; } },
    { id: 'cd', name: 'Battle Fury', desc: '15% faster attacks', apply: p => { p.stats.cd *= 0.85; } },
    { id: 'speed', name: 'Fleet Foot', desc: '+12% move speed', apply: p => { p.stats.speed *= 1.12; } },
    { id: 'blade', name: 'Whirling Glaive', desc: '+1 orbiting glaive throw', apply: p => { p.stats.blades += 1; } },
    { id: 'hp', name: 'Iron Constitution', desc: '+25 max HP and heal 50', apply: p => { p.maxHp += 25; p.hp = Math.min(p.maxHp, p.hp + 50); } },
    { id: 'magnet', name: 'Soul Lure', desc: '+50% gem magnet range', apply: p => { p.stats.magnet *= 1.5; } },
    { id: 'crit', name: 'Butcher’s Eye', desc: '+12% critical chance', apply: p => { p.stats.crit += 0.12; } }
  ];

  // -- rng ------------------------------------------------------------------

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // -- state ----------------------------------------------------------------

  function create(seed) {
    return {
      version: VERSION,
      seed: seed >>> 0,
      _rand: mulberry32(seed >>> 0),
      time: 0,
      nextId: 1,
      player: {
        x: 0, y: 0,
        hp: BALANCE.player.hp, maxHp: BALANCE.player.hp,
        level: 1, xp: 0, xpNext: BALANCE.xpBase,
        kills: 0,
        moving: false, facingX: -1, aimX: -1, aimY: 0,
        attackT: 0.6, bladeT: 1.0, hurtT: 0,
        stats: { dmg: 1, cd: 1, speed: 1, blades: 0, magnet: 1, crit: BALANCE.crit.chance }
      },
      enemies: [],
      gems: [],
      blades: [],
      spawnT: 2.0,
      nextMilestone: 60,
      choosing: null,   // {choices:[upgradeId,...]} while a level-up is pending
      over: false,
      events: []
    };
  }

  function emit(s, e) { s.events.push(e); }

  function xpFor(level) { return Math.round(BALANCE.xpBase * Math.pow(BALANCE.xpGrowth, level - 1)); }

  // -- spatial hash (rebuilt each step; enemies only) ------------------------

  const CELL = 72;
  function hashOf(x, y) { return ((x / CELL) | 0) * 100003 + ((y / CELL) | 0); }

  function buildGrid(enemies) {
    const grid = new Map();
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.dying) continue;
      const k = hashOf(e.x, e.y);
      let cell = grid.get(k);
      if (!cell) grid.set(k, cell = []);
      cell.push(e);
    }
    return grid;
  }

  function nearby(grid, x, y, out) {
    out.length = 0;
    const cx = (x / CELL) | 0, cy = (y / CELL) | 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = grid.get((cx + dx) * 100003 + (cy + dy));
        if (cell) for (let i = 0; i < cell.length; i++) out.push(cell[i]);
      }
    }
    return out;
  }

  // -- spawning --------------------------------------------------------------

  function spawnInterval(t) {
    return Math.max(BALANCE.spawn.min, BALANCE.spawn.base * Math.pow(0.5, t / BALANCE.spawn.halfLife));
  }

  function spawnEnemy(s, type) {
    const def = ENEMY_TYPES[type];
    const a = s._rand() * Math.PI * 2;
    const r = BALANCE.spawn.ringMin + s._rand() * BALANCE.spawn.ringVar;
    const hpScale = 1 + s.time / BALANCE.hpRamp;
    const e = {
      id: s.nextId++, type,
      x: s.player.x + Math.cos(a) * r,
      y: s.player.y + Math.sin(a) * r,
      hp: def.hp * hpScale, maxHp: def.hp * hpScale,
      speed: def.speed * (0.86 + s._rand() * 0.3),
      // identical radii + a shared target make the separation pass settle into
      // a hex lattice; varied radii and a per-enemy weave keep the mass organic
      radius: def.radius * (0.88 + s._rand() * 0.26),
      scale: 0.88 + s._rand() * 0.26,
      wob: s._rand() * Math.PI * 2,
      wobAmp: 0.18 + s._rand() * 0.42,
      kx: 0, ky: 0, touchT: 0, hitT: 0,
      dying: false, deathT: 0
    };
    s.enemies.push(e);
    emit(s, { t: 'spawn', id: e.id, type, x: e.x, y: e.y });
    return e;
  }

  function pickType(s) {
    const ghoulShare = Math.min(0.55, Math.max(0, (s.time - 45) / 240));
    return s._rand() < ghoulShare ? 'ghoul' : 'skeleton';
  }

  function debugSpawn(s, n, type) {
    for (let i = 0; i < n; i++) spawnEnemy(s, type || pickType(s));
  }

  // -- combat ----------------------------------------------------------------

  function damageEnemy(s, e, dmg, kx, ky, kind) {
    // crit is rolled here so every damage source shares one rule (and one
    // rng draw, which keeps replays honest)
    const crit = s._rand() < s.player.stats.crit;
    if (crit) { dmg *= BALANCE.crit.mult; kx *= 1.5; ky *= 1.5; }
    e.hp -= dmg;
    e.hitT = crit ? 0.14 : 0.09;
    e.kx += kx; e.ky += ky;
    emit(s, { t: 'hit', id: e.id, x: e.x, y: e.y, dmg: Math.round(dmg), kind, crit });
    if (e.hp <= 0 && !e.dying) {
      e.dying = true;
      e.deathT = 0;
      s.player.kills++;
      emit(s, { t: 'death', id: e.id, type: e.type, x: e.x, y: e.y });
      if (s.gems.length < BALANCE.gems.cap) {
        s.gems.push({ id: s.nextId++, x: e.x, y: e.y, xp: ENEMY_TYPES[e.type].xp, fly: false });
      }
    }
  }

  function nearestEnemy(s, x, y, maxDist) {
    let best = null, bestD = maxDist * maxDist;
    for (let i = 0; i < s.enemies.length; i++) {
      const e = s.enemies[i];
      if (e.dying) continue;
      const d = (e.x - x) * (e.x - x) + (e.y - y) * (e.y - y);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  function meleeSweep(s) {
    const p = s.player;
    const range = BALANCE.melee.range;
    let hits = 0;
    for (let i = 0; i < s.enemies.length; i++) {
      const e = s.enemies[i];
      if (e.dying) continue;
      const dx = e.x - p.x, dy = e.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > (range + e.radius) * (range + e.radius)) continue;
      const d = Math.sqrt(d2) || 1;
      const dot = (dx / d) * p.aimX + (dy / d) * p.aimY;
      if (dot < BALANCE.melee.arcDot) continue;
      const kb = BALANCE.melee.knockback;
      damageEnemy(s, e, BALANCE.melee.damage * p.stats.dmg, (dx / d) * kb, (dy / d) * kb, 'melee');
      hits++;
    }
    emit(s, { t: 'sweep', x: p.x, y: p.y, ax: p.aimX, ay: p.aimY, hits });
  }

  function fireBlades(s) {
    const p = s.player;
    const n = p.stats.blades;
    // Aim each glaive at a distinct nearby enemy; extras fan out around the aim.
    const targets = s.enemies
      .filter(e => !e.dying)
      .map(e => ({ e, d: (e.x - p.x) ** 2 + (e.y - p.y) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, n);
    for (let i = 0; i < n; i++) {
      let ang;
      if (targets[i]) ang = Math.atan2(targets[i].e.y - p.y, targets[i].e.x - p.x);
      else ang = Math.atan2(p.aimY, p.aimX) + (i - (n - 1) / 2) * 0.5;
      s.blades.push({
        id: s.nextId++, x: p.x, y: p.y,
        vx: Math.cos(ang) * BALANCE.blades.speed, vy: Math.sin(ang) * BALANCE.blades.speed,
        dmg: BALANCE.blades.damage * p.stats.dmg,
        pierce: BALANCE.blades.pierce, ttl: BALANCE.blades.ttl, hitIds: []
      });
    }
    if (n) emit(s, { t: 'fire', x: p.x, y: p.y, count: n });
  }

  // -- level ups -------------------------------------------------------------

  function offerUpgrades(s) {
    const pool = UPGRADES.map(u => u.id);
    const choices = [];
    while (choices.length < 3 && pool.length) {
      choices.push(pool.splice((s._rand() * pool.length) | 0, 1)[0]);
    }
    s.choosing = { choices };
    emit(s, { t: 'levelup', level: s.player.level, choices });
  }

  function applyChoice(s, index) {
    const id = s.choosing.choices[Math.max(0, Math.min(2, index | 0))];
    const up = UPGRADES.find(u => u.id === id);
    up.apply(s.player);
    s.choosing = null;
    emit(s, { t: 'chosen', id });
  }

  // -- main step -------------------------------------------------------------

  const _near = [];

  function step(s, dt, input) {
    if (s.over) return;
    input = input || {};

    if (s.choosing) {
      if (input.choice != null) applyChoice(s, input.choice);
      return; // world frozen during the pick (single-player rule; MP will differ)
    }

    s.time += dt;
    const p = s.player;
    const B = BALANCE;

    // player movement + facing
    let mx = input.mx || 0, my = input.my || 0;
    const ml = Math.hypot(mx, my);
    if (ml > 1e-4) {
      mx /= Math.max(1, ml); my /= Math.max(1, ml);
      p.x += mx * B.player.speed * p.stats.speed * dt;
      p.y += my * B.player.speed * p.stats.speed * dt;
      p.moving = true;
    } else {
      p.moving = false;
    }
    const aimTarget = nearestEnemy(s, p.x, p.y, 420);
    if (aimTarget) {
      const d = Math.hypot(aimTarget.x - p.x, aimTarget.y - p.y) || 1;
      p.aimX = (aimTarget.x - p.x) / d; p.aimY = (aimTarget.y - p.y) / d;
    } else if (p.moving) {
      p.aimX = mx; p.aimY = my;
    }
    if (Math.abs(p.aimX) > 0.15) p.facingX = p.aimX < 0 ? -1 : 1;
    if (p.hurtT > 0) p.hurtT -= dt;

    // spawning
    s.spawnT -= dt;
    while (s.spawnT <= 0 && s.enemies.length < B.spawn.cap) {
      const batch = Math.min(B.spawn.batchCap, 1 + (s.time / B.spawn.batchEvery) | 0);
      for (let i = 0; i < batch; i++) spawnEnemy(s, pickType(s));
      s.spawnT += spawnInterval(s.time);
    }

    // enemies
    const grid = buildGrid(s.enemies);
    for (let i = s.enemies.length - 1; i >= 0; i--) {
      const e = s.enemies[i];
      if (e.dying) {
        e.deathT += dt;
        if (e.deathT > ENEMY_TYPES[e.type].deathTime) s.enemies.splice(i, 1);
        continue;
      }
      if (e.hitT > 0) e.hitT -= dt;
      // seek player
      const dx = p.x - e.x, dy = p.y - e.y;
      const d = Math.hypot(dx, dy) || 1;
      const hx = dx / d, hy = dy / d;
      const w = Math.sin(s.time * 1.7 + e.wob) * e.wobAmp;
      e.x += (hx - hy * w) * e.speed * dt + e.kx * dt;
      e.y += (hy + hx * w) * e.speed * dt + e.ky * dt;
      const decay = Math.exp(-9 * dt);
      e.kx *= decay; e.ky *= decay;
      // separation from neighbours
      const ns = nearby(grid, e.x, e.y, _near);
      for (let j = 0; j < ns.length; j++) {
        const o = ns[j];
        if (o === e) continue;
        const ox = e.x - o.x, oy = e.y - o.y;
        const od = Math.hypot(ox, oy);
        const min = e.radius + o.radius - 6;
        if (od > 1e-4 && od < min) {
          const push = (min - od) * 0.5;
          e.x += (ox / od) * push; e.y += (oy / od) * push;
        }
      }
      // touch damage
      if (e.touchT > 0) e.touchT -= dt;
      if (e.touchT <= 0 && d < e.radius + B.player.radius) {
        p.hp -= ENEMY_TYPES[e.type].dmg;
        p.hurtT = 0.35;
        e.touchT = B.touch.cooldown;
        emit(s, { t: 'hurt', dmg: ENEMY_TYPES[e.type].dmg, hp: p.hp, by: e.id });
      }
    }

    // melee
    p.attackT -= dt;
    if (p.attackT <= 0 && nearestEnemy(s, p.x, p.y, B.melee.swingRange)) {
      meleeSweep(s);
      p.attackT = B.melee.cooldown * p.stats.cd;
    }

    // glaives
    if (p.stats.blades > 0) {
      p.bladeT -= dt;
      if (p.bladeT <= 0 && s.enemies.some(e => !e.dying)) {
        fireBlades(s);
        p.bladeT = B.blades.cooldown * p.stats.cd;
      }
    }
    for (let i = s.blades.length - 1; i >= 0; i--) {
      const b = s.blades[i];
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.ttl -= dt;
      const ns = nearby(grid, b.x, b.y, _near);
      for (let j = 0; j < ns.length && b.pierce > 0; j++) {
        const e = ns[j];
        if (e.dying || b.hitIds.indexOf(e.id) >= 0) continue;
        const r = e.radius + B.blades.radius;
        if ((e.x - b.x) * (e.x - b.x) + (e.y - b.y) * (e.y - b.y) < r * r) {
          b.hitIds.push(e.id);
          b.pierce--;
          const d = Math.hypot(b.vx, b.vy) || 1;
          damageEnemy(s, e, b.dmg, (b.vx / d) * 90, (b.vy / d) * 90, 'blade');
        }
      }
      if (b.ttl <= 0 || b.pierce <= 0) s.blades.splice(i, 1);
    }

    // gems
    const magnetR = B.gems.magnet * p.stats.magnet;
    for (let i = s.gems.length - 1; i >= 0; i--) {
      const g = s.gems[i];
      const dx = p.x - g.x, dy = p.y - g.y;
      const d = Math.hypot(dx, dy) || 1;
      if (g.fly || d < magnetR) {
        g.fly = true;
        const sp = B.gems.flySpeed * (1 + (magnetR / Math.max(d, 20)) * 0.4);
        g.x += (dx / d) * sp * dt;
        g.y += (dy / d) * sp * dt;
      }
      if (d < B.gems.pickupRadius) {
        p.xp += g.xp;
        s.gems.splice(i, 1);
        emit(s, { t: 'pickup', x: g.x, y: g.y });
      }
    }

    // level ups
    if (p.xp >= p.xpNext) {
      p.xp -= p.xpNext;
      p.level++;
      p.xpNext = xpFor(p.level);
      offerUpgrades(s);
    }

    // minute milestones — the renderer turns these into a banner + sting
    if (s.time >= s.nextMilestone) {
      emit(s, { t: 'milestone', minute: Math.round(s.nextMilestone / 60), time: s.time });
      s.nextMilestone += 60;
    }

    // death
    if (p.hp <= 0 && !s.over) {
      p.hp = 0;
      s.over = true;
      emit(s, { t: 'gameover', time: s.time, kills: p.kills, level: p.level });
    }
  }

  return { VERSION, BALANCE, ENEMY_TYPES, UPGRADES, create, step, debugSpawn, xpFor };
});
