// Sprite subjects for scripts/generate-sprites.js.
//
// Each character gets ONE keyframe — a Midjourney still with its background
// removed — that every one of its animations starts on (and, for cycles,
// ends on). Sharing the keyframe keeps the design identical across
// animations and gives every sheet the same rest pose to blend between.
//
// Animation fields:
//   motion    what happens in the clip; the video prompt appends the static
//             camera / flat key-colour background instructions itself
//   frames    frame budget for the sheet
//   fps       playback rate; if the clip's motion needs more frames than the
//             budget at this rate it is time-compressed (models render idles slowly)
//   cycle     true: the start image is also sent as the last frame and the
//             loop point is found automatically (idles, walks, attacks that
//             recover to the rest pose). false: one-shot (deaths).
//   minCycle  shortest plausible cycle in seconds, for loop detection
//   scale     keyframe height as a fraction of the video frame; leave room
//             for wide motions (weapon swings) so nothing leaves the frame

// The keyframe is prompted on a plain background that Bria removes; the key
// colour is composited in afterwards, so it's perfectly flat for the video.
const SPRITE_STYLE = 'dark gothic fantasy action RPG, Diablo II style hand-painted 2D game sprite, three-quarter isometric view from slightly above, facing the lower left, full body from head to toe, single character centered in frame, plain flat light grey studio background, crisp readable silhouette, even lighting, no ground shadow, no text, no watermark --no floor, ground shadow, scenery, text, cropped, photorealistic, photo, 3d render';

const SPRITES = [
  {
    id: 'skeleton', name: 'Skeleton Warrior',
    // grade the comic-bright source toward the scene's muted torchlit
    // palette (QA: saturated rust shield + cyan eyes shouted over the hero)
    adjust: { brightness: 0.92, saturation: 0.68 },
    prompt: 'an undead skeleton warrior holding a rusted notched sword and a cracked round wooden shield, tattered dark cloth scraps hanging from its bones, faint cold blue glow in its eye sockets, ' + SPRITE_STYLE,
    animations: [
      { name: 'idle', motion: 'The skeleton sways slightly and shifts its weight in a menacing ready stance, jaw chattering faintly, sword and shield held ready, feet planted in place.', frames: 16, fps: 8, cycle: true, minCycle: 1.0, scale: 0.6 },
      { name: 'walk', motion: 'The skeleton walks in place as if on a treadmill, a full natural stride with alternating legs and swinging arms; it does not travel across the frame.', frames: 12, fps: 12, cycle: true, minCycle: 0.5, maxCycle: 2.0, scale: 0.6 },
      { name: 'attack', motion: 'The skeleton raises its sword and slashes down hard in one fast overhead strike, then recovers back to its ready stance.', frames: 12, fps: 15, cycle: false, scale: 0.5 },
      { name: 'death', motion: 'The skeleton shudders, its bones come apart and it collapses into a heap of dry bones on the spot, sword and shield clattering down beside it. The bones stay crisp and solid the whole time: no smoke, no dust, no mist, no gas, no dissolving.', frames: 16, fps: 12, cycle: false, scale: 0.55, trimStart: 0.9 }
    ]
  },
  {
    id: 'warrior', name: 'Warrior (player)',
    prompt: 'a battle-scarred human warrior hero in dented steel plate armor and a dark red tabard, gripping a heavy broadsword in both hands, ' + SPRITE_STYLE,
    animations: [
      { name: 'idle', motion: 'The warrior breathes slowly and shifts their weight in a battle-ready stance, broadsword held low, feet planted in place.', frames: 16, fps: 8, cycle: true, minCycle: 1.0, scale: 0.6 },
      // a natural forward walk (travel cancelled by center mode) — models
      // refuse treadmill walks from this keyframe but stride naturally fine
      { name: 'walk', motion: 'The warrior walks with a steady, rhythmic, natural stride toward the lower-left corner of the frame, full alternating steps clearly lifting their feet, arms swinging, keeping the same three-quarter view of their body the whole time; the camera never moves or zooms and the character stays the same size.', frames: 12, fps: 12, cycle: true, minCycle: 0.5, maxCycle: 2.0, scale: 0.5, center: true },
      { name: 'attack', motion: 'The warrior rears back, raises the broadsword high overhead with both hands, and swings it down and across in one huge, fast, exaggerated cleaving strike — full windup, big follow-through with the blade sweeping wide — then returns to their battle-ready stance. The whole character and the whole sword stay fully inside the frame at all times, never cropped by the edges.', frames: 12, fps: 15, cycle: false, scale: 0.45, pin: false }
    ]
  }
];

// Animations for ad-hoc characters made with --id=<name> --image=<file>.
const DEFAULT_ANIMATIONS = [
  { name: 'idle', motion: 'The character breathes slowly and shifts their weight in a relaxed idle stance, feet planted in place.', frames: 16, fps: 8, cycle: true, minCycle: 1.0, scale: 0.62 },
  { name: 'attack', motion: 'The character performs one quick, energetic attack with whatever they are holding, then returns to their starting stance.', frames: 12, fps: 15, cycle: true, minCycle: 0.8, scale: 0.55 }
];

// Starting points offered by the web UI's "new sprite" form.
const PRESET_ANIMATIONS = [
  { name: 'idle', motion: 'The character breathes and shifts their weight in a ready stance, feet planted in place.', frames: 16, fps: 8, cycle: true, minCycle: 1.0, scale: 0.6 },
  { name: 'walk', motion: 'The character walks in place as if on a treadmill, a full natural stride with alternating legs and swinging arms; they do not travel across the frame.', frames: 12, fps: 12, cycle: true, minCycle: 0.6, scale: 0.6 },
  { name: 'attack', motion: 'The character performs one fast, powerful attack with their weapon, then recovers back to their ready stance.', frames: 12, fps: 15, cycle: true, minCycle: 0.8, scale: 0.5 },
  { name: 'cast', motion: 'The character raises a hand and casts a spell in a burst of magical energy, then returns to their ready stance.', frames: 12, fps: 15, cycle: true, minCycle: 0.8, scale: 0.55 },
  { name: 'hit', motion: 'The character flinches backward from a heavy blow, then recovers to their ready stance.', frames: 8, fps: 15, cycle: true, minCycle: 0.5, scale: 0.6 },
  { name: 'death', motion: 'The character collapses to the ground on the spot and lies still.', frames: 16, fps: 12, cycle: false, scale: 0.55 }
];

module.exports = { SPRITES, DEFAULT_ANIMATIONS, PRESET_ANIMATIONS, SPRITE_STYLE };
