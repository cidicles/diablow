// Sprite Studio front end: sprite list, new-sprite form, animation review and
// the job queue. Everything that can spend credits goes through runJob(),
// which asks the pipeline for a --dry-run estimate and confirms first.

const $ = sel => document.querySelector(sel);
const player = new SheetPlayer($('#stage'));
const state = {
  config: null,
  sprites: [],
  selected: null,
  anim: null,
  editing: null,
  jobs: [],
  activeJob: null,
  loadedSheet: null,
  sheetData: null
};

// ---- helpers ---------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.flat().filter(c => c != null && c !== false));
  return node;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

function toast(message, kind = 'error') {
  const node = el('div', { class: `toast ${kind}` }, message);
  Object.assign(node.style, {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: 10, maxWidth: '420px',
    padding: '10px 14px', borderRadius: '8px', whiteSpace: 'pre-wrap',
    background: kind === 'error' ? '#3a1715' : '#16301f', border: '1px solid #4a4751', color: '#ebe7ef'
  });
  document.body.append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 9000 : 4000);
}

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { return null; }
}

const sprite = (id = state.selected) => state.sprites.find(s => s.id === id);
const busyJob = id => state.jobs.find(j => j.sprite === id && (j.status === 'running' || j.status === 'queued'));
const modelFor = s => (s && s.model) || state.config.defaults.model;

function showView(name) {
  for (const v of ['empty', 'new', 'sprite']) $(`#${v}View`).hidden = v !== name;
}

// ---- cost-confirmed jobs ---------------------------------------------------

function confirmCost({ title, plan, credits }) {
  return new Promise(resolve => {
    const dlg = $('#confirmDialog');
    $('#confirmTitle').textContent = title;
    $('#confirmCredits').textContent = `~${credits} credits`;
    $('#confirmPlan').textContent = plan;
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
  });
}

async function runJob(body, title) {
  try {
    const estimate = await api('/api/estimate', { method: 'POST', body });
    if (estimate.credits > 0 && !(await confirmCost({ title, ...estimate }))) return null;
    const job = await api('/api/jobs', { method: 'POST', body: { ...body, label: title } });
    state.activeJob = job.id;
    await pollJobs();
    return job;
  } catch (e) {
    toast(e.message);
    return null;
  }
}

// ---- sprite list -----------------------------------------------------------

async function loadSprites() {
  state.sprites = await api('/api/sprites');
  renderList();
}

function renderList() {
  $('#spriteList').replaceChildren(...state.sprites.map(s => {
    const done = s.animations.filter(a => a.sheet).length;
    const exported = s.animations.filter(a => a.exportedAt && !a.exportStale).length;
    const job = busyJob(s.id);
    const sub = job ? `${job.status === 'queued' ? 'queued' : 'generating'}…`
      : `${done}/${s.animations.length} generated${exported ? ` · ${exported} exported` : ''}`;
    return el('button', { class: `sprite-item${s.id === state.selected ? ' active' : ''}`, onclick: () => selectSprite(s.id) },
      s.keyframe ? el('img', { src: s.keyframe, alt: '' }) : el('span', { class: 'thumb' }),
      el('span', {},
        el('div', { class: 'name' }, s.name),
        el('div', { class: 'sub' }, el('span', { class: `dot ${job ? 'warn' : done ? 'ok' : 'none'}` }), sub)));
  }));
}

function selectSprite(id, anim) {
  const s = sprite(id);
  if (!s) return;
  state.selected = id;
  const keep = state.anim && s.animations.some(a => a.name === state.anim);
  state.anim = anim || (keep ? state.anim : (s.animations.find(a => a.sheet) || s.animations[0] || {}).name);
  history.replaceState(null, '', `#${id}`);
  renderList();
  renderSprite();
  showView('sprite');
}

// ---- sprite view -----------------------------------------------------------

function renderSprite() {
  const s = sprite();
  if (!s) return;
  $('#spriteName').textContent = s.name;
  $('#spritePrompt').textContent = s.subject || (s.image ? `From image: ${s.image}` : s.prompt || '');
  $('#spritePrompt').title = s.prompt || '';
  $('#editSpriteBtn').hidden = s.builtIn || !s.subject;
  $('#keyframeImg').src = s.keyframe || '';
  $('#keyframeImg').closest('.keyframe').hidden = !s.keyframe;

  $('#variantsHint').textContent = s.variants.length > 1
    ? 'Midjourney options. Switching re-cuts the keyframe and needs new videos for every animation.'
    : s.keyframe ? '' : 'No keyframe yet — generating makes one first.';
  $('#variants').replaceChildren(...(s.variants.length > 1 ? s.variants : []).map((src, i) =>
    el('button', {
      class: `variant${s.variant === i + 1 ? ' current' : ''}`,
      title: s.variant === i + 1 ? 'In use' : `Use variant ${i + 1}`,
      onclick: () => s.variant !== i + 1 && runJob({ id: s.id, model: modelFor(s), variant: i + 1 }, `Switch ${s.name} to variant ${i + 1}`)
    }, el('img', { src, alt: `Variant ${i + 1}` }), el('span', {}, `#${i + 1}`))));

  $('#animTabs').replaceChildren(...s.animations.map(a => {
    const pending = a.videoPending || (busyJob(s.id) && busyJob(s.id).anims.includes(a.name));
    const dot = pending ? 'warn' : a.sheet ? 'ok' : 'none';
    return el('button', { class: `tab${a.name === state.anim ? ' active' : ''}`, role: 'tab', onclick: () => { state.anim = a.name; renderSprite(); } },
      el('span', { class: `dot ${dot}` }), a.name, a.exportedAt && !a.exportStale ? ' ✓' : '');
  }));

  renderAnim(s, s.animations.find(a => a.name === state.anim));
}

function renderAnim(s, a) {
  const has = !!(a && a.sheet);
  $('#animEmpty').hidden = has || !a;
  $('#animDetails').hidden = !has;
  if (!has) {
    player.clear();
    state.loadedSheet = null;
    return;
  }
  if (state.loadedSheet !== a.sheet.json) {
    state.loadedSheet = a.sheet.json;
    player.load(a.sheet.json, a.sheet.png).then(data => {
      state.sheetData = data;
      $('#fpsInput').value = player.fps;
      renderMeta(s, a, data);
    }).catch(e => toast(`Could not load sheet: ${e.message}`));
    $('#sheetImg').src = a.sheet.png;
    const video = $('#sourceVideo');
    if (a.video) video.src = a.video; else video.removeAttribute('src');
    const meta = a.sheet.meta || {};
    $('#rbFrames').value = meta.source ? meta.source.frames.length : '';
    $('#rbFps').value = meta.fps || '';
  } else if (state.sheetData) {
    renderMeta(s, a, state.sheetData);
  }
  $('#exportStatus').replaceChildren(
    a.exportStale ? 'Sheet changed since the last export.'
      : a.exportedAt ? `Exported ${ago(a.exportedAt)} → exports/${s.id}/` : 'Not exported yet.');
  $('#exportBtn').textContent = a.exportedAt && !a.exportStale ? 'Export again' : 'Export';
}

function renderMeta(s, a, data) {
  const meta = data.meta || {};
  const first = Object.values(data.frames)[0];
  const src = meta.source || {};
  const rows = [
    ['Frames', `${Object.keys(data.frames).length} @ ${meta.fps} fps`],
    ['Clip', src.seconds ? `${src.seconds}s ${meta.loop ? 'cycle' : 'one-shot'}${src.speed > 1.05 ? `, played ${src.speed}× faster` : ''}` : (meta.loop ? 'cycle' : 'one-shot')],
    ['Cell', first ? `${first.frame.w}×${first.frame.h} px, sheet ${meta.size.w}×${meta.size.h}` : '—'],
    ['Matte', `${meta.key || '?'} key, ${meta.matte || 'chroma'}`],
    ['Model', (meta.request && meta.request.model) || '—'],
    ['Updated', ago(a.sheet.updatedAt)],
    ['Motion', (a.def && a.def.motion) || (meta.request && meta.request.prompt) || '—']
  ];
  $('#animMeta').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
}

// Clicking the sheet jumps the player to the frame under the cursor.
$('#sheetImg').addEventListener('click', e => {
  if (!state.sheetData) return;
  const img = e.currentTarget;
  const x = (e.offsetX / img.clientWidth) * img.naturalWidth;
  const y = (e.offsetY / img.clientHeight) * img.naturalHeight;
  const frames = Object.values(state.sheetData.frames);
  const i = frames.findIndex(f => x >= f.frame.x && x < f.frame.x + f.frame.w && y >= f.frame.y && y < f.frame.y + f.frame.h);
  if (i >= 0) { player.playing = false; player.setFrame(i); syncPlayButton(); }
});

// ---- sprite actions --------------------------------------------------------

$('#generateMissingBtn').addEventListener('click', () => {
  const s = sprite();
  runJob({ id: s.id, model: modelFor(s) }, `Generate ${s.name}`);
});

$('#generateAnimBtn').addEventListener('click', () => {
  const s = sprite();
  runJob({ id: s.id, anims: [state.anim], model: modelFor(s) }, `Generate ${s.name} · ${state.anim}`);
});

$('#regenVideoBtn').addEventListener('click', () => {
  const s = sprite();
  runJob({ id: s.id, anims: [state.anim], model: modelFor(s), regen: ['video'] }, `New video for ${s.name} · ${state.anim}`);
});

$('#rebuildBtn').addEventListener('click', () => {
  const s = sprite();
  runJob({
    id: s.id,
    anims: [state.anim],
    model: modelFor(s),
    frames: $('#rbFrames').value,
    fps: $('#rbFps').value,
    height: $('#rbHeight').value,
    despeckle: $('#rbDespeckle').value
  }, `Rebuild ${s.name} · ${state.anim}`);
});

$('#exportBtn').addEventListener('click', async () => {
  const s = sprite();
  try {
    const res = await api('/api/export', { method: 'POST', body: { id: s.id, anim: state.anim } });
    toast(`Exported to ${res.dir}/`, 'ok');
    await loadSprites();
    renderSprite();
  } catch (e) {
    toast(e.message);
  }
});

$('#editSpriteBtn').addEventListener('click', () => openForm(sprite()));

// ---- player controls -------------------------------------------------------

function syncPlayButton() {
  $('#playBtn').textContent = player.playing ? '❚❚' : '▶';
}

player.onFrame = (i, n) => {
  $('#scrub').max = Math.max(0, n - 1);
  $('#scrub').value = i;
  $('#frameLabel').textContent = n ? `${i + 1} / ${n}` : '';
};

$('#playBtn').addEventListener('click', () => { player.playing = !player.playing; syncPlayButton(); });
$('#prevBtn').addEventListener('click', () => { player.step(-1); syncPlayButton(); });
$('#nextBtn').addEventListener('click', () => { player.step(1); syncPlayButton(); });
$('#scrub').addEventListener('input', e => { player.playing = false; player.setFrame(Number(e.target.value)); syncPlayButton(); });
$('#fpsInput').addEventListener('input', e => { const v = Number(e.target.value); if (v > 0) player.set({ fps: v }); });
for (const [id, key, parse] of [['#zoomSelect', 'zoom', v => v], ['#bgSelect', 'bg', v => v]]) {
  const node = $(id);
  node.value = storage(`studio.${key}`) || node.value;
  player.set({ [key]: parse(node.value) });
  node.addEventListener('change', () => { player.set({ [key]: parse(node.value) }); storage(`studio.${key}`, node.value); });
}
$('#pivotToggle').addEventListener('change', e => player.set({ showPivot: e.target.checked }));

document.addEventListener('keydown', e => {
  if ($('#spriteView').hidden || e.target.closest('input, textarea, select, dialog')) return;
  if (e.key === ' ') { e.preventDefault(); player.playing = !player.playing; syncPlayButton(); }
  if (e.key === 'ArrowLeft') { player.step(-1); syncPlayButton(); }
  if (e.key === 'ArrowRight') { player.step(1); syncPlayButton(); }
});

// ---- new / edit form -------------------------------------------------------

const form = $('#newForm');
// fields.name / form.id are the form's own attributes, so go through .elements.
const fields = form.elements;
let idTouched = false;

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

function presetRow(a, on) {
  const row = el('div', { class: `anim-preset${on ? '' : ' off'}`, 'data-name': a.name, 'data-min-cycle': a.minCycle || 0.8, 'data-scale': a.scale || 0.6 },
    el('label', { class: 'check' }, el('input', { type: 'checkbox', class: 'use', checked: on }), a.name),
    el('textarea', { class: 'motion', rows: 3 }, a.motion),
    el('label', {}, 'Frames', el('input', { type: 'number', class: 'frames', min: 1, max: 64, value: a.frames })),
    el('label', {}, 'FPS', el('input', { type: 'number', class: 'fps', min: 1, max: 60, value: a.fps })),
    el('label', {}, 'Loop', el('input', { type: 'checkbox', class: 'cycle', checked: a.cycle !== false })));
  row.querySelector('.use').addEventListener('change', e => row.classList.toggle('off', !e.target.checked));
  return row;
}

function openForm(existing) {
  state.editing = existing || null;
  idTouched = !!existing;
  form.reset();
  $('#newTitle').textContent = existing ? `Edit ${existing.name}` : 'New sprite';
  $('#newError').hidden = true;
  fields.id.readOnly = !!existing;
  if (existing) {
    fields.name.value = existing.name;
    fields.id.value = existing.id;
    fields.subject.value = existing.subject || '';
    fields.useStyle.checked = existing.prompt !== existing.subject;
  }
  $('#modelSelect').value = modelFor(existing);
  const defs = existing ? existing.animations.map(a => a.def).filter(Boolean) : [];
  const rows = state.config.presets.map(p => {
    const def = defs.find(d => d.name === p.name);
    return presetRow(def || p, existing ? !!def : ['idle', 'walk', 'attack'].includes(p.name));
  });
  for (const d of defs) if (!state.config.presets.some(p => p.name === d.name)) rows.push(presetRow(d, true));
  $('#animPresets').replaceChildren(...rows);
  state.selected = existing ? existing.id : null;
  renderList();
  showView('new');
  fields.name.focus();
}

fields.name.addEventListener('input', () => { if (!idTouched) fields.id.value = slug(fields.name.value); });
fields.id.addEventListener('input', () => { idTouched = true; });
$('#toggleStyle').addEventListener('click', () => {
  const p = $('#styleText');
  p.hidden = !p.hidden;
  $('#toggleStyle').textContent = p.hidden ? 'show' : 'hide';
});
$('#cancelNewBtn').addEventListener('click', () => (state.editing ? selectSprite(state.editing.id) : showView(state.selected ? 'sprite' : 'empty')));

form.addEventListener('submit', async e => {
  e.preventDefault();
  const animations = [...document.querySelectorAll('.anim-preset')]
    .filter(row => row.querySelector('.use').checked)
    .map(row => ({
      name: row.dataset.name,
      motion: row.querySelector('.motion').value,
      frames: Number(row.querySelector('.frames').value),
      fps: Number(row.querySelector('.fps').value),
      cycle: row.querySelector('.cycle').checked,
      minCycle: Number(row.dataset.minCycle),
      scale: Number(row.dataset.scale)
    }));
  const body = {
    id: fields.id.value.trim(),
    name: fields.name.value.trim(),
    subject: fields.subject.value.trim(),
    useStyle: fields.useStyle.checked,
    model: fields.model.value,
    animations
  };
  const before = state.editing;
  try {
    const saved = await api('/api/sprites', { method: 'POST', body });
    await loadSprites();
    selectSprite(saved.id);
    // A new description means a new keyframe, which every video starts from.
    const newLook = !!(before && before.keyframe && before.prompt !== saved.prompt);
    await runJob(
      { id: saved.id, model: body.model, regen: newLook ? ['keyframe'] : [] },
      newLook ? `Regenerate ${saved.name} with the new description` : `Generate ${saved.name}`);
  } catch (err) {
    $('#newError').textContent = err.message;
    $('#newError').hidden = false;
  }
});

$('#newSpriteBtn').addEventListener('click', () => openForm(null));

// ---- jobs ------------------------------------------------------------------

let pollTimer = null;

async function pollJobs() {
  clearTimeout(pollTimer);
  try {
    const before = new Map(state.jobs.map(j => [j.id, j.status]));
    state.jobs = await api('/api/jobs');
    const finished = state.jobs.filter(j => before.get(j.id) && before.get(j.id) !== j.status && !['queued', 'running'].includes(j.status));
    if (finished.length) {
      await loadSprites();
      if (state.selected && !$('#spriteView').hidden) renderSprite();
      for (const j of finished) {
        if (j.status === 'done') toast(`${j.label} — done`, 'ok');
        if (j.status === 'failed') toast(`${j.label} — failed. See the job log.`);
      }
    } else {
      renderList();
    }
    renderJobs();
  } catch (e) {
    // Server restarting; keep polling.
  }
  const active = state.jobs.some(j => j.status === 'running' || j.status === 'queued');
  pollTimer = setTimeout(pollJobs, active ? 1200 : 5000);
}

function progressOf(job) {
  const m = job.log.match(/(\d+)%[^%]*$/);
  return m ? `${m[1]}%` : '';
}

function renderJobs() {
  const list = $('#jobList');
  if (!state.jobs.length) {
    list.replaceChildren(el('p', { class: 'hint' }, 'No jobs yet.'));
  } else {
    list.replaceChildren(...state.jobs.map(j => {
      const live = j.status === 'running' || j.status === 'queued';
      return el('button', { class: `job${j.id === state.activeJob ? ' active' : ''}`, onclick: () => { state.activeJob = j.id; renderJobs(); } },
        el('div', { class: 'top' },
          el('span', { class: 'what' }, j.label),
          el('span', { class: `status ${j.status}` }, j.status === 'running' ? `running ${progressOf(j)}` : j.status)),
        el('div', { class: 'top' },
          el('span', { class: 'when' }, ago(j.createdAt)),
          live ? el('span', { class: 'link', role: 'button', onclick: ev => { ev.stopPropagation(); cancelJob(j); } }, 'stop') : null));
    }));
  }
  const job = state.jobs.find(j => j.id === state.activeJob) || state.jobs[0];
  const log = $('#jobLog');
  log.hidden = !job;
  if (job) {
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
    log.textContent = job.log;
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  const running = state.jobs.find(j => j.status === 'running');
  const queued = state.jobs.filter(j => j.status === 'queued').length;
  $('#jobIndicator').hidden = !running;
  if (running) $('#jobIndicator').textContent = `${running.label} ${progressOf(running)}${queued ? ` · ${queued} queued` : ''}`;
}

async function cancelJob(job) {
  if (!confirm(`Stop "${job.label}"? A paid job already submitted keeps running at Apiframe and is picked up again next time.`)) return;
  try {
    await api(`/api/jobs/${job.id}`, { method: 'DELETE' });
    pollJobs();
  } catch (e) {
    toast(e.message);
  }
}

// ---- boot ------------------------------------------------------------------

(async () => {
  try {
    state.config = await api('/api/config');
  } catch (e) {
    toast(`Can't reach the studio server: ${e.message}`);
    return;
  }
  $('#styleText').textContent = state.config.style;
  $('#modelSelect').replaceChildren(...state.config.models.map(m =>
    el('option', { value: m.id }, `${m.id} · ~${m.credits} cr per ${m.duration}s clip`)));
  await loadSprites();
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (fromHash === 'new') openForm(null);
  else if (sprite(fromHash)) selectSprite(fromHash);
  pollJobs();
})();
