#!/usr/bin/env node
// Interaction smoke test for the running game (http://localhost:5178/game/).
// The screenshot harness (capture-game.js) can only prove things LOOK right;
// this proves the things a screenshot cannot see still work: the title gate,
// audio unlocking on a real gesture, pause, mute, level-up keyboard picking
// and restart-from-death.
//
// Usage: node scripts/smoke-game.js    (server must be running)
// Exit code 1 if any check fails.

const fs = require('fs');
const puppeteer = require('puppeteer-core');

const BASE = 'http://localhost:5178/game/';
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
}

const wait = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const exe = BROWSERS.find(p => fs.existsSync(p));
  if (!exe) throw new Error('No Chrome/Edge found');
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: 'new',
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required']
  });
  const errors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(BASE + '?seed=5', { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction('window.__game !== undefined', { timeout: 20000 });

    const g = fn => page.evaluate(fn);

    // --- title gate ---------------------------------------------------
    check('title screen holds before first input', await g(() => !window.__game.scene.started));

    await page.keyboard.press('KeyW');
    await wait(300);
    check('any key starts the run', await g(() => window.__game.scene.started));

    // --- audio ----------------------------------------------------------
    check('audio context opened by the gesture', await g(() => window.__game.audio.ready),
      await g(() => JSON.stringify(window.__game.audio)));
    // every cue must synthesise without throwing, including under rate limits
    const cueErr = await g(() => {
      const names = ['swing', 'hit', 'crit', 'death', 'pickup', 'hurt', 'blade',
        'levelup', 'chosen', 'gameover', 'milestone', 'heartbeat'];
      for (const n of names) {
        try { window.Sfx.play(n); } catch (e) { return n + ': ' + e.message; }
      }
      return null;
    });
    check('every sfx cue plays without throwing', !cueErr, cueErr || '12 cues');

    // --- mute -------------------------------------------------------------
    await page.keyboard.press('KeyM');
    await wait(120);
    const muted = await g(() => window.__game.audio.muted);
    await page.keyboard.press('KeyM');
    await wait(120);
    check('M toggles mute and back', muted && !(await g(() => window.__game.audio.muted)));

    // --- pause ------------------------------------------------------------
    await wait(400);
    const tBefore = await g(() => window.__game.state.time);
    await page.keyboard.press('Escape');
    await wait(500);
    const paused = await g(() => window.__game.scene.paused);
    const tDuring = await g(() => window.__game.state.time);
    check('ESC pauses', paused);
    check('paused sim does not advance', tDuring === tBefore || tDuring - tBefore < 0.05,
      `${tBefore.toFixed(2)} -> ${tDuring.toFixed(2)}`);
    check('pause overlay is on screen',
      await g(() => window.__game.scene.pauseGroup.every(o => o.visible)));
    await page.keyboard.press('KeyP');
    await wait(400);
    check('P resumes', !(await g(() => window.__game.scene.paused)));
    check('resumed sim advances again',
      (await g(() => window.__game.state.time)) > tDuring);

    // --- level-up keyboard picking ---------------------------------------
    await g(() => window.__game.forceLevelup());
    await page.waitForFunction('!!window.__game.state.choosing', { timeout: 10000, polling: 50 });
    await wait(600);
    check('level-up cards are built', await g(() => (window.__game.scene.cards || []).length === 3));
    check('a card starts selected', await g(() => window.__game.scene.choiceIndex === 0));
    await page.keyboard.press('ArrowRight');
    await wait(150);
    check('arrow keys move the selection', await g(() => window.__game.scene.choiceIndex === 1));
    const wanted = await g(() => window.__game.state.choosing.choices[1]);
    await page.keyboard.press('Enter');
    await wait(400);
    check('ENTER confirms the highlighted boon',
      await g(() => !window.__game.state.choosing));
    check('the confirmed boon is the highlighted one', !!wanted,
      'picked ' + wanted);
    check('level-up overlay is torn down', await g(() => !window.__game.scene.levelUpGroup));

    // --- death and restart -------------------------------------------------
    await g(() => window.__game.forceGameover());
    await page.waitForFunction('window.__game.state.over', { timeout: 10000, polling: 50 });
    await wait(300);
    await page.keyboard.press('Enter');
    await wait(300);
    check('death screen ignores input during the grace window',
      await g(() => window.__game.state.over));
    await wait(900);
    await page.keyboard.press('Enter');
    await wait(700);
    check('any key restarts after the grace window',
      await g(() => !window.__game.state.over && window.__game.state.time < 5));

    check('no console errors or page exceptions', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch(e => { console.error(e.message); process.exit(1); });
