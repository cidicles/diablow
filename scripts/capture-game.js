#!/usr/bin/env node
// Captures review screenshots of the running game (http://localhost:5178/game/)
// with puppeteer-core + local Edge/Chrome. Used by the visual-QA agents.
//
// Usage: node scripts/capture-game.js <outDir> [seed]
// Writes: 01-title.png … 06-gameover.png, console.txt (browser errors/warnings)

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE = 'http://localhost:5178/game/';
const outDir = path.resolve(process.argv[2] || 'qa-shots');
const seed = Number(process.argv[3]) || 11;

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];

const SHOTS = [
  { name: '01-title', query: '', settle: 1800 },
  { name: '02-early', query: `?auto=1&seed=${seed}`, until: g => g.state.time > 8, settle: 400 },
  { name: '03-mid', query: `?auto=1&seed=${seed}&t0=150`, until: g => g.state.time > 152.5, settle: 400 },
  { name: '04-levelup', query: `?auto=1&seed=${seed + 1}&t0=40&hold=1`, run: g => g.forceLevelup(), until: g => !!g.state.choosing, settle: 600 },
  { name: '05-swarm', query: `?auto=1&seed=${seed + 2}&t0=330`, run: g => g.spawnBurst(60), until: g => g.state.time > 332, settle: 700 },
  { name: '06-gameover', query: `?auto=1&seed=${seed + 3}&t0=60`, run: g => g.forceGameover(), until: g => g.state.over, settle: 900 },
  // pause a beat into play, not on frame one: the camera is still lerping
  // out of its start position right after a t0 scrub
  { name: '07-pause', query: `?auto=1&seed=${seed}&t0=70`, run: g => setTimeout(() => g.setPaused(true), 1500), until: g => g.scene.paused, settle: 400 }
];

async function main() {
  const exe = BROWSERS.find(p => fs.existsSync(p));
  if (!exe) throw new Error('No Chrome/Edge found');
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: 'new',
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1300,760']
  });
  const logLines = [];
  try {
    for (const shot of SHOTS) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 720 });
      page.on('console', m => { if (m.type() !== 'log') logLines.push(`[${shot.name}][${m.type()}] ${m.text()}`); });
      page.on('pageerror', e => logLines.push(`[${shot.name}][pageerror] ${e.message}`));
      await page.goto(BASE + shot.query, { waitUntil: 'load', timeout: 30000 });
      await page.waitForFunction('window.__game !== undefined', { timeout: 20000 });
      if (shot.run) await page.evaluate(`(${shot.run})(window.__game)`);
      if (shot.until) await page.waitForFunction(`(${shot.until})(window.__game)`, { timeout: 45000, polling: 100 });
      await new Promise(r => setTimeout(r, shot.settle || 300));
      await page.screenshot({ path: path.join(outDir, shot.name + '.png') });
      const info = await page.evaluate(g => ({
        renderer: window.__game.renderer,
        time: Math.round(window.__game.state.time),
        enemies: window.__game.state.enemies.length,
        level: window.__game.state.player.level
      }));
      console.log(`${shot.name}: t=${info.time}s enemies=${info.enemies} lv=${info.level} renderer=${info.renderer}`);
      await page.close();
    }
  } finally {
    fs.writeFileSync(path.join(outDir, 'console.txt'), logLines.join('\n') || '(no browser errors)');
    await browser.close();
  }
  console.log('shots →', outDir);
  if (logLines.some(l => l.includes('pageerror'))) {
    console.error('PAGE ERRORS FOUND — see console.txt');
    process.exitCode = 1;
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
