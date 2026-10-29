// DIABLOW audio: every sound is synthesised in WebAudio at call time, so the
// game ships zero audio assets and the whole kit stays a single file.
//
// Rules this module lives by:
//   - the AudioContext is created on the first user gesture (autoplay policy)
//     and never before, so a muted/headless QA run makes no noise at all
//   - a horde means hundreds of hits a second: every cue is rate-limited and
//     the master gain is voice-capped, or the swarm turns into white noise
//   - nothing here reads game state; main.js calls Audio.play(name) from the
//     same sim events that drive the particles

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sfx = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_KEY = 'diablow_muted';

  let ctx = null;
  let master = null;      // everything routes through here (also the mute gain)
  let ambienceOn = false;
  let muted = false;
  try { muted = localStorage.getItem(STORAGE_KEY) === '1'; } catch (e) { /* private mode */ }

  // Per-cue rate limits (seconds). A 200-enemy sweep fires ~30 'hit' events in
  // one frame; without this they phase-cancel into a click.
  const THROTTLE = {
    hit: 0.045, crit: 0.09, death: 0.07, pickup: 0.05,
    swing: 0.08, hurt: 0.18, blade: 0.1
  };
  const lastAt = {};

  // ---------------------------------------------------------------- core --

  function now() { return ctx ? ctx.currentTime : 0; }

  // One shared noise buffer: generating noise per shot allocates hard when the
  // horde is big, and a 2s loop is far longer than any cue here.
  let noiseBuf = null;
  function noise() {
    if (!noiseBuf) {
      const n = ctx.sampleRate * 2;
      noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    return src;
  }

  function env(gain, t0, peak, attack, decay) {
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  // A tone: oscillator → optional pitch sweep → gain envelope → master.
  function tone(type, f0, f1, t0, dur, peak, dest) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    env(g, t0, peak, Math.min(0.012, dur * 0.2), dur);
    o.connect(g).connect(dest || master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
    return o;
  }

  // A noise burst through a filter, optionally swept: the backbone of every
  // impact, swing and bone rattle in the game.
  function burst(t0, dur, peak, filterType, f0, f1, q) {
    const src = noise();
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    f.type = filterType;
    f.Q.value = q || 1;
    f.frequency.setValueAtTime(f0, t0);
    if (f1 && f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    env(g, t0, peak, 0.004, dur);
    src.connect(f).connect(g).connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  // ------------------------------------------------------------- cues ----

  const CUES = {
    // steel through air — bright noise sweeping down, no tonal body
    swing(t) {
      burst(t, 0.16, 0.16, 'bandpass', 5200, 1300, 1.4);
      tone('triangle', 900, 380, t, 0.1, 0.03);
    },
    // blade bites: a dull body thud under a short bright transient
    hit(t) {
      burst(t, 0.07, 0.2, 'bandpass', 2400, 900, 1.1);
      tone('sine', 190, 70, t, 0.1, 0.16);
    },
    // crit adds a metallic ring on top so big numbers are audible, not just visible
    crit(t) {
      CUES.hit(t);
      tone('square', 1480, 1180, t + 0.01, 0.2, 0.05);
      tone('square', 2230, 1790, t + 0.01, 0.17, 0.03);
    },
    // a body comes apart: downward noise sweep plus three bone clicks
    death(t) {
      burst(t, 0.26, 0.14, 'lowpass', 1800, 220, 0.9);
      for (let i = 0; i < 3; i++) burst(t + 0.03 + i * 0.045, 0.035, 0.09, 'bandpass', 2600 + i * 700, 0, 6);
    },
    // soul gem — a clean rising blip, the only pure-tonal cue in combat
    pickup(t) {
      tone('sine', 1040, 1560, t, 0.1, 0.075);
      tone('sine', 1560, 2080, t + 0.035, 0.09, 0.035);
    },
    // taking damage: a gut-punch with a touch of grit
    hurt(t) {
      tone('sine', 150, 48, t, 0.26, 0.3);
      burst(t, 0.12, 0.17, 'lowpass', 900, 160, 0.8);
    },
    // glaive leaves the hand — airy, short, pitched above the sword
    blade(t) {
      burst(t, 0.13, 0.1, 'bandpass', 3400, 2000, 3);
    },
    // boon offered: a rising minor-third arpeggio on a soft saw
    levelup(t) {
      const notes = [392, 523.25, 659.25, 783.99];
      notes.forEach((f, i) => {
        const g = ctx.createGain();
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 2600;
        g.connect(master);
        lp.connect(g);
        tone('sawtooth', f, f, t + i * 0.075, 0.42 - i * 0.05, 0.085, lp);
      });
      tone('sine', 196, 196, t, 0.7, 0.07);
    },
    // boon taken: a short confirming swell
    chosen(t) {
      tone('triangle', 523.25, 784, t, 0.18, 0.1);
    },
    // death screen: a slow descending drone, the only cue allowed to be long
    gameover(t) {
      tone('sawtooth', 174.61, 87.3, t, 1.8, 0.09);
      tone('sine', 116.54, 58.27, t, 2.2, 0.1);
      burst(t, 1.6, 0.05, 'lowpass', 600, 120, 0.7);
    },
    // a minute survived
    milestone(t) {
      tone('sine', 261.63, 261.63, t, 0.5, 0.07);
      tone('sine', 392, 392, t + 0.12, 0.6, 0.055);
    },
    // heartbeat while near death — two thumps, called on a timer by main.js
    heartbeat(t) {
      tone('sine', 62, 38, t, 0.16, 0.26);
      tone('sine', 58, 34, t + 0.22, 0.13, 0.17);
    }
  };

  // Low wind + a detuned drone, started once play begins. Quiet enough to sit
  // under everything; it is the difference between "muted video" and "night".
  function startAmbience() {
    if (ambienceOn || !ctx) return;
    ambienceOn = true;
    const t = now();

    const windSrc = noise();
    const windF = ctx.createBiquadFilter();
    windF.type = 'lowpass';
    windF.frequency.value = 380;
    const windG = ctx.createGain();
    windG.gain.value = 0.0001;
    windG.gain.linearRampToValueAtTime(0.035, t + 4);
    windSrc.connect(windF).connect(windG).connect(master);
    windSrc.start(t);

    // slow swell on the wind so it breathes instead of hissing
    const lfo = ctx.createOscillator();
    const lfoG = ctx.createGain();
    lfo.frequency.value = 0.07;
    lfoG.gain.value = 0.018;
    lfo.connect(lfoG).connect(windG.gain);
    lfo.start(t);

    for (const [f, detune] of [[55, 0], [55, 7], [82.41, -5]]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      o.detune.value = detune;
      g.gain.value = 0.0001;
      g.gain.linearRampToValueAtTime(0.028, t + 6);
      o.connect(g).connect(master);
      o.start(t);
    }
  }

  // ------------------------------------------------------------- api -----

  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.55;
      // a gentle ceiling: 200 skeletons dying at once must not clip
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 24;
      comp.ratio.value = 10;
      comp.attack.value = 0.004;
      comp.release.value = 0.2;
      master.connect(comp).connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  function play(name, gain) {
    if (!ctx || muted || ctx.state !== 'running') return;
    const cue = CUES[name];
    if (!cue) return;
    const t = now();
    const limit = THROTTLE[name];
    if (limit) {
      if (t - (lastAt[name] || -1) < limit) return;
      lastAt[name] = t;
    }
    // per-call trim rides on top of the cue's own levels
    if (gain != null && gain !== 1) {
      const prev = master.gain.value;
      master.gain.setValueAtTime(prev * gain, t);
      master.gain.setValueAtTime(prev, t + 0.3);
    }
    try { cue(t + 0.001); } catch (e) { /* context died mid-cue */ }
  }

  function setMuted(on) {
    muted = !!on;
    try { localStorage.setItem(STORAGE_KEY, muted ? '1' : '0'); } catch (e) { /* private mode */ }
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.55, now(), 0.05);
    return muted;
  }

  return {
    unlock, play, startAmbience, setMuted,
    toggleMute: () => setMuted(!muted),
    get muted() { return muted; },
    get ready() { return !!ctx && ctx.state === 'running'; }
  };
});
