import * as E from './engine.js';
import * as AI from './ai-shared.js';
import { t, setLang, getLang } from './i18n.js';
import { readCvFile } from './cv.js';

// ---------- utilities ----------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('frc:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('frc:' + k, JSON.stringify(v)); } catch { /* private mode: fine */ } }
};
const getJSON = async url => { const r = await fetch(url, { cache: 'no-cache' }); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };
const signed = n => (n > 0 ? '+' : '') + n;
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString(getLang() === 'zh' ? 'zh-CN' : getLang() === 'ms' ? 'ms-MY' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const COST_LABEL = { free: 'Free', audit: 'Free to audit', low: 'Low-cost' };
const STATUS_ICON = { rising: '▲', stable: '●', declining: '▼' };
const CAT_ORDER = ['ai', 'digital', 'green', 'health', 'business', 'human', 'routine'];
const ROUTES = ['profile', 'radar', 'matches', 'pathway', 'sdg', 'team', 'method'];
const TAB_COLORS = ['#7c3aed', '#db2777', '#f97316', '#0ea5e9', '#16a34a'];
const CAT_COLOR = { ai: '#7c3aed', digital: '#0ea5e9', green: '#16a34a', health: '#e11d48', business: '#f97316', human: '#db2777', routine: '#94a3b8' };
const SECTOR_EMOJI = { tech: '💻', finance: '💳', green: '🌱', health: '🩺', education: '📚', agri: '🌾', creative: '🎨', business: '📊', public: '🏛️' };
const ROLE_EMOJI = { bank_teller: '🏦', data_entry_clerk: '⌨️', admin_assistant: '🗂️', bookkeeping_clerk: '🧾', cashier: '🛒', graphic_designer: '🎨', customer_service_agent: '🎧', student: '🎓', other: '✨' };
const GRADS = ['var(--grad-violet)', 'var(--grad-sunset)', 'var(--grad-ocean)', 'var(--grad-lime)', 'linear-gradient(135deg,#f43f5e,#a855f7)', 'linear-gradient(135deg,#f59e0b,#ef4444)', 'linear-gradient(135deg,#06b6d4,#6366f1)', 'linear-gradient(135deg,#10b981,#0ea5e9)', 'linear-gradient(135deg,#ec4899,#8b5cf6)'];

const emptyProfile = () => ({ name: '', currentRole: 'other', hoursPerWeek: 6, sectors: [], skills: {} });
const cloneProfile = p => ({ name: p.name || '', currentRole: p.currentRole || 'other', hoursPerWeek: p.hoursPerWeek || 6, sectors: [...(p.sectors || [])], skills: { ...(p.skills || {}) } });
const freshCv = () => ({ stage: 'input', text: '', fileName: '', source: null, found: {} });

const S = {
  data: null, sdgs: [], local: [], profiles: [], team: null, context: null, meta: {},
  skillById: {}, roleById: {}, sdgByGoal: {},
  snapIndex: [], snaps: {}, snapId: null,
  scenario: 'moderate', // headline view; the other scenarios are shown side by side in each page
  profile: store.get('profile', null) || emptyProfile(),
  persona: store.get('persona', null),
  selectedRole: store.get('role', null),
  progress: store.get('progress', {}),
  radarMode: 'chart', selSkill: null, api: false, ai: null, fairness: null,
  // Onboarding / profile flows: mode is null (summary), 'choose', 'form', 'cv', 'samples' or 'edit'.
  ob: { mode: null, step: 0, draft: null, cv: freshCv() },
  explain: {}, forecast: {}
};

const snap = () => S.snaps[S.snapId];
const prevSnapId = () => { const i = S.snapIndex.findIndex(s => s.id === S.snapId); return i > 0 ? S.snapIndex[i - 1].id : null; };
const saveProfile = () => store.set('profile', S.profile);
const hasProfile = () => Object.values(S.profile.skills).some(v => v > 0);

// ---------- small render helpers ----------
const sdgBadge = (goal, title) => { const g = S.sdgByGoal[goal]; return `<span class="sdg-badge" data-tip="${esc(title || `SDG ${goal}: ${g.name}`)}"><b style="background:${g.color}">${goal}</b>${esc(g.name)}</span>`; };
const statusTag = st => `<span class="status ${st}"><span aria-hidden="true">${STATUS_ICON[st]}</span>${t(st)}</span>`;
const riskTag = lvl => `<span class="risk ${lvl}"><span class="dot" aria-hidden="true"></span>${t('exposure_' + lvl)}</span>`;
const levelName = n => S.meta.levels[n];
const sourceLink = (src) => `<a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.name)}</a>`;
const wefSrc = () => snap().sources.find(s => s.id === 'wef');

function computeAll() {
  const sc = S.scenario, sn = snap();
  const trends = E.trendTable(S.data, sn, sc);
  const ranked = E.rankRoles(S.profile, S.data, sn, sc);
  return { trends, ranked };
}

function currentTargetRole(ranked) {
  const id = S.selectedRole && S.roleById[S.selectedRole]?.type === 'future' ? S.selectedRole : ranked[0].roleId;
  return S.roleById[id];
}

// ---------- chrome ----------
function renderChrome() {
  document.documentElement.lang = getLang() === 'zh' ? 'zh-Hans' : getLang();
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  $('#lang').value = getLang();
  $('#snapshot').innerHTML = [...S.snapIndex].reverse().map(s =>
    `<option value="${s.id}" ${s.id === S.snapId ? 'selected' : ''}>${s.asOf}${s.mode === 'backfill' ? ' (backfill)' : ' (live)'}</option>`).join('');
  const rb = $('#refresh');
  rb.textContent = t('refresh');
  rb.disabled = !S.api;
  rb.title = S.api ? 'Fetch new signals from the public APIs now' : 'Live refresh needs the Node server (npm start). On static hosting, a scheduled GitHub Action refreshes the data.';
  const sn = snap();
  const live = sn.sources.filter(s => s.id !== 'wef').length;
  const aiOn = S.ai ? Object.values(S.ai).filter(m => m.connected).length : 0;
  $('#freshness').innerHTML = `${t('data_as_of')} <strong>${sn.asOf}</strong> · ${sn.sources.length} ${t('sources')} (${live} live${sn.mode === 'backfill' ? ', backfill' : ''}) · AI models: ${aiOn}/3 connected · <a href="#method">view</a>`;
  const route = currentRoute();
  const labels = { profile: 'nav_profile', radar: 'nav_radar', matches: 'nav_matches', pathway: 'nav_pathway', sdg: 'nav_sdg', team: 'nav_team', method: 'nav_method' };
  $('#tabs').innerHTML = ROUTES.map((r, i) =>
    (i === 5 ? '<span class="sep" aria-hidden="true"></span>' : '') +
    `<a href="#${r}" ${r === route ? 'aria-current="page"' : ''}>${i < 5 ? `<span class="step" style="--c:${TAB_COLORS[i]}">${i + 1}</span>` : ''}${t(labels[r])}</a>`).join('');
}

const currentRoute = () => { const h = location.hash.slice(1); return ROUTES.includes(h) ? h : 'profile'; };

function render() {
  renderChrome();
  const route = currentRoute();
  const view = $('#view');
  if (['matches', 'pathway', 'sdg'].includes(route) && !hasProfile()) {
    view.innerHTML = `<div class="welcome fade-in"><div style="font-size:3rem">🧭</div><h1>${t('ob_title')}</h1><p>Add a few skills first, or pick a sample profile, to get personalised results.</p><a class="btn big hot" href="#profile">${t('nav_profile')} →</a></div>`;
    return;
  }
  view.innerHTML = ({ profile: viewProfile, radar: viewRadar, matches: viewMatches, pathway: viewPathway, sdg: viewSdg, team: viewTeam, method: viewMethod })[route]();
}

// ---------- 1. Profile ----------
// Three ways in: a short guided form, a CV upload (previewed and editable before saving), or a sample profile.
function viewProfile() {
  const mode = S.ob.mode;
  if (mode === 'form') return viewForm();
  if (mode === 'cv') return viewCv();
  if (mode === 'samples') return viewSamples();
  if (mode === 'edit') return viewEdit();
  if (mode === 'choose' || !hasProfile()) return viewChooser();
  return viewMe();
}

const currentRoles = () => S.data.roles.filter(r => r.type === 'current');
const flowTop = () => `<div class="flow-top"><button class="back-link" data-act="ob" data-id="${hasProfile() && S.ob.mode === 'edit' ? '' : 'choose'}">${S.ob.mode === 'edit' ? `← ${t('cancel')}` : t('ob_back')}</button></div>`;
const levelSeg = (id, lvl, act = 'd-lvl') => `<span class="seg3" role="group" aria-label="${esc(S.skillById[id].name)} level">${[1, 2, 3].map(n =>
  `<button type="button" data-act="${act}" data-id="${id}" data-n="${n}" aria-pressed="${lvl === n}" title="${esc(t('lv' + n + '_d'))}">${t('lv' + n)}</button>`).join('')}</span>`;
const dots = (n, c) => `<span class="dots" style="--c:${c}" aria-label="level ${n} of 3">${[1, 2, 3].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
const avatarFor = (p, i = 0, cls = '') => `<span class="avatar ${cls}" style="--g:${GRADS[i % GRADS.length]}" aria-hidden="true">${p.emoji || ROLE_EMOJI[p.currentRole] || esc((p.name || '?')[0].toUpperCase())}</span>`;

function viewChooser() {
  const opts = [
    ['form', '📝', 'var(--grad-violet)', 'ob_form'],
    ['cv', '📄', 'var(--grad-sunset)', 'ob_cv'],
    ['samples', '🧪', 'var(--grad-ocean)', 'ob_sample']
  ];
  return `<div class="fade-in">
    ${hasProfile() ? `<div class="flow-top"><button class="back-link" data-act="ob" data-id="">← ${t('cancel')}</button></div>` : ''}
    <div class="welcome"><span class="eyebrow">${t('nav_profile')}</span><h1>${t('ob_title')}</h1><p>${t('ob_sub')}</p></div>
    <div class="options">${opts.map(([id, ico, g, k]) => `
      <button class="option" style="--g:${g}" data-act="ob" data-id="${id}">
        <span class="ico" aria-hidden="true">${ico}</span><span class="go" aria-hidden="true">→</span>
        <h3>${t(k)}</h3><p>${t(k + '_d')}</p><span class="meta">${t(k + '_m')}</span>
      </button>`).join('')}</div>
    <p class="privacy"><span aria-hidden="true">🛡️</span><span>${t('ob_privacy')}</span></p>
  </div>`;
}

// ----- guided form -----
const FORM_STEPS = ['f_s1', 'f_s2', 'f_s3', 'f_s4', 'f_s5'];

function stepper(step) {
  return `<ol class="stepper" aria-label="Progress">${FORM_STEPS.map((k, i) =>
    `<li class="${i < step ? 'done' : i === step ? 'on' : ''}" ${i === step ? 'aria-current="step"' : ''}><span class="bar"></span><span class="lbl">${i + 1}. ${t(k)}</span></li>`).join('')}</ol>`;
}

function aboutFields(d) {
  return `
    <div class="field"><label for="d-name">${t('p_name')}</label><input id="d-name" type="text" value="${esc(d.name)}" maxlength="40" data-draft="name" autocomplete="nickname"></div>
    <div class="field"><span class="flabel">${t('p_role')}</span>
      <div class="tiles">${currentRoles().map(r => `<button type="button" class="tile" data-act="d-role" data-id="${r.id}" aria-pressed="${d.currentRole === r.id}"><span class="em" aria-hidden="true">${ROLE_EMOJI[r.id] || '💼'}</span>${esc(r.title)}</button>`).join('')}</div></div>
    <div class="field"><label for="d-hours">${t('p_hours')}</label>
      <div class="hours"><span class="big-num num" id="hoursval">${d.hoursPerWeek}</span><input id="d-hours" type="range" min="2" max="30" step="1" value="${d.hoursPerWeek}" data-draft="hoursPerWeek"></div></div>`;
}

const sectorTiles = d => `<div class="tiles">${Object.entries(S.meta.sectors).map(([id, name]) =>
  `<button type="button" class="tile" data-act="d-sector" data-id="${id}" aria-pressed="${d.sectors.includes(id)}"><span class="em" aria-hidden="true">${SECTOR_EMOJI[id] || '•'}</span>${esc(name)}</button>`).join('')}</div>`;

function skillPicker(d) {
  const n = Object.keys(d.skills).length;
  return `<p><span class="counter">${n} ${t('selected')}</span></p>
    ${CAT_ORDER.map(c => `<div class="skill-group"><h4><i style="--c:${CAT_COLOR[c]}"></i>${esc(S.meta.categories[c])}</h4>
      <div class="chips">${S.data.skills.filter(s => s.category === c).map(s =>
        `<button type="button" class="chip" data-act="d-skill" data-id="${s.id}" aria-pressed="${!!d.skills[s.id]}">${esc(s.name)}</button>`).join('')}</div></div>`).join('')}`;
}

function levelHelp() {
  return `<div class="level-help">${[1, 2, 3].map(n => `<div><b>${dots(n, 'var(--accent)')} ${t('lv' + n)}</b>${t('lv' + n + '_d')}</div>`).join('')}</div>`;
}

// Editable list of skills with levels; used by the form's level step, the review step, the CV preview and the editor.
function skillRater(d, evidence = {}, removable = false) {
  const ids = Object.keys(d.skills).sort((a, b) => CAT_ORDER.indexOf(S.skillById[a].category) - CAT_ORDER.indexOf(S.skillById[b].category));
  const missing = S.data.skills.filter(s => !d.skills[s.id]);
  return `<div class="rate-list">${ids.map(id => {
      const s = S.skillById[id], ev = evidence[id];
      return `<div class="rate-row"><span class="name"><i style="--c:${CAT_COLOR[s.category]}"></i>${esc(s.name)}${ev?.confidence !== undefined ? ` <span class="conf">${Math.round(ev.confidence * 100)}%</span>` : ''}</span>
        <span class="btn-row">${levelSeg(id, d.skills[id])}${removable ? `<button type="button" class="x-btn" data-act="d-skill" data-id="${id}" aria-label="Remove ${esc(s.name)}">✕</button>` : ''}</span>
        ${ev?.evidence?.length ? `<div class="evidence">${ev.evidence.map(e => `“…${e.keyword ? esc(e.context).replace(esc(e.keyword.toLowerCase()), `<mark>${esc(e.keyword.toLowerCase())}</mark>`) : esc(e.context)}…”`).join(' ')}</div>` : ''}
      </div>`; }).join('') || `<p class="note warn">${t('p_cv_none')}</p>`}</div>
    ${removable ? `<div class="add-skill"><select id="d-add" aria-label="${t('add_skill')}"><option value="">${t('add_skill')}</option>${CAT_ORDER.map(c => {
      const list = missing.filter(s => s.category === c);
      return list.length ? `<optgroup label="${esc(S.meta.categories[c])}">${list.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</optgroup>` : '';
    }).join('')}</select><button type="button" class="btn small ghost" data-act="d-add">+ ${t('add')}</button></div>` : ''}`;
}

// The full editable profile: used for the form's review step, the CV preview and "Edit profile".
function profileEditor(d, evidence = {}) {
  return `<div class="grid g2">
      <div>
        <div class="field"><label for="d-name">${t('p_name')}</label><input id="d-name" type="text" value="${esc(d.name)}" maxlength="40" data-draft="name"></div>
        <div class="field"><label for="d-role">${t('p_role')}</label><select id="d-role" data-draft="currentRole" style="width:100%">${currentRoles().map(r => `<option value="${r.id}" ${r.id === d.currentRole ? 'selected' : ''}>${ROLE_EMOJI[r.id] || ''} ${esc(r.title)}</option>`).join('')}</select></div>
        <div class="field"><label for="d-hours">${t('p_hours')}</label><div class="hours"><span class="big-num num" id="hoursval">${d.hoursPerWeek}</span><input id="d-hours" type="range" min="2" max="30" step="1" value="${d.hoursPerWeek}" data-draft="hoursPerWeek"></div></div>
      </div>
      <div class="field"><span class="flabel">${t('p_sectors')}</span><div class="chips">${Object.entries(S.meta.sectors).map(([id, name]) =>
        `<button type="button" class="chip" data-act="d-sector" data-id="${id}" aria-pressed="${d.sectors.includes(id)}">${SECTOR_EMOJI[id] || ''} ${esc(name)}</button>`).join('')}</div></div>
    </div>
    <div class="field"><span class="flabel">${t('p_skills')} <span class="counter">${Object.keys(d.skills).length}</span></span>${skillRater(d, evidence, true)}</div>`;
}

function viewForm() {
  const { step, draft: d } = S.ob;
  const n = Object.keys(d.skills).length;
  const body = [
    () => `<h2>${t('f_about_t')}</h2><p class="lead">${t('f_about_l')}</p>${aboutFields(d)}`,
    () => `<h2>${t('f_int_t')}</h2><p class="lead">${t('f_int_l')}</p>${sectorTiles(d)}`,
    () => `<h2>${t('f_sk_t')}</h2><p class="lead">${t('f_sk_l')}</p>${skillPicker(d)}`,
    () => `<h2>${t('f_lv_t')}</h2><p class="lead">${t('f_lv_l')}</p>${levelHelp()}${skillRater(d)}`,
    () => `<h2>${t('f_rv_t')}</h2><p class="lead">${t('f_rv_l')}</p>${profileEditor(d)}`
  ][step]();
  const last = step === FORM_STEPS.length - 1;
  const blocked = step >= 2 && !n;
  return `<div class="flow fade-in">${flowTop()}${stepper(step)}
    <section class="card flow-card">${body}
      <div class="flow-foot">
        ${step ? `<button type="button" class="btn ghost" data-act="f-step" data-n="${step - 1}">← ${t('back')}</button>` : '<span></span>'}
        ${last ? `<button type="button" class="btn hot" data-act="d-save" ${blocked ? 'disabled' : ''}>${t('save')} ✓</button>`
               : `<button type="button" class="btn" data-act="f-step" data-n="${step + 1}" ${blocked ? 'disabled' : ''}>${t('next')} →</button>`}
      </div>
    </section></div>`;
}

// ----- CV upload -----
function viewCv() {
  const cv = S.ob.cv;
  const model = S.ai?.skills?.connected;
  const badge = `<span class="engine-badge ${model ? 'on' : ''}">${model ? '🤖 Skill-extraction model (RunPod)' : '🔎 Keyword matcher, runs in your browser'}</span>`;
  if (cv.stage === 'loading') return `<div class="flow fade-in"><section class="card flow-card loading"><div class="spinner" aria-hidden="true"></div><h2>${t('cv_loading')}</h2><p class="muted">${esc(cv.fileName)}</p>${badge}</section></div>`;
  if (cv.stage === 'preview') {
    const n = Object.keys(cv.found).length;
    return `<div class="flow fade-in">${flowTop()}
      <section class="card flow-card">
        <h2>${t('cv_found_t')}</h2><p class="lead">${t('cv_found_l')}</p>
        <div class="found-banner"><span class="big num">${n}</span><div><strong>${t('cv_skills_found')}</strong><div class="small muted">${esc(cv.source?.label || '')}${cv.fileName ? ` · ${esc(cv.fileName)}` : ''}</div></div></div>
        ${profileEditor(S.ob.draft, cv.found)}
        <div class="flow-foot">
          <button type="button" class="btn ghost" data-act="cv-restart">← ${t('back')}</button>
          <button type="button" class="btn hot" data-act="d-save" ${Object.keys(S.ob.draft.skills).length ? '' : 'disabled'}>${t('save')} ✓</button>
        </div>
      </section></div>`;
  }
  return `<div class="flow fade-in">${flowTop()}
    <section class="card flow-card">
      <div class="head" style="margin-bottom:6px"><h2 style="margin:0">${t('cv_t')}</h2>${badge}</div>
      <p class="lead">${t('cv_l')}</p>
      <label class="drop" for="cvfile"><span class="ico" aria-hidden="true">📄</span><strong>${t('cv_drop')}</strong><span class="small muted">${t('cv_drop_s')}</span>
        <input id="cvfile" type="file" accept=".txt,.md,.pdf,text/plain,application/pdf"></label>
      <div class="or">${t('cv_or')}</div>
      <label class="flabel" for="cvtext" style="display:block;font-weight:700;margin-bottom:8px">${t('cv_paste')}</label>
      <textarea id="cvtext" placeholder="Paste CV text here…">${esc(cv.text)}</textarea>
      <p class="small muted" style="margin-top:8px">${t('p_samples')}: <a href="samples/cv-aisyah.txt" download>cv-aisyah.txt</a> · <a href="samples/cv-weijie.txt" download>cv-weijie.txt</a>.
        ${model ? 'Your CV text is sent to our server and the skill-extraction model to be read; it is not stored.' : 'Nothing is uploaded: the CV is read inside your browser.'}</p>
      <div class="flow-foot"><span></span><button type="button" class="btn hot" data-act="cv-analyse">${t('cv_go')} →</button></div>
    </section></div>`;
}

async function analyseCv() {
  const cv = S.ob.cv;
  if (cv.text.trim().length < 20) return toast('Add your CV first: upload a file or paste at least a few lines.');
  cv.stage = 'loading'; render();
  let result;
  if (S.api && S.ai?.skills?.connected) {
    try {
      const r = await fetch('api/ai/extract-skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: cv.text }) });
      result = await r.json();
      if (!r.ok) throw new Error(result.error || r.statusText);
    } catch (e) { toast(`Model unavailable (${e.message}); used keyword matching instead.`); }
  }
  if (!result) result = { ...AI.localExtraction(cv.text, S.data), source: { label: 'Keyword matching against our skills taxonomy (in your browser)' } };
  cv.found = result.skills;
  cv.source = result.source;
  cv.stage = 'preview';
  const d = emptyProfile();
  d.name = result.name || '';
  d.currentRole = result.currentRole || 'other';
  d.sectors = (result.sectors || []).filter(s => S.meta.sectors[s]);
  for (const [id, f] of Object.entries(result.skills)) d.skills[id] = f.level;
  S.ob.draft = d;
  render();
}

function handleCvFile(file) {
  S.ob.cv.fileName = file.name;
  readCvFile(file).then(text => { S.ob.cv.text = text; return analyseCv(); }).catch(err => toast(err.message));
}

// ----- sample profiles -----
function viewSamples() {
  return `<div class="fade-in">${flowTop()}
    <div class="head"><div><span class="eyebrow">${t('ob_sample_m')}</span><h1>${t('sp_t')}</h1><p>${t('sp_l')}</p></div></div>
    <div class="personas">${S.profiles.map((pp, i) => `
      <button class="persona" data-act="persona" data-id="${pp.id}" aria-pressed="${S.persona === pp.id}">
        <span class="top">${avatarFor(pp, i)}<span><span class="kind">${esc(pp.kind || '')}</span><strong>${esc(pp.name)}</strong></span></span>
        <span class="desc">${esc(pp.tagline)}</span>
        <span class="mini"><span class="tag">${ROLE_EMOJI[pp.currentRole] || ''} ${esc(S.roleById[pp.currentRole].title)}</span>${Object.entries(pp.skills).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => `<span class="tag">${esc(S.skillById[id].name.split(' (')[0])}</span>`).join('')}</span>
      </button>`).join('')}</div></div>`;
}

// ----- edit an existing profile -----
function viewEdit() {
  return `<div class="flow fade-in">${flowTop()}
    <section class="card flow-card"><h2>${t('me_edit')}</h2><p class="lead">${t('f_rv_l')}</p>${profileEditor(S.ob.draft)}
      <div class="flow-foot"><button type="button" class="btn ghost" data-act="ob" data-id="">${t('cancel')}</button>
        <button type="button" class="btn hot" data-act="d-save" ${Object.keys(S.ob.draft.skills).length ? '' : 'disabled'}>${t('save')} ✓</button></div>
    </section></div>`;
}

// ----- profile summary -----
function viewMe() {
  const p = S.profile;
  const { trends, ranked } = computeAll();
  const pi = S.profiles.findIndex(x => x.id === S.persona);
  const persona = S.profiles[pi];
  const mine = Object.entries(p.skills).filter(([, v]) => v > 0);
  const rising = mine.filter(([id]) => trends[id].status === 'rising').length;
  const risk = E.currentRoleRisk(p, S.data, snap(), S.scenario);
  const top = ranked[0];
  return `<div class="fade-in">
    <section class="card me">
      ${avatarFor(persona || p, Math.max(pi, 0), 'xl')}
      <div><span class="eyebrow">${persona ? `${esc(persona.kind)} · sample profile` : t('nav_profile')}</span>
        <h1>${esc(p.name || 'You')}</h1>
        <div class="facts">
          <span class="pill">${ROLE_EMOJI[p.currentRole] || '💼'} ${esc(S.roleById[p.currentRole]?.title || '')}</span>
          <span class="pill">⏱ ${p.hoursPerWeek} ${t('me_hours')}</span>
          ${p.sectors.map(s => `<span class="pill">${SECTOR_EMOJI[s] || ''} ${esc(S.meta.sectors[s])}</span>`).join('')}
        </div></div>
      <div class="actions"><button class="btn small" data-act="ob" data-id="edit">✏️ ${t('me_edit')}</button><button class="btn small ghost" data-act="ob" data-id="choose">↺ ${t('me_rebuild')}</button></div>
    </section>
    <div class="grid g4" style="margin-top:16px">
      <div class="card stat"><div class="label">${t('me_skills')}</div><div class="value num">${mine.length}</div><div class="sub">${mine.filter(([, v]) => v >= 2).length} at working level or above</div></div>
      <div class="card stat"><div class="label">${t('r_yours')}</div><div class="value num">${rising} / ${mine.length}</div><div class="sub">${t('sc_' + S.scenario)} scenario</div></div>
      <div class="card stat"><div class="label">${t('m_risk')}</div><div class="value" style="font-size:1.25rem">${risk ? riskTag(risk.level) : '—'}</div><div class="sub">AI exposure (estimate)</div></div>
      <div class="card stat"><div class="label">Top match</div><div class="value num">${top.score}</div><div class="sub">${esc(S.roleById[top.roleId].title)}</div></div>
    </div>
    <h2 style="margin:26px 0 12px">${t('me_skills')}</h2>
    <div class="cat-cards">${CAT_ORDER.map(c => {
      const list = mine.filter(([id]) => S.skillById[id].category === c).sort((a, b) => b[1] - a[1]);
      return list.length ? `<div class="cat-card" style="--c:${CAT_COLOR[c]}"><h4>${esc(S.meta.categories[c])}</h4>
        ${list.map(([id, v]) => `<div class="lv-row"><span>${esc(S.skillById[id].name)}</span>${dots(v, CAT_COLOR[c])}</div>`).join('')}</div>` : '';
    }).join('')}</div>
    <div class="cta"><div><h3>${t('me_cta_t')}</h3><p>${t('me_cta_p')}</p></div><a class="btn big" href="#matches">${t('p_go')}</a></div>
    <p class="privacy" style="margin-left:0"><span aria-hidden="true">🛡️</span><span>${t('p_fair')}</span></p>
  </div>`;
}

function saveDraft() {
  const d = S.ob.draft;
  const skills = Object.fromEntries(Object.entries(d.skills).filter(([, v]) => v > 0));
  if (!Object.keys(skills).length) return toast('Add at least one skill.');
  S.profile = { ...cloneProfile(d), name: d.name.trim(), skills };
  if (S.ob.mode !== 'edit') { S.persona = null; store.set('persona', null); }
  S.selectedRole = null; store.set('role', null);
  S.explain = {};
  S.ob = { mode: null, step: 0, draft: null, cv: freshCv() };
  saveProfile();
  toast(`✓ ${t('saved')}`);
  render(); window.scrollTo(0, 0);
}

// ---------- 2. Skills radar ----------
function trendTip(s, tr) {
  const c = tr.components;
  return [
    `${s.name}: ${signed(tr.index)} (range ${signed(tr.low)} to ${signed(tr.high)})`,
    `WEF baseline: ${signed(c.wef.value)} × ${c.wef.weight.toFixed(2)}`,
    c.momentum ? `Discussion momentum: ${signed(c.momentum.value)} × ${c.momentum.weight.toFixed(2)}` : 'Discussion momentum: no signal',
    c.demand ? `Job-ad demand: ${signed(c.demand.value)} × ${c.demand.weight.toFixed(2)}` : 'Job-ad demand: not available',
    `AI pressure: ${signed(c.aiPressure.value)} × scenario ${c.aiPressure.k}`
  ].join('\n');
}

function divergingRow(s, tr, mine) {
  const w = Math.abs(tr.index) / 2;
  const cls = tr.status === 'stable' ? 'neu' : tr.index >= 0 ? 'pos' : 'neg';
  const pos = tr.index >= 0;
  const barStyle = cls === 'neu' ? `left:${pos ? 50 : 50 - w}%;width:${Math.max(w, 0.6)}%` : `width:${Math.max(w, 0.6)}%`;
  const wl = 50 + tr.low / 2, wh = 50 + tr.high / 2;
  return `<div class="dbar ${S.selSkill === s.id ? 'sel' : ''}" role="button" tabindex="0" data-act="skill" data-id="${s.id}" data-tip="${esc(trendTip(s, tr))}">
    <span class="lbl">${mine ? `<span class="you" title="${t('r_you')}: level ${mine}">●L${mine}</span> ` : ''}${esc(s.name)}</span>
    <span class="track"><span class="bar ${cls}" style="${barStyle}"></span><span class="whisk" style="left:${wl}%;width:${wh - wl}%"></span></span>
    <span class="val">${signed(tr.index)}</span></div>`;
}

function skillBreakdown(id, trends) {
  const s = S.skillById[id], tr = trends[id], sig = tr.signal, sn = snap(), c = tr.components;
  const hnSrc = sn.sources.find(x => x.id === 'hn');
  const jobSrcs = sn.sources.filter(x => x.id === 'arbeitnow' || x.id === 'remotive');
  const all = Object.keys(E.SCENARIOS).map(sc => [sc, E.trendTable(S.data, sn, sc)[id]]);
  return `<h3>${esc(s.name)}</h3>
  <p>${statusTag(tr.status)} <strong class="num">${signed(tr.index)}</strong> <span class="muted small">(${signed(tr.low)} to ${signed(tr.high)})</span></p>
  <table class="small"><tr>${all.map(([sc]) => `<th class="num">${t('sc_' + sc)}</th>`).join('')}</tr><tr>${all.map(([, v]) => `<td class="num">${signed(v.index)}</td>`).join('')}</tr></table>
  <dl class="breakdown">
    <dt>1 · WEF baseline (weight ${c.wef.weight.toFixed(2)}): ${signed(c.wef.value)}</dt>
    <dd>${esc(s.wef.note)} — ${sourceLink(wefSrc())}</dd>
    <dt>2 · AI-discussion momentum (weight ${c.momentum ? c.momentum.weight.toFixed(2) : '—'}): ${c.momentum ? signed(c.momentum.value) : 'n/a'}</dt>
    <dd>${sig.hn ? `Hacker News stories matching <code>${esc(sig.hn.query)}</code>: <strong>${sig.hn.recent}</strong> (${hnSrc.window.recent.join(' → ')}) vs <strong>${sig.hn.prior}</strong> (${hnSrc.window.prior.join(' → ')}), normalised by total story volume and compared with the median tracked topic. Volume confidence ${(sig.momentumConfidence * 100).toFixed(0)}%. — ${sourceLink(hnSrc)}` : 'Not tracked on Hacker News (human/routine skill); weight redistributed.'}</dd>
    <dt>3 · Job-ad demand (weight ${c.demand ? c.demand.weight.toFixed(2) : '—'}): ${c.demand ? signed(c.demand.value) : 'n/a'}</dt>
    <dd>${sig.jobs ? `Mentioned in <strong>${sig.jobs.mentions}</strong> of ${sig.jobs.total} live postings (${(sig.jobs.share * 100).toFixed(1)}%), ranked against the other tracked skills. — ${jobSrcs.map(sourceLink).join(', ')}` : 'No live job data in this snapshot (backfill snapshots cannot include past job ads).'}</dd>
    <dt>4 · AI pressure (scenario × ${c.aiPressure.k}): ${signed(c.aiPressure.value)}</dt>
    <dd>Team assumption: AI complements this skill ${s.aiComplement.toFixed(2)}, automates it ${s.aiExposure.toFixed(2)}. Faster scenarios amplify this effect.</dd>
  </dl>
  <p class="small muted">Index = 100 × clamp(0.65 × weighted signals + 0.35 × scenario × AI pressure)</p>
  <div class="sdg-badges">${s.sdgs.map(g => sdgBadge(g.goal, g.why)).join('')}</div>
  ${forecastPanel(id)}`;
}

function forecastPanel(id) {
  const fc = S.forecast[id];
  return `<div class="forecast"><div class="head" style="margin:0 0 6px;align-items:center"><strong>🔮 ${t('fc_title')}</strong>
      ${fc && !fc.loading ? '' : `<button class="btn small" data-act="forecast" data-id="${id}" ${fc?.loading ? 'disabled' : ''}>${fc?.loading ? '…' : t('fc_btn')}</button>`}</div>
    ${fc && !fc.loading ? `${sparkline(fc.history, fc.points)}
      <p class="small" style="margin:6px 0 0">In 12 months: <strong class="num">${signed(fc.points.at(-1).index)}</strong> <span class="muted">(range ${signed(fc.points.at(-1).low)} to ${signed(fc.points.at(-1).high)})</span></p>
      <p class="small muted" style="margin:2px 0 0">${esc(fc.source?.label || '')}. A projection, not a prediction.</p>`
    : `<p class="small muted" style="margin:0">${S.ai?.forecast?.connected ? 'Uses the forecasting model on RunPod.' : 'Forecasting model not connected: uses a damped linear trend over the snapshot history.'}</p>`}
  </div>`;
}

function sparkline(history, points) {
  const all = [...history, ...points];
  const t0 = new Date(all[0].asOf), t1 = new Date(all.at(-1).asOf);
  const W = 320, H = 110, P = 8;
  const x = d => P + (W - 2 * P) * ((new Date(d) - t0) / ((t1 - t0) || 1));
  const y = v => H / 2 - v * (H / 2 - P) / 100;
  const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.asOf).toFixed(1)},${y(p.index).toFixed(1)}`).join('');
  const last = history.at(-1);
  const band = [{ asOf: last.asOf, v: last.index }, ...points.map(p => ({ asOf: p.asOf, v: p.high }))]
    .concat([...points].reverse().map(p => ({ asOf: p.asOf, v: p.low })), [{ asOf: last.asOf, v: last.index }])
    .map(p => `${x(p.asOf).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Trend history and forecast">
    <line x1="${P}" x2="${W - P}" y1="${y(0)}" y2="${y(0)}" stroke="var(--axis)" stroke-dasharray="3 3"/>
    <polygon points="${band}" fill="#ec4899" opacity=".15"/>
    <path d="${path([last, ...points])}" fill="none" stroke="#db2777" stroke-width="2.5" stroke-dasharray="5 4"/>
    <path d="${path(history)}" fill="none" stroke="#7c3aed" stroke-width="3" stroke-linecap="round"/>
    ${history.map(p => `<circle cx="${x(p.asOf)}" cy="${y(p.index)}" r="3.5" fill="#7c3aed"/>`).join('')}
    <text x="${P}" y="${H - 1}" font-size="9" fill="var(--muted)">${history[0].asOf}</text>
    <text x="${W - P}" y="${H - 1}" font-size="9" fill="var(--muted)" text-anchor="end">${points.at(-1).asOf}</text>
  </svg>`;
}

async function forecastSkill(id) {
  S.forecast[id] = { loading: true }; rerender();
  try {
    if (S.api) {
      const r = await fetch('api/ai/forecast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skillIds: [id], horizonMonths: 12, scenario: S.scenario }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || r.statusText);
      S.forecast[id] = { ...body.forecasts[id], source: body.source };
    } else {
      await Promise.all(S.snapIndex.map(s => S.snaps[s.id] ? null : getJSON(`data/snapshots/${s.id}.json`).then(j => { S.snaps[s.id] = j; })));
      const hist = AI.trendHistory(S.data, S.snapIndex.map(s => S.snaps[s.id]), S.scenario)[id];
      S.forecast[id] = { history: hist, ...AI.linearForecast(hist, 12), source: { label: 'Damped linear trend (computed in your browser)' } };
    }
  } catch (e) { delete S.forecast[id]; toast('Forecast failed: ' + e.message); }
  rerender();
}

function viewRadar() {
  const { trends } = computeAll();
  const sn = snap();
  const skills = S.data.skills;
  const nonHuman = skills.filter(s => s.category !== 'human');
  const topRise = [...nonHuman].sort((a, b) => trends[b.id].index - trends[a.id].index)[0];
  const topFall = [...skills].sort((a, b) => trends[a.id].index - trends[b.id].index)[0];
  const mine = skills.filter(s => S.profile.skills[s.id] > 0);
  const mineRising = mine.filter(s => trends[s.id].status === 'rising');
  const jobsTotal = Object.values(sn.skills).find(v => v.jobs)?.jobs.total;
  const hnSrc = sn.sources.find(s => s.id === 'hn');
  const sel = S.selSkill || topRise.id;

  const chart = CAT_ORDER.map(c => {
    const list = skills.filter(s => s.category === c).sort((a, b) => trends[b.id].index - trends[a.id].index);
    return `<div class="dbar-group"><h4>${esc(S.meta.categories[c])}</h4>${list.map(s => divergingRow(s, trends[s.id], S.profile.skills[s.id])).join('')}</div>`;
  }).join('');

  const allSc = Object.fromEntries(Object.keys(E.SCENARIOS).map(sc => [sc, E.trendTable(S.data, sn, sc)]));
  const table = `<div class="table-wrap"><table><thead><tr><th>Skill</th><th>Status</th>${Object.keys(E.SCENARIOS).map(sc => `<th class="num">${t('sc_' + sc)}</th>`).join('')}<th class="num">WEF</th><th class="num">HN recent / prior</th><th class="num">Job ads</th></tr></thead><tbody>
    ${[...skills].sort((a, b) => trends[b.id].index - trends[a.id].index).map(s => { const tr = trends[s.id]; return `<tr><td>${esc(s.name)}</td><td>${statusTag(tr.status)}</td>${Object.keys(E.SCENARIOS).map(sc => `<td class="num">${signed(allSc[sc][s.id].index)}</td>`).join('')}<td class="num">${signed(s.wef.direction)}</td><td class="num">${tr.signal.hn ? `${tr.signal.hn.recent} / ${tr.signal.hn.prior}` : '—'}</td><td class="num">${tr.signal.jobs ? (tr.signal.jobs.share * 100).toFixed(1) + '%' : '—'}</td></tr>`; }).join('')}
  </tbody></table></div>`;

  const prevId = prevSnapId();
  let changes = '';
  if (prevId && S.snaps[prevId]) {
    const cmp = E.compareSnapshots(S.profile, S.data, S.snaps[prevId], sn, S.scenario);
    const prev = S.snapIndex.find(s => s.id === prevId);
    changes = `<section class="card"><h3>${t('r_changed')} ${prev.asOf}</h3>
      ${prev.mode === 'backfill' || sn.mode === 'backfill' ? '<p class="small muted">One snapshot is a backfill without job-ad data, so part of the change comes from re-weighting.</p>' : ''}
      <table><tbody>${cmp.skillMoves.slice(0, 6).map(m => `<tr><td>${esc(S.skillById[m.id].name)}</td><td class="num">${signed(m.from)} → <strong>${signed(m.to)}</strong></td><td class="num"><span class="status ${m.delta > 0 ? 'rising' : 'declining'}">${m.delta > 0 ? '▲' : '▼'} ${signed(m.delta)}</span></td></tr>`).join('')}</tbody></table></section>`;
  }

  const futures = Object.values(E.SCENARIOS).map(sc => {
    const tt = allSc[sc.id];
    const tech = nonHuman.filter(s => s.category !== 'routine').sort((a, b) => tt[b.id].index - tt[a.id].index).slice(0, 3);
    const fall = [...skills].sort((a, b) => tt[a.id].index - tt[b.id].index).slice(0, 2);
    return `<div class="future ${sc.id}"><div class="future-h">${t('sc_' + sc.id)}<span>${esc(sc.label)}</span></div>
      <p class="small">${esc(sc.blurb)}</p>
      <div class="small"><strong>▲ Rising most</strong>${tech.map(s => `<div>${esc(s.name)} <b class="num">${signed(tt[s.id].index)}</b></div>`).join('')}</div>
      <div class="small" style="margin-top:6px"><strong>▼ Falling most</strong>${fall.map(s => `<div>${esc(s.name)} <b class="num">${signed(tt[s.id].index)}</b></div>`).join('')}</div></div>`;
  }).join('');
  const futureRoles = S.data.roles.filter(r => r.type === 'future').map(r => ({ r, o: E.roleOutlook(r, trends) })).sort((a, b) => b.o.index - a.o.index);
  const currentRoles = S.data.roles.filter(r => r.type === 'current' && r.skills.length).map(r => ({ r, o: E.roleOutlook(r, trends) })).sort((a, b) => a.o.index - b.o.index);
  const ctx = S.context;

  return `
  <div class="head"><div><h1>${t('r_title')}</h1><p>${t('r_sub')}</p></div>
    <div class="seg" role="radiogroup" aria-label="View">${['chart', 'table'].map(m => `<button role="radio" aria-checked="${S.radarMode === m}" data-act="radar-mode" data-id="${m}">${t('r_' + m)}</button>`).join('')}</div></div>
  <div class="grid g4">
    <div class="card stat"><div class="label">${t('r_top_rising')} <span class="muted">(excl. human skills)</span></div><div class="value num">${signed(trends[topRise.id].index)}</div><div class="sub">${esc(topRise.name)}</div></div>
    <div class="card stat"><div class="label">${t('r_top_declining')}</div><div class="value num">${signed(trends[topFall.id].index)}</div><div class="sub">${esc(topFall.name)}</div></div>
    <div class="card stat"><div class="label">${t('r_yours')}</div><div class="value num">${mineRising.length} / ${mine.length}</div><div class="sub">${mine.length ? esc(mineRising.slice(0, 3).map(s => s.name).join(', ') || '—') : '<a href="#profile">Add your skills</a>'}</div></div>
    <div class="card stat"><div class="label">Signals in this snapshot</div><div class="value num">${jobsTotal ? jobsTotal.toLocaleString() : '—'}</div><div class="sub">job ads · ${(hnSrc.totals.recent + hnSrc.totals.prior).toLocaleString()} HN stories scanned</div></div>
  </div>
  <section class="card" style="margin-top:14px"><div class="head" style="margin-bottom:8px"><div><h2 style="margin:0">Three possible futures</h2><p class="small">AI progress is uncertain, so we show three scenarios instead of one prediction. The chart below uses the moderate one.</p></div></div>
    <div class="futures">${futures}</div></section>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));margin-top:14px;align-items:start">
    <section class="card" style="grid-column:span 1">
      ${S.radarMode === 'chart' ? `
      <div class="legend"><span><i style="background:var(--rise)"></i>${t('rising')} (≥ +15)</span><span><i style="background:var(--neutral)"></i>${t('stable')}</span><span><i style="background:var(--fall)"></i>${t('declining')} (≤ −15)</span><span>├─┤ uncertainty range</span><span style="color:var(--accent-ink)">●L2 = ${t('r_you')} (your level)</span></div>
      <div class="axis-row"><span></span><span class="ticks"><span>−100</span><span>0</span><span>+100</span></span><span></span></div>
      ${chart}` : table}
    </section>
    <div class="stack">
      <section class="card" id="breakdown">${skillBreakdown(sel, trends)}</section>
      ${changes}
      <section class="card"><h3>Role outlook (${t('sc_' + S.scenario)} scenario)</h3>
        <p class="small muted">40% WEF job outlook + 60% weighted trend of the role's skills.</p>
        <table><tbody>${futureRoles.slice(0, 6).map(({ r, o }) => `<tr><td>${esc(r.title)}</td><td class="num">${signed(o.index)}</td></tr>`).join('')}
        <tr><th colspan="2">Most exposed roles today</th></tr>
        ${currentRoles.slice(0, 4).map(({ r, o }) => `<tr><td>${esc(r.title)}</td><td class="num"><span class="status declining">${signed(o.index)}</span></td></tr>`).join('')}</tbody></table>
      </section>
      ${ctx ? `<section class="card"><h3>${t('r_my_ctx')}</h3>
        <div class="grid g3" style="gap:8px">
          <div><div class="small muted">Unemployment rate</div><div class="stat value" style="padding:0">${ctx.labourForce.u_rate}%</div><div class="small muted">${ctx.labourForce.date} · <code>${ctx.labourForce.dataset}</code></div></div>
          ${ctx.skillsUnderemployment ? `<div><div class="small muted">Skills-related underemployment</div><div class="stat value" style="padding:0">${ctx.skillsUnderemployment.overallRate}%</div><div class="small muted">${ctx.skillsUnderemployment.date} · <code>${ctx.skillsUnderemployment.dataset}</code></div></div>` : ''}
        </div>
        <p class="small muted" style="margin-top:8px">${sourceLink(ctx.source)}, retrieved ${fmtDate(ctx.retrievedAt)}. Skills-related underemployment = workers whose qualifications exceed what their job requires.</p></section>` : ''}
    </div>
  </div>`;
}

// ---------- 3. Matches ----------
function explainMatch(m) {
  const p = m.parts;
  const interestBits = [p.interest.sectorHit ? 'matches a sector you chose' : 'not in a sector you chose'];
  return `<div class="stackbar" aria-hidden="true">
      <span style="width:${p.skills.value * p.skills.weight}%;background:var(--s1)"></span>
      <span style="width:${p.outlook.value * p.outlook.weight}%;background:var(--s2)"></span>
      <span style="width:${p.interest.value * p.interest.weight}%;background:var(--s3)"></span></div>
    <div class="legend small" style="margin:0 0 6px">
      <span><i style="background:var(--s1)"></i>Skills fit ${p.skills.value}/100 × ${p.skills.weight.toFixed(2)}</span>
      <span data-tip="Role outlook index ${signed(p.outlook.index)} = 40% WEF (${signed(p.outlook.fromWef)}) + 60% skill trends (${signed(p.outlook.fromSkills)})"><i style="background:var(--s2)"></i>Outlook ${p.outlook.value}/100 × ${p.outlook.weight.toFixed(2)}</span>
      <span><i style="background:var(--s3)"></i>Interest ${p.interest.value}/100 × ${p.interest.weight.toFixed(2)} <span class="muted">(${interestBits.join(', ')})</span></span>
    </div>`;
}

function matchCard(m, i, matrix) {
  const r = S.roleById[m.roleId];
  const mx = matrix[m.roleId];
  return `<article class="card match">
    <div class="score"><div class="rank">#${i + 1}</div><div class="big num">${m.score}</div><div class="range" data-tip="${t('m_range')}: ${Object.keys(E.SCENARIOS).map(sc => `${t('sc_' + sc)} ${mx[sc].score} (#${mx[sc].rank})`).join(' · ')}">${mx.min}–${mx.max}</div></div>
    <div>
      <div class="head" style="margin:0"><h3 style="margin:0">${esc(r.title)}</h3>${mx.robust ? `<span class="badge-robust">✓ ${t('m_robust')}</span>` : ''}</div>
      <p class="small muted" style="margin:2px 0 4px">${esc(r.summary)}</p>
      ${explainMatch(m)}
      <div class="chips" style="margin-bottom:6px">
        ${m.have.map(h => `<span class="tag have">✓ ${esc(S.skillById[h.id].name)}</span>`).join('')}
        ${m.gaps.map(g => `<span class="tag gap" data-tip="You: ${levelName(g.have)} → needed: ${levelName(g.need)}">✗ ${esc(S.skillById[g.id].name)} ${g.have}→${g.need}</span>`).join('')}
      </div>
      <div class="sdg-badges" style="margin-bottom:6px">${r.sdgs.map(g => sdgBadge(g.goal, g.why)).join('')}</div>
      <p class="small muted" style="margin-bottom:8px">Outlook source: ${esc(r.wef.note)} ${sourceLink(wefSrc())}; live signals from ${snap().asOf} snapshot.</p>
      <div class="btn-row"><button class="btn small" data-act="choose-role" data-id="${r.id}">${t('m_build')} →</button>
        ${S.explain[r.id]?.text ? '' : `<button class="btn small ghost" data-act="explain" data-id="${r.id}" ${S.explain[r.id]?.loading ? 'disabled' : ''}>${S.explain[r.id]?.loading ? t('explain_loading') : t('explain_btn')}</button>`}</div>
      ${S.explain[r.id]?.text ? `<div class="explain fade-in">${esc(S.explain[r.id].text)}<span class="src">✨ ${esc(S.explain[r.id].source?.label || '')} · written from the facts on this card; the score is unchanged.</span></div>` : ''}
    </div>
  </article>`;
}

async function explainRole(roleId) {
  S.explain[roleId] = { loading: true }; rerender();
  try {
    if (S.api) {
      const r = await fetch('api/ai/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: S.profile, roleId, scenario: S.scenario, snapshotId: S.snapId, lang: getLang() }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || r.statusText);
      S.explain[roleId] = body;
    } else {
      const facts = AI.buildExplainFacts(S.profile, roleId, S.data, snap(), S.scenario);
      S.explain[roleId] = { text: AI.templateExplanation(facts), source: { label: 'Template (no server, LLM not connected)' } };
    }
  } catch (e) { delete S.explain[roleId]; toast('Explanation failed: ' + e.message); }
  rerender();
}

function viewMatches() {
  const { ranked } = computeAll();
  const sn = snap();
  const matrix = E.scenarioMatrix(S.profile, S.data, sn);
  const risk = E.currentRoleRisk(S.profile, S.data, sn, S.scenario);
  const top = ranked.slice(0, 5);

  // Automatic re-planning: compare with the recommendation we showed last time.
  const last = store.get('lastRec', null);
  const nowRec = { snapId: S.snapId, scenario: S.scenario, top: ranked.slice(0, 3).map(m => m.roleId) };
  let replan = '';
  if (last && last.snapId !== S.snapId && last.scenario === S.scenario && last.top.join() !== nowRec.top.join()) {
    replan = `<div class="note warn"><strong>${t('m_replan')}</strong> (${esc(last.snapId)} → ${esc(S.snapId)}): ${nowRec.top.map((id, i) => `#${i + 1} ${esc(S.roleById[id].title)}${last.top[i] !== id ? ' (new)' : ''}`).join(', ')}.</div>`;
  }
  store.set('lastRec', nowRec);
  const prevId = prevSnapId();
  let moves = '';
  if (prevId && S.snaps[prevId]) {
    const cmp = E.compareSnapshots(S.profile, S.data, S.snaps[prevId], sn, S.scenario);
    const changed = cmp.roleMoves.slice(0, 6).filter(m => m.fromRank !== m.toRank || m.fromScore !== m.toScore);
    moves = `<p class="small muted">Versus the ${esc(prevId)} snapshot: ${changed.length ? changed.map(m => `${esc(S.roleById[m.roleId].title)} ${m.fromScore}→${m.toScore}${m.fromRank !== m.toRank ? ` (#${m.fromRank}→#${m.toRank})` : ''}`).join(' · ') : 'your top roles are unchanged.'}</p>`;
  }

  const riskCard = risk ? `<section class="card"><div class="head" style="margin:0"><div>
      <div class="small muted">${t('m_risk')}</div>
      <h3 style="margin:0">${esc(S.roleById[risk.roleId].title)} · AI exposure ${riskTag(risk.level)} <span class="muted small">(estimate)</span></h3></div>
      <div class="num">Outlook ${signed(risk.outlook.index)}</div></div>
      <p class="small" style="margin:6px 0 0">${esc(risk.wef.note)} Most exposed tasks: ${risk.atRisk.slice(0, 2).map(a => `${esc(S.skillById[a.id].name)} (${signed(a.index)})`).join(', ')}. Your transferable skills still count toward the roles below.</p></section>` : '';

  return `
  <div class="head"><div><h1>${t('m_title')}${S.profile.name ? `, ${esc(S.profile.name)}` : ''}</h1><p>${t('m_sub')} ${t('estimate_note')}</p></div></div>
  ${replan}
  <div class="stack">
    ${riskCard}
    ${top.map((m, i) => matchCard(m, i, matrix)).join('')}
  </div>
  ${moves}
  <section class="card"><h3>${t('m_matrix')}</h3>
    <p class="small muted">Scores and ranks for each AI-disruption scenario. A role that stays near the top in all three is a safer bet when the future is uncertain.</p>
    <div class="table-wrap"><table><thead><tr><th>Role</th>${Object.values(E.SCENARIOS).map(sc => `<th class="num">${t('sc_' + sc.id)}</th>`).join('')}<th></th></tr></thead><tbody>
      ${ranked.slice(0, 10).map(m => { const mx = matrix[m.roleId]; return `<tr><td>${esc(S.roleById[m.roleId].title)}</td>${Object.keys(E.SCENARIOS).map(sc => `<td class="num">#${mx[sc].rank} · ${mx[sc].score}</td>`).join('')}<td>${mx.robust ? '<span class="badge-robust">✓ robust</span>' : ''}</td></tr>`; }).join('')}
    </tbody></table></div>
    <details style="margin-top:8px"><summary>All ${ranked.length} roles</summary>
      <table><tbody>${ranked.map((m, i) => `<tr><td>#${i + 1} ${esc(S.roleById[m.roleId].title)}</td><td class="num">${m.score}</td><td><button class="btn small ghost" data-act="choose-role" data-id="${m.roleId}">${t('m_build')}</button></td></tr>`).join('')}</tbody></table>
    </details>
  </section>
  <p class="note">${t('m_human')}</p>`;
}

// ---------- 4. Pathway ----------
function viewPathway() {
  const { ranked } = computeAll();
  const role = currentTargetRole(ranked);
  const sn = snap();
  const pw = E.buildPathway(S.profile, role, S.data, sn, S.scenario);
  const prog = S.progress[role.id] || {};
  const done = pw.steps.filter(s => prog[s.skillId]);
  const scoreOf = id => ranked.find(m => m.roleId === id)?.score;
  const end = new Date(Date.now() + pw.weeks * 7 * 86400000);

  const steps = pw.steps.map(st => {
    const sk = S.skillById[st.skillId];
    const isDone = !!prog[st.skillId];
    return `<li class="${isDone ? 'done' : ''}"><span class="node">${isDone ? '✓' : st.n}</span>
      <div class="head" style="margin:0 0 2px;align-items:center">
        <h3 style="margin:0">${esc(sk.name)} <span class="tag">${levelName(st.from)} → ${levelName(st.to)}</span></h3>
        <label class="small"><input type="checkbox" data-act="step-done" data-role="${role.id}" data-id="${st.skillId}" ${isDone ? 'checked' : ''}> ${t('w_done')}</label>
      </div>
      <div class="small muted">${t('week')} ${st.startWeek}–${st.endWeek} · ~${st.hours} ${t('hours')} · trend ${statusTag(E.trendTable(S.data, sn, S.scenario)[st.skillId].status)} ${signed(st.trend)}</div>
      ${st.resources.map(r => `<div class="res">
          <div><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a><div class="meta">${esc(r.provider)} · ${esc(r.format)}</div></div>
          <div class="meta" style="text-align:right">${r.reused ? `<em>${t('w_reused')}</em>` : `<span class="${r.cost === 'free' || r.cost === 'audit' ? 'cost-free' : ''}">${COST_LABEL[r.cost]}</span><br>~${r.hours} h`}</div>
        </div>`).join('')}
      <div class="small muted" style="margin-top:4px">+ ~${st.practiceHours} h ${t('w_practice')}</div>
      ${st.shortfall ? `<p class="note warn small" style="margin-top:6px">${t('w_shortfall')}</p>` : ''}
      <div class="sdg-badges" style="margin-top:6px">${sk.sdgs.map(g => sdgBadge(g.goal, g.why)).join('')}</div>
    </li>`;
  }).join('');

  return `
  <div class="head"><div><h1>${t('w_title')}</h1><p>Ordered so prerequisites come first, then the skills that matter most for the role. Hours are planning estimates for a working adult — check each provider.</p></div>
    <button class="btn ghost small" data-act="print">${t('w_print')}</button></div>
  <section class="card"><div class="field" style="margin:0"><label for="target">${t('w_target')}</label>
    <select id="target" data-bind="target">${ranked.map(m => `<option value="${m.roleId}" ${m.roleId === role.id ? 'selected' : ''}>${esc(S.roleById[m.roleId].title)} — match ${m.score}</option>`).join('')}</select></div></section>
  <div class="grid g4" style="margin-top:14px">
    <div class="card stat"><div class="label">${t('w_total')}</div><div class="value num">~${pw.totalHours} h</div><div class="sub">course + practice time</div></div>
    <div class="card stat"><div class="label">${t('w_weeks')}</div><div class="value num">${pw.weeks} ${t('weeks')}</div><div class="sub">at ${pw.hoursPerWeek} h/week · ~${fmtDate(end.toISOString())}</div></div>
    <div class="card stat"><div class="label">${t('w_cost')}</div><div class="value" style="font-size:1.1rem">${pw.allFree ? `<span class="cost-free">${t('w_free')}</span>` : t('w_low')}</div><div class="sub">certificates may cost extra</div></div>
    <div class="card stat"><div class="label">${t('w_progress')}</div><div class="value num">${done.length} / ${pw.steps.length}</div><div class="progress" role="progressbar" aria-valuenow="${done.length}" aria-valuemax="${pw.steps.length}"><span style="width:${pw.steps.length ? done.length / pw.steps.length * 100 : 0}%"></span></div></div>
  </div>
  ${done.length ? `<section class="card"><h3>${t('w_badges')}</h3><div class="badges">${done.map(s => `<span class="badge">🏅 ${esc(S.skillById[s.skillId].name)} · ${levelName(s.to)}</span>`).join('')}</div></section>` : ''}
  <section class="card">
    <h2>${esc(role.title)} <span class="muted small">match ${scoreOf(role.id)}</span></h2>
    ${pw.steps.length ? `<ol class="timeline">${steps}</ol>` : '<p>You already meet every skill requirement for this role. Focus on a portfolio and applications.</p>'}
    <h3>${t('w_next')}</h3>
    <ol class="stack" style="padding-left:20px">
      <li><strong>Build one portfolio project</strong> that uses your new skills on a real problem linked to ${role.sdgs.map(g => `SDG ${g.goal}`).join(' / ')}.</li>
      <li><strong>Talk to a person</strong> — your HR/L&amp;D team, a TVET or university career centre — before committing. This plan supports, not replaces, that conversation.</li>
      ${S.local.map(l => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a> <span class="small muted">— ${esc(l.provider)}. ${esc(l.note)}</span></li>`).join('')}
    </ol>
  </section>`;
}

// ---------- 5. SDG impact ----------
function viewSdg() {
  const { ranked } = computeAll();
  const role = currentTargetRole(ranked);
  const pw = E.buildPathway(S.profile, role, S.data, snap(), S.scenario);
  const contrib = E.sdgContribution(S.profile, role, pw, S.data);
  const byGoal = Object.fromEntries(contrib.map(c => [c.goal, c]));
  const top = contrib.slice(0, 3);
  const learned = pw.steps.map(s => S.skillById[s.skillId].name);
  const fromLabel = { role: 'Role', 'new-skill': 'Skill you will learn', skill: 'Skill you already have' };

  return `
  <div class="head"><div><h1>${t('s_title')}</h1><p>${t('s_sub')}</p></div></div>
  <section class="card">
    <p style="font-size:1.05rem">As a <strong>${esc(role.title)}</strong>, your work would most directly support
      ${top.map(c => `<strong>SDG ${c.goal} (${esc(S.sdgByGoal[c.goal].name)})</strong>`).join(', ')}.
      ${learned.length ? `The ${learned.length} skill${learned.length > 1 ? 's' : ''} you will learn (${esc(learned.slice(0, 3).join(', '))}${learned.length > 3 ? '…' : ''}) add to ${new Set(pw.steps.flatMap(s => S.skillById[s.skillId].sdgs.map(g => g.goal))).size} goals.` : ''}</p>
    <div class="sdg-grid">${S.sdgs.map(g => { const c = byGoal[g.goal];
      return `<div class="sdg-tile ${c ? '' : 'off'}" style="background:${g.color}" data-tip="${c ? esc(c.reasons.map(r => `${r.name}: ${r.text}`).join('\n')) : 'Not linked to this path'}">
        <span class="n">${g.goal}</span>${c ? `<span class="pct">${c.share}%</span>` : ''}<span class="t">${esc(g.name)}</span></div>`; }).join('')}</div>
    <p class="small muted" style="margin-top:8px">% = contribution relative to the strongest goal on this path (role links count 3 points, each skill link 0.5–2.5 points by how much you learn).</p>
  </section>
  <section class="card"><h3>Why each goal is linked</h3>
    ${contrib.map(c => `<div style="margin-bottom:10px">${sdgBadge(c.goal)}
      ${c.reasons.map(r => `<p class="reason">${esc(r.text)} <em>— ${fromLabel[r.from]}: ${esc(r.name)}</em></p>`).join('')}</div>`).join('')}
  </section>`;
}

// ---------- HR team view ----------
function viewTeam() {
  const sn = snap();
  const rows = E.teamAnalysis(S.team, S.data, sn, S.scenario);
  const high = rows.filter(r => r.risk?.level === 'high').length;
  const totalHours = rows.reduce((a, r) => a + r.path.totalHours, 0);
  const freq = {};
  rows.forEach(r => r.role.skills.forEach(s => { freq[s.id] = (freq[s.id] || 0) + s.weight; }));
  const cols = Object.keys(freq).sort((a, b) => freq[b] - freq[a]).slice(0, 11);
  const teamSdg = {};
  rows.forEach(r => E.sdgContribution(r.employee, r.role, r.path, S.data).forEach(c => { teamSdg[c.goal] = (teamSdg[c.goal] || 0) + c.points; }));
  const sdgList = Object.entries(teamSdg).sort((a, b) => b[1] - a[1]);
  const sdgMax = sdgList[0]?.[1] || 1;
  const roleCount = {};
  rows.forEach(r => { roleCount[r.role.id] = (roleCount[r.role.id] || 0) + 1; });

  return `
  <div class="head"><div><h1>${t('t_title')}</h1><p>${esc(S.team.company)} · ${esc(S.team.department)}. ${t('t_sub')}</p></div>
    <button class="btn small ghost" data-act="export-csv">${t('t_export')}</button></div>
  <div class="grid g4">
    <div class="card stat"><div class="label">${t('t_emp')}</div><div class="value num">${rows.length}</div><div class="sub">synthetic profiles</div></div>
    <div class="card stat"><div class="label">${t('t_high')}</div><div class="value num">${high}</div><div class="sub">AI exposure ${t('exposure_high').toLowerCase()} (${t('sc_' + S.scenario)})</div></div>
    <div class="card stat"><div class="label">${t('t_hours')}</div><div class="value num">~${totalHours.toLocaleString()}</div><div class="sub">avg ${Math.round(rows.reduce((a, r) => a + r.path.weeks, 0) / rows.length)} weeks per person</div></div>
    <div class="card stat"><div class="label">Target roles</div><div class="value num">${Object.keys(roleCount).length}</div><div class="sub">${Object.entries(roleCount).map(([id, n]) => `${esc(S.roleById[id].title)} ×${n}`).join(', ')}</div></div>
  </div>
  <section class="card"><h3>${t('t_heat')}</h3>
    <div class="legend"><span><i style="background:var(--seq0)"></i>0 none</span><span><i style="background:var(--seq1)"></i>1 basic</span><span><i style="background:var(--seq2)"></i>2 working</span><span><i style="background:var(--seq3)"></i>3 advanced</span><span><i style="box-shadow:inset 0 0 0 2px var(--fall)"></i>gap for the recommended role</span></div>
    <div class="table-wrap"><table class="heat"><thead><tr><th></th>${cols.map(id => `<th class="col">${esc(S.skillById[id].name)}</th>`).join('')}</tr></thead><tbody>
      ${rows.map(r => `<tr><td class="rowlbl">${esc(r.employee.name)}<div class="small muted">→ ${esc(r.role.title)}</div></td>${cols.map(id => {
        const lvl = r.employee.skills[id] || 0; const req = r.role.skills.find(s => s.id === id);
        const gap = req && lvl < req.level;
        return `<td class="l${lvl} ${gap ? 'need' : ''}" data-tip="${esc(`${r.employee.name} · ${S.skillById[id].name}\nNow: ${levelName(lvl)}${req ? `\n${r.role.title} needs: ${levelName(req.level)}` : '\nNot required for recommended role'}`)}">${lvl}${gap ? `<span class="sr-only"> gap, needs ${req.level}</span>` : ''}</td>`; }).join('')}</tr>`).join('')}
    </tbody></table></div>
  </section>
  <section class="card"><h3>Reskilling plan by employee</h3><div class="table-wrap"><table><thead><tr><th>Employee</th><th>Current role</th><th>AI exposure</th><th>Recommended role</th><th class="num">Match</th><th>Main gaps</th><th class="num">Hours</th><th class="num">Weeks</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${esc(r.employee.name)}</td><td>${esc(S.roleById[r.employee.currentRole].title)}</td><td>${r.risk ? riskTag(r.risk.level) : '—'}</td><td>${esc(r.role.title)}</td><td class="num">${r.best.score}</td><td>${r.best.gaps.slice(0, 3).map(g => esc(S.skillById[g.id].name)).join(', ')}</td><td class="num">${r.path.totalHours}</td><td class="num">${r.path.weeks}</td></tr>`).join('')}
  </tbody></table></div>
  <p class="small muted">Weeks use each employee's own available hours. Use this for conversations and L&amp;D budgeting (check HRD Corp claimability), never for hiring or dismissal decisions.</p></section>
  <section class="card"><h3>Team SDG contribution after reskilling</h3>
    ${sdgList.map(([g, pts]) => { const s = S.sdgByGoal[g]; return `<div class="dbar" style="cursor:default;grid-template-columns:minmax(120px,260px) 1fr 54px"><span class="lbl">SDG ${g} · ${esc(s.name)}</span><span class="track plain"><span class="bar" style="left:0;width:${pts / sdgMax * 100}%;background:${s.color};border-radius:0 4px 4px 0"></span></span><span class="val">${Math.round(pts)}</span></div>`; }).join('')}
    <p class="small muted">Sum of contribution points across all employees' recommended paths.</p></section>`;
}

// ---------- Data & method ----------
function runFairnessCheck() {
  const sn = snap();
  const variants = [{ age: 23, gender: 'female', ethnicity: 'A', years: 1 }, { age: 58, gender: 'male', ethnicity: 'B', years: 35 }, { age: 41, gender: 'non-binary', ethnicity: 'C', years: 15, disability: true }];
  return S.profiles.map(p => {
    const base = JSON.stringify(Object.keys(E.SCENARIOS).map(sc => E.rankRoles(p, S.data, sn, sc)));
    const pass = variants.every(v => JSON.stringify(Object.keys(E.SCENARIOS).map(sc => E.rankRoles({ ...p, ...v }, S.data, sn, sc))) === base);
    return { name: p.name, pass };
  });
}

function viewMethod() {
  const sn = snap();
  const ctx = S.context;
  const fair = S.fairness;
  return `
  <div class="head"><div><h1>${t('d_title')}</h1><p>Every number on every screen comes from one of these sources, a documented assumption, or your own input.</p></div></div>
  <section class="card"><h2>Sources in snapshot ${esc(sn.id)}</h2>
    <p class="small muted">${esc(sn.note)} Generated ${fmtDate(sn.generatedAt)}.</p>
    <div class="table-wrap"><table><thead><tr><th>Source</th><th>What it measures</th><th>Date / window</th><th>Volume</th></tr></thead><tbody>
      ${sn.sources.map(s => `<tr><td>${sourceLink(s)}</td><td>${esc(s.kind)}</td><td class="num">${s.window ? `recent ${s.window.recent.join(' → ')}<br>prior ${s.window.prior.join(' → ')}` : s.published ? `published ${s.published}` : fmtDate(s.retrievedAt)}</td><td class="num">${s.totals ? `${(s.totals.recent + s.totals.prior).toLocaleString()} stories` : s.postings ? `${s.postings.toLocaleString()} postings` : '—'}</td></tr>`).join('')}
      ${ctx ? `<tr><td>${sourceLink(ctx.source)}</td><td>Malaysian labour-market context (<code>${ctx.labourForce.dataset}</code>, <code>${ctx.skillsUnderemployment?.dataset || ''}</code>)</td><td class="num">${ctx.labourForce.date}</td><td class="num">—</td></tr>` : ''}
      <tr><td>Problem-statement context</td><td>Hays Asia Salary Guide 2025 (56% use AI, 26% trained); MOSTI (600,000+ workers to reskill) — as cited by the organiser</td><td class="num">2025</td><td class="num">—</td></tr>
    </tbody></table></div>
    <h3 style="margin-top:12px">Snapshot history</h3>
    <p class="small">${S.snapIndex.map(s => `<code>${esc(s.id)}</code> (${s.mode})`).join(' · ')}. Refresh with <code>npm run refresh</code>, the button above, or the scheduled GitHub Action.</p>
  </section>
  <section class="card"><h2>How the scores are calculated</h2>
    <h3>Skill trend index (−100 … +100)</h3>
    <ul class="small">
      <li><strong>WEF baseline</strong> (weight ${E.TREND_WEIGHTS.wef}): +1 / 0 / −1 only where the WEF Future of Jobs Report 2025 names the skill or a job built on it.</li>
      <li><strong>Discussion momentum</strong> (weight ${E.TREND_WEIGHTS.momentum}): log₂ change in the share of Hacker News stories mentioning the skill (last 180 days vs the 180 before), minus the median of all tracked topics, scaled to ±1 and shrunk toward 0 when volume is low.</li>
      <li><strong>Job-ad demand</strong> (weight ${E.TREND_WEIGHTS.demand}): share of live postings mentioning the skill, converted to a percentile among tracked skills (±1).</li>
      <li>Missing components are dropped and the weights re-normalised; the uncertainty range widens.</li>
      <li><strong>Scenario</strong>: index = 100 × clamp(0.65 × signals + 0.35 × k × (AI complement − AI exposure)), with k = ${Object.values(E.SCENARIOS).map(s => `${s.k} (${s.label})`).join(', ')}.</li>
    </ul>
    <h3>Role match score (0 … 100)</h3>
    <ul class="small">
      <li><strong>Skills fit</strong> (× ${E.MATCH_WEIGHTS.skills} in the moderate scenario): weighted share of required skill levels you already have (partial credit per level). Each requirement is down-weighted by 1 − 0.35 × k × AI exposure (floor 0.25), so in faster scenarios the AI-resilient parts of a role count more.</li>
      <li><strong>Role outlook</strong> (× ${E.MATCH_WEIGHTS.outlook}): 40% WEF job outlook + 60% weighted trend of the role's skills, rescaled 0–100.</li>
      <li><strong>Interest fit</strong> (× ${E.MATCH_WEIGHTS.interest}): 100 if the role is in a sector you chose, otherwise 0.</li>
      <li><strong>Scenario weights</strong> (skills / outlook / interest): ${Object.values(E.SCENARIOS).map(s => `${s.label} ${s.match.skills} / ${s.match.outlook} / ${s.match.interest}`).join('; ')}. When change is slow, what you can do today matters most; when it is fast, a role's outlook matters more.</li>
    </ul>
    <h3>Pathway</h3>
    <p class="small">Each gap (plus missing prerequisites) is ordered prerequisites-first, then by importance to the role and trend. For each skill we pick the listed resource that reaches the target level, preferring free, then shortest. When no listed course reaches the level, the step says so instead of inventing one.</p>
  </section>
  <section class="card"><h2>AI models (RunPod)</h2>
    <p class="small">Three optional models run on RunPod Serverless. Each has a transparent fallback, so the app works fully without them. None of them changes a score.</p>
    <div class="ai-grid">${[['skills', '📄 Skill extraction', 'Reads CVs and maps them to the skills taxonomy. Output is filtered to known skills and shown for review before saving.'],
      ['forecast', '🔮 Trend forecasting', 'Projects each skill\'s trend index forward from the snapshot history.'],
      ['llm', '✨ Plain-language explanations', 'Rewrites a match as a short explanation. It only sees facts computed by the engine, never free text.']].map(([k, title, what]) => {
        const m = S.ai?.[k];
        return `<div class="ai-card ${m?.connected ? 'on' : ''}"><strong>${title}</strong><p class="small" style="margin:4px 0">${what}</p>
          <div class="small">${m?.connected ? `<span class="status rising">● Connected</span>${m.model ? ` · ${esc(m.model)}` : ''}` : `<span class="status stable">○ Fallback:</span> ${esc(m?.fallback || (k === 'llm' ? 'template sentences' : k === 'forecast' ? 'damped linear trend' : 'keyword matching'))}`}</div></div>`;
      }).join('')}</div>
  </section>
  <section class="card"><h2>Guardrails</h2>
    <ul class="small">
      <li><strong>Language models never score.</strong> Scores come only from the formulas above. The optional LLM only rephrases facts computed by the engine; the skill-extraction model's output is filtered to the taxonomy and confirmed by the user. Without the models, CV reading is keyword matching, so nothing can invent skills, jobs, courses or statistics.</li>
      <li>Jobs, skills and courses come from curated, public lists (<code>public/data/*.json</code>), each with a source or URL. Course hours are labelled planning estimates.</li>
      <li>Assumptions (AI exposure / complement per skill) are shown as assumptions, never as data.</li>
      <li>Human-centred: the tool suggests and explains; people decide. It is not for hiring, firing or ranking employees against each other.</li>
      <li>Privacy: profiles stay in your browser (localStorage). A CV is read in the browser unless the skill-extraction model is connected; then its text is sent to the server and RunPod to be read, and is not stored. Demo profiles and the HR team are synthetic.</li>
    </ul>
  </section>
  <section class="card"><h2>Fairness check</h2>
    <p class="small">Age, gender, ethnicity, religion and disability are never collected, and years of experience (an age proxy) is not used for scoring. This live test injects such attributes into each persona and checks that the rankings stay identical in every scenario.</p>
    <button class="btn small" data-act="fair-check">Run fairness check</button>
    ${fair ? `<table style="margin-top:8px"><tbody>${fair.map(f => `<tr><td>${esc(f.name)}</td><td>${f.pass ? '<span class="status rising">✓ PASS — identical rankings</span>' : '<span class="status declining">✗ FAIL</span>'}</td></tr>`).join('')}</tbody></table>` : ''}
  </section>
  <section class="card"><h2>AI-exposure assumptions</h2>
    <details><summary>Show the per-skill assumptions</summary><div class="table-wrap"><table><thead><tr><th>Skill</th><th class="num">AI exposure</th><th class="num">AI complement</th><th>WEF note</th></tr></thead><tbody>
      ${S.data.skills.map(s => `<tr><td>${esc(s.name)}</td><td class="num">${s.aiExposure.toFixed(2)}</td><td class="num">${s.aiComplement.toFixed(2)}</td><td class="small">${esc(s.wef.note)}</td></tr>`).join('')}
    </tbody></table></div></details>
  </section>
  <section class="card"><h2>Known limitations</h2>
    <ul class="small">
      <li>The live job feeds are global/EU boards, not Malaysia-specific; next step is MyFutureJobs or partner job data.</li>
      <li>Hacker News reflects the tech community's attention, a leading but noisy indicator. Human and routine skills are not tracked there.</li>
      <li>Skill and role names are in English; the interface is translated.</li>
      <li>All predictions are estimates. The scenarios show a range, not a forecast.</li>
    </ul>
  </section>`;
}

// ---------- events ----------
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 6000);
}

async function setSnapshot(id) {
  if (!S.snaps[id]) S.snaps[id] = await getJSON(`data/snapshots/${id}.json`);
  const prev = prevIdFor(id);
  if (prev && !S.snaps[prev]) S.snaps[prev] = await getJSON(`data/snapshots/${prev}.json`).catch(() => null);
  S.snapId = id;
}
const prevIdFor = id => { const i = S.snapIndex.findIndex(s => s.id === id); return i > 0 ? S.snapIndex[i - 1].id : null; };

async function refreshLive() {
  const btn = $('#refresh');
  btn.disabled = true; btn.textContent = t('refreshing');
  try {
    const before = hasProfile() ? E.rankRoles(S.profile, S.data, snap(), S.scenario)[0].roleId : null;
    const r = await fetch('api/refresh', { method: 'POST' });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || r.statusText);
    S.snapIndex = body.index;
    S.snaps[body.snapshot.id] = body.snapshot;
    S.context = await getJSON('data/context/malaysia.json').catch(() => S.context);
    await setSnapshot(body.snapshot.id);
    let msg = `New snapshot ${body.snapshot.id} loaded.`;
    if (before) {
      const after = E.rankRoles(S.profile, S.data, snap(), S.scenario)[0].roleId;
      msg += after === before ? ' Your top recommendation is unchanged.' : ` Your top role changed: ${S.roleById[before].title} → ${S.roleById[after].title}.`;
    }
    toast(msg);
  } catch (e) { toast('Refresh failed: ' + e.message); }
  render();
}

function exportCsv() {
  const rows = E.teamAnalysis(S.team, S.data, snap(), S.scenario);
  const lines = [['employee', 'current_role', 'ai_exposure', 'recommended_role', 'match', 'gaps', 'hours', 'weeks', 'scenario', 'snapshot']];
  rows.forEach(r => lines.push([r.employee.name, S.roleById[r.employee.currentRole].title, r.risk?.level || '', r.role.title, r.best.score, r.best.gaps.map(g => S.skillById[g.id].name).join('; '), r.path.totalHours, r.path.weeks, S.scenario, S.snapId]));
  const csv = lines.map(l => l.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `team-reskilling-${S.snapId}-${S.scenario}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const rerender = () => { const y = window.scrollY; render(); window.scrollTo(0, y); };

function loadPersona(pp) {
  S.profile = cloneProfile(pp);
  S.persona = pp.id; S.selectedRole = null; S.explain = {};
  store.set('persona', pp.id); store.set('role', null); saveProfile();
}

function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el || el.type === 'checkbox' || el.disabled) return;
  const { act, id } = el.dataset;
  const d = S.ob.draft;
  const toggle = (arr, v) => arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];
  switch (act) {
    case 'ob': // switch profile flow: '' = summary, 'choose', 'form', 'cv', 'samples', 'edit'
      S.ob = { mode: id || null, step: 0, draft: id === 'edit' ? cloneProfile(S.profile) : emptyProfile(), cv: freshCv() };
      render(); return window.scrollTo(0, 0);
    case 'persona':
      loadPersona(S.profiles.find(x => x.id === id));
      S.ob = { mode: null, step: 0, draft: null, cv: freshCv() };
      toast(`✓ ${S.profile.name} loaded`);
      render(); return window.scrollTo(0, 0);
    case 'f-step': S.ob.step = +el.dataset.n; render(); return window.scrollTo(0, 0);
    case 'd-role': d.currentRole = id; break;
    case 'd-sector': d.sectors = toggle(d.sectors, id); break;
    case 'd-skill': if (d.skills[id]) delete d.skills[id]; else d.skills[id] = 1; break;
    case 'd-lvl': d.skills[id] = +el.dataset.n; break;
    case 'd-add': { const v = $('#d-add')?.value; if (!v) return; d.skills[v] = 1; break; }
    case 'd-save': return saveDraft();
    case 'cv-analyse': S.ob.cv.text = $('#cvtext')?.value || S.ob.cv.text; S.ob.cv.fileName = ''; return analyseCv();
    case 'cv-restart': S.ob.cv.stage = 'input'; break;
    case 'explain': return explainRole(id);
    case 'forecast': return forecastSkill(id);
    case 'radar-mode': S.radarMode = id; break;
    case 'skill': S.selSkill = id; break;
    case 'choose-role': e.preventDefault(); S.selectedRole = id; store.set('role', id); location.hash = 'pathway'; return;
    case 'fair-check': S.fairness = runFairnessCheck(); break;
    case 'export-csv': return exportCsv();
    case 'print': return window.print();
    default: return;
  }
  rerender();
}

function onChange(e) {
  const el = e.target;
  if (el.id === 'lang') { setLang(el.value); store.set('lang', el.value); S.explain = {}; return render(); }
  if (el.id === 'snapshot') { S.explain = {}; S.forecast = {}; return setSnapshot(el.value).then(render); }
  if (el.id === 'cvfile' && el.files[0]) return handleCvFile(el.files[0]);
  if (el.id === 'd-add' && el.value) { S.ob.draft.skills[el.value] = 1; return rerender(); }
  if (el.dataset.draft === 'currentRole') { S.ob.draft.currentRole = el.value; return; }
  if (el.dataset.act === 'step-done') {
    const role = el.dataset.role;
    S.progress[role] = { ...(S.progress[role] || {}), [el.dataset.id]: el.checked };
    store.set('progress', S.progress);
    rerender();
    if (el.checked) toast(`🏅 Badge earned: ${S.skillById[el.dataset.id].name}`);
    return;
  }
  if (el.dataset.bind === 'target') { S.selectedRole = el.value; store.set('role', el.value); return render(); }
}

function onInput(e) {
  const el = e.target;
  if (el.dataset.draft === 'name') S.ob.draft.name = el.value;
  if (el.dataset.draft === 'hoursPerWeek') { S.ob.draft.hoursPerWeek = +el.value; $('#hoursval').textContent = el.value; }
  if (el.id === 'cvtext') S.ob.cv.text = el.value;
}

function setupDrop() {
  const zone = e => e.target.closest?.('.drop');
  document.addEventListener('dragover', e => { const z = zone(e); if (z) { e.preventDefault(); z.classList.add('over'); } });
  document.addEventListener('dragleave', e => zone(e)?.classList.remove('over'));
  document.addEventListener('drop', e => {
    const z = zone(e); if (!z) return;
    e.preventDefault(); z.classList.remove('over');
    if (e.dataTransfer.files[0]) handleCvFile(e.dataTransfer.files[0]);
  });
}

function setupTooltip() {
  const tip = $('#tooltip');
  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-tip]');
    if (!el) { tip.hidden = true; return; }
    tip.textContent = el.dataset.tip; tip.hidden = false;
  });
  document.addEventListener('mousemove', e => {
    if (tip.hidden) return;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > innerHeight - 8) y = e.clientY - h - pad;
    tip.style.left = Math.max(8, x) + 'px'; tip.style.top = Math.max(8, y) + 'px';
  });
  document.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });
}

// ---------- boot ----------
async function init() {
  setLang(store.get('lang', (navigator.language || 'en').startsWith('ms') ? 'ms' : (navigator.language || '').startsWith('zh') ? 'zh' : 'en'));
  const [skills, roles, res, sdgs, profiles, team, index] = await Promise.all(
    ['skills', 'roles', 'resources', 'sdgs', 'profiles', 'team', 'snapshots/index'].map(f => getJSON(`data/${f}.json`)));
  S.data = { skills: skills.skills, roles: roles.roles, resources: res.resources };
  S.meta = { levels: skills.levels, categories: skills.categories, sectors: roles.sectors };
  S.local = res.local; S.sdgs = sdgs; S.profiles = profiles.profiles; S.team = team;
  S.skillById = Object.fromEntries(S.data.skills.map(s => [s.id, s]));
  S.roleById = Object.fromEntries(S.data.roles.map(r => [r.id, r]));
  S.sdgByGoal = Object.fromEntries(sdgs.map(g => [g.goal, g]));
  S.snapIndex = index;
  S.context = await getJSON('data/context/malaysia.json').catch(() => null);
  const latestLive = [...index].reverse().find(s => s.mode === 'live') || index[index.length - 1];
  await setSnapshot(latestLive.id);
  const status = await fetch('api/status').then(r => r.ok ? r.json() : null).catch(() => null);
  S.api = !!status; S.ai = status?.ai || null;
  // Demo shortcut: ?persona=aisyah&lang=ms
  const qs = new URLSearchParams(location.search);
  const pp = S.profiles.find(x => x.id === qs.get('persona'));
  if (pp) loadPersona(pp);
  if (qs.get('lang')) setLang(qs.get('lang'));

  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role=button][data-act]')) { e.preventDefault(); e.target.click(); } });
  $('#refresh').addEventListener('click', refreshLive);
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); $('#view').focus({ preventScroll: true }); });
  setupTooltip();
  setupDrop();
  render();
}

init().catch(err => {
  $('#view').innerHTML = `<div class="card"><h2>Could not load data</h2><p>${esc(err.message)}</p><p>Run <code>npm start</code> and open <a href="http://localhost:3000">http://localhost:3000</a>.</p></div>`;
});
