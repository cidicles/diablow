# DIABLOW — Night of the Risen

Vampire-Survivors-style base game. One class (Warrior), endless waves of
skeletons and ghouls, XP gems, level-up choices, local leaderboard. All art is
AI-generated through the Apiframe pipeline in this repo (`scripts/`):
character sheets come from Sprite Studio's video→alpha pipeline, ground tiles
from Midjourney's seamless `tile` mode, props/pickups from Midjourney + Bria
cutouts. All **audio** is synthesised at runtime (`audio.js`) — the game ships
no sound files.

Run: `npm run studio`, then open http://localhost:5178/game/

## Controls

| | |
|---|---|
| WASD / arrows | move (attacks swing themselves) |
| 1 2 3, or ← → then ENTER | pick a boon on level-up (mouse works too) |
| ESC / P | pause |
| M | mute (remembered in `localStorage`) |
| R, or any key / click | restart from the death screen |

## Architecture — built for multiplayer

The engine is **Phaser 3.90** (rendering/input only). Everything that decides
the outcome of a run lives in **`sim.js`**, a pure module with no Phaser, no
DOM, no wall-clock and no unseeded randomness. It loads unchanged in Node.

That split is the multiplayer plan:

- **Now (single player):** the browser runs `Sim.step(state, dt, input)`
  locally at a fixed 60 Hz; `main.js` mirrors sim state into sprites and
  drains `state.events` for juice (particles, shake, numbers, sound).
- **Later (multiplayer):** an authoritative Node server runs the same
  `sim.js` at 20–30 Hz, clients send input frames and interpolate snapshots.
  `state.events` becomes the delta stream. The one single-player-ism to
  remove is the level-up pause (`state.choosing` freezes the world); in MP
  that becomes a per-player, non-pausing pick.
- **Leaderboards:** runs are deterministic — same seed + same input trace
  replays identically (`Sim.VERSION` guards balance changes). A score submit
  can therefore ship the input trace and be *verified server-side by
  replaying it*, which kills the usual fake-score problem. Until then a
  local top-8 lives in `localStorage`.

Crits are rolled inside `damageEnemy` from the same seeded rng, so they cost
replay verification nothing.

## Audio (`audio.js`)

A single self-contained WebAudio kit: short noise bursts through swept filters
for impacts and swings, pure tones for pickups and level-ups, and a continuous
wind + drone bed. It exposes `Sfx.play(name)` and nothing else of note.

Two rules it will not survive breaking:

- the `AudioContext` is only created on a **real user gesture**, so a headless
  QA run never opens one;
- every cue is **rate-limited** (`THROTTLE` in that file). One sweep can emit
  thirty `hit` events in a single frame, and thirty unthrottled impacts phase
  into a click, not a crunch.

## Input handling

Discrete actions (pause, mute, boon picking, restart) are bound as **key
events**, not polled with `JustDown` in `update()`. Polling drops any press
that begins and ends inside one 16 ms frame — a fast but entirely real tap.
Movement still polls `isDown`, which is correct for a held key.

## Known art limitation

The generated warrior sheet is framed **knee-up**, so the sprite ends on a hard
horizontal cut. Until it is regenerated full-body, `main.js` draws a dark pool
plus two drifting mist wisps over the hero's feet (`playerFeet`, `playerMist`)
to sink that edge into shadow. Enemy sheets are full-body and need none of it.

## Query params (used by the QA harness)

- `?seed=N` — deterministic run seed
- `?auto=1` — autopilot bot plays (also skips the title screen)
- `?t0=SECONDS` — fast-forward the sim before first render. The scrub always
  answers a pending level-up, even under `hold=1`; letting it hold instead
  stalls the fast-forward forever, because the sim stops advancing time while
  `choosing`.
- `?ts=X` — sim timescale multiplier
- `?hold=1` — autopilot never confirms level-ups (live overlay only)
- `window.__game` — state handle + `forceLevelup()` / `forceGameover()` /
  `spawnBurst(n)` / `setPaused(on)` for screenshots, plus `audio` and `scene`.

## QA

- `node scripts/capture-game.js <outDir> [seed]` — seven review screenshots
  (title, early, mid, level-up, swarm, game over, pause) + `console.txt`.
- `node scripts/smoke-game.js` — drives the game with real key events and
  checks what a screenshot cannot: the title gate, audio unlocking on a
  gesture, every sfx cue, pause actually freezing the sim, mute, level-up
  keyboard picking, and restart-from-death. Exits non-zero on failure.

Both need `npm run studio` running.
