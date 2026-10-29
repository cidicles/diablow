# DIABLOW visual QA brief

You are one of five reviewers scoring the visual quality of DIABLOW, a
dark-fantasy Vampire-Survivors-style game whose art is 100% AI-generated
(Midjourney stills → video → alpha-matted sprite sheets; seamless Midjourney
ground tiles). The bar is a AAA-adjacent indie: think Diablo II mood — torchlit
darkness, readable silhouettes, cohesive hand-painted look.

## What you get

A folder of screenshots (1280×720) captured from the live build:

- `01-title.png` — title screen
- `02-early.png` — first seconds, few enemies
- `03-mid.png` — ~2.5 minutes in, large horde
- `04-levelup.png` — level-up boon choice overlay
- `05-swarm.png` — extreme horde stress moment
- `06-gameover.png` — death screen with leaderboard
- `console.txt` — browser errors (missing art shows up here)

You may also re-capture yourself (server must be running):
`node scripts/capture-game.js <outDir> <seed>` from `C:\sites\diablow`.

## Your assigned focus

Score YOUR focus area 1–10 (10 = ship it). **7 is the pass bar.** Be strict
but fair; judge what a player would actually see. One number, then evidence.

1. **Characters & animation** — hero and enemy sprite quality, alpha edges
   (no green fringes, no boxy halos), believable proportions, no floating
   (feet anchored to their shadows), death/attack states reading clearly.
2. **Combat readability & feedback** — can you tell what's happening in the
   horde shots? Hit flashes, damage numbers, slash arcs, blood; does the
   player stand out from enemies; is the swarm shot legible or mush?
3. **Environment & atmosphere** — ground tiling (visible seams or obvious
   repetition = fail), prop scatter believability, torchlight/darkness mood,
   vignette; does it feel like a cursed night, or a black void?
4. **UI & screens** — title, HUD (bars, timer, kill counter), level-up cards,
   game-over/leaderboard: hierarchy, alignment, font choices, polish.
5. **Cohesion & direction** — does everything look like ONE game? Style
   match between characters, props, ground, UI; palette discipline; overall
   impressiveness as a screenshot you'd put on a store page.

## Report format (strict)

```
SCORE: N/10
VERDICT: PASS | FAIL
TOP ISSUES:
1. <specific, actionable, with which screenshot>
2. ...
WHAT WORKS: <one or two lines>
```
