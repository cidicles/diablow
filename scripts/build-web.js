#!/usr/bin/env node
// Assembles the static, deployable game into web-build/: the game files, the
// Phaser runtime, and ONLY the shipped art (sheet .png/.json per animation,
// tiles, props) — never _work/ intermediates, sprite.json defs, state files
// or anything from Sprite Studio.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'web-build');

// characters/animations the game actually loads (mirrors CHARS in game/main.js)
const SHEETS = {
  warrior: ['idle', 'walk', 'attack'],
  skeleton: ['idle', 'walk', 'attack', 'death'],
  ghoul: ['walk', 'death']
};
const TILES = ['ground_grave', 'ground_blight'];
const PROPS = ['gravestone', 'deadtree', 'boneheap', 'gem', 'blade'];

function copy(src, dest) {
  if (!fs.existsSync(src)) throw new Error(`missing: ${path.relative(ROOT, src)} — generate the art first`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

fs.rmSync(OUT, { recursive: true, force: true });

for (const f of ['index.html', 'sim.js', 'audio.js', 'main.js']) {
  copy(path.join(ROOT, 'game', f), path.join(OUT, f));
}
copy(path.join(ROOT, 'node_modules', 'phaser', 'dist', 'phaser.min.js'), path.join(OUT, 'vendor', 'phaser.js'));

for (const [char, anims] of Object.entries(SHEETS)) {
  for (const anim of anims) {
    for (const ext of ['png', 'json']) {
      copy(path.join(ROOT, 'assets', 'sprites', char, `${anim}.${ext}`), path.join(OUT, 'sprites', char, `${anim}.${ext}`));
    }
  }
}
for (const t of TILES) copy(path.join(ROOT, 'assets', 'tiles', `${t}.png`), path.join(OUT, 'tiles', `${t}.png`));
for (const p of PROPS) copy(path.join(ROOT, 'assets', 'props', `${p}.png`), path.join(OUT, 'props', `${p}.png`));

let bytes = 0, count = 0;
(function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) walk(full);
    else { bytes += fs.statSync(full).size; count++; }
  }
})(OUT);
console.log(`web-build/: ${count} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
