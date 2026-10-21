// Shared by the browser and server.js: the facts an explanation may use, and the
// transparent fallbacks used whenever the RunPod models are not connected.
// Pure functions, no DOM, no network.
import * as E from './engine.js';

const round = (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---------- 1. Facts for a plain-language explanation ----------
// The LLM only ever sees this object, computed by the engine — never free text from the user —
// so it can rephrase the result but cannot invent courses, jobs or numbers.
export function buildExplainFacts(profile, roleId, data, snapshot, scenario = 'moderate') {
  const skillById = Object.fromEntries(data.skills.map(s => [s.id, s]));
  const roleById = Object.fromEntries(data.roles.map(r => [r.id, r]));
  const role = roleById[roleId];
  if (!role || role.type !== 'future') throw Object.assign(new Error('Unknown future role'), { code: 400 });
  const ranked = E.rankRoles(profile, data, snapshot, scenario);
  const rank = ranked.findIndex(m => m.roleId === roleId);
  const m = ranked[rank];
  const matrix = E.scenarioMatrix(profile, data, snapshot)[roleId];
  const risk = E.currentRoleRisk(profile, data, snapshot, scenario);
  const pw = E.buildPathway(profile, role, data, snapshot, scenario);
  const level = n => ['none', 'basic', 'working', 'advanced'][n];
  return {
    name: profile.name || null,
    currentRole: roleById[profile.currentRole]?.title || null,
    currentRoleExposure: risk ? risk.level : null,
    targetRole: role.title,
    roleSummary: role.summary,
    scenario,
    snapshotDate: snapshot.asOf,
    rank: rank + 1,
    score: m.score,
    scoreRange: [matrix.min, matrix.max],
    robustAcrossScenarios: matrix.robust,
    parts: {
      skillsFit: m.parts.skills.value,
      outlook: m.parts.outlook.value,
      outlookTrendIndex: m.parts.outlook.index,
      interestMatch: m.parts.interest.sectorHit
    },
    skillsYouHave: m.have.map(h => skillById[h.id].name),
    skillGaps: m.gaps.map(g => ({ skill: skillById[g.id].name, from: level(g.have), to: level(g.need) })),
    pathway: {
      weeks: pw.weeks, totalHours: pw.totalHours, hoursPerWeek: pw.hoursPerWeek, allFree: pw.allFree,
      firstSteps: pw.steps.slice(0, 3).map(s => ({
        skill: skillById[s.skillId].name,
        courses: s.resources.filter(r => !r.reused).map(r => `${r.title} (${r.provider})`)
      }))
    },
    sdgs: role.sdgs.map(g => g.goal)
  };
}

// ---------- 2. Template explanation (fallback when no LLM is connected) ----------
export function templateExplanation(f) {
  const who = f.name ? `${f.name}, ` : '';
  const list = (xs, n = 3) => xs.slice(0, n).join(', ') + (xs.length > n ? ` and ${xs.length - n} more` : '');
  const out = [];
  out.push(`${who}${f.targetRole} is your #${f.rank} match with a score of ${f.score}/100 (between ${f.scoreRange[0]} and ${f.scoreRange[1]} depending on how fast AI changes work).`);
  if (f.skillsYouHave.length) out.push(`You already bring ${list(f.skillsYouHave)}, which ${f.skillsYouHave.length === 1 ? 'counts' : 'count'} toward this role.`);
  if (f.skillGaps.length) out.push(`To get there you would build ${list(f.skillGaps.map(g => `${g.skill} (${g.from} → ${g.to})`))}.`);
  else out.push('You already meet every skill requirement — a portfolio project is the next step.');
  out.push(f.parts.outlookTrendIndex >= 15
    ? 'Demand for this role is growing in the current trend data.'
    : f.parts.outlookTrendIndex <= -15 ? 'The trend data shows softer demand for this role, so weigh it carefully.' : 'Demand for this role is steady in the current trend data.');
  if (f.robustAcrossScenarios) out.push('It stays in your top 5 under slow, moderate and fast AI disruption, which makes it a safer bet.');
  if (f.pathway.weeks) out.push(`At ${f.pathway.hoursPerWeek} hours a week, the learning plan takes about ${f.pathway.weeks} weeks (~${f.pathway.totalHours} hours)${f.pathway.allFree ? ' using free or free-to-audit courses' : ''}.`);
  out.push('This is an estimate to support your decision — talk it through with a career advisor or your HR team.');
  return out.join(' ');
}

export function explainPrompt(f, lang = 'en') {
  const language = { en: 'English', ms: 'Bahasa Malaysia', zh: 'Simplified Chinese' }[lang] || 'English';
  return [
    { role: 'system', content:
      'You are a careful career coach. Write a warm, plain-language explanation (120-170 words, no headings, no bullet lists) ' +
      'of why a future role was recommended to a person and what they would need to learn. ' +
      'Use ONLY the facts in the JSON the user provides. Do not invent courses, salaries, statistics, employers or skills. ' +
      'Keep skill, role and course names exactly as given. Say that the result is an estimate, and end by encouraging them ' +
      `to discuss it with a career advisor or HR. Reply in ${language}.` },
    { role: 'user', content: JSON.stringify(f) }
  ];
}

// ---------- 3. Trend history and naive forecast (fallback when no forecasting model is connected) ----------
export function trendHistory(data, snapshots, scenario = 'moderate') {
  const sorted = [...snapshots].sort((a, b) => a.asOf.localeCompare(b.asOf));
  const tables = sorted.map(sn => ({ asOf: sn.asOf, table: E.trendTable(data, sn, scenario) }));
  return Object.fromEntries(data.skills.map(s => [s.id, tables.map(t => ({ asOf: t.asOf, index: t.table[s.id].index }))]));
}

const monthsBetween = (a, b) => (new Date(b) - new Date(a)) / (30.44 * 86400000);

// Damped linear extrapolation with a widening band. Deliberately simple and labelled as such.
export function linearForecast(history, horizonMonths = 12) {
  const last = history.at(-1);
  let slope = 0;
  if (history.length >= 2) {
    const xs = history.map(h => monthsBetween(history[0].asOf, h.asOf));
    const mx = xs.reduce((a, x) => a + x, 0) / xs.length;
    const my = history.reduce((a, h) => a + h.index, 0) / history.length;
    const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    slope = den ? xs.reduce((a, x, i) => a + (x - mx) * (history[i].index - my), 0) / den : 0;
  }
  const points = [];
  for (let m = 3; m <= horizonMonths; m += 3) {
    const damp = (1 - 0.85 ** m) / 0.15; // sum of a decaying slope: trends rarely continue linearly
    const index = clamp(last.index + slope * damp, -100, 100);
    const band = 12 + 2.5 * m + (history.length < 3 ? 10 : 0);
    const d = new Date(last.asOf); d.setMonth(d.getMonth() + m);
    points.push({ month: m, asOf: d.toISOString().slice(0, 10), index: round(index), low: round(clamp(index - band, -100, 100)), high: round(clamp(index + band, -100, 100)) });
  }
  return { slopePerMonth: round(slope, 2), points };
}

// ---------- 4. Normalising model output ----------
// Whatever a model returns, only skills that exist in the taxonomy survive, with levels clamped to 1-3.
export function normaliseExtraction(out, data) {
  const ids = new Set(data.skills.map(s => s.id));
  const roleIds = new Set(data.roles.filter(r => r.type === 'current').map(r => r.id));
  const skills = {};
  for (const s of Array.isArray(out?.skills) ? out.skills : []) {
    if (!ids.has(s?.id)) continue;
    const level = clamp(Math.round(Number(s.level) || 1), 1, 3);
    const evidence = (Array.isArray(s.evidence) ? s.evidence : [s.evidence]).filter(Boolean).slice(0, 3)
      .map(e => typeof e === 'string' ? { context: e.slice(0, 160) } : { context: String(e.context || '').slice(0, 160), keyword: e.keyword });
    skills[s.id] = { level, evidence, confidence: typeof s.confidence === 'number' ? round(s.confidence, 2) : undefined };
  }
  return {
    skills,
    name: typeof out?.name === 'string' ? out.name.slice(0, 40) : '',
    currentRole: roleIds.has(out?.currentRole) ? out.currentRole : null,
    sectors: Array.isArray(out?.sectors) ? out.sectors.filter(s => typeof s === 'string') : []
  };
}

// Keyword guess of the current role from CV text (used by the local fallback).
const ROLE_HINTS = {
  bank_teller: ['bank teller', 'teller', 'cashier (bank)'],
  data_entry_clerk: ['data entry'],
  admin_assistant: ['administrative assistant', 'admin assistant', 'secretary', 'office assistant'],
  bookkeeping_clerk: ['bookkeeper', 'bookkeeping', 'payroll', 'accounts clerk'],
  cashier: ['cashier', 'ticket clerk', 'retail assistant'],
  graphic_designer: ['graphic designer', 'graphic design'],
  customer_service_agent: ['call centre', 'call center', 'customer service agent', 'contact centre', 'customer support'],
  student: ['fresh graduate', 'student', 'undergraduate', 'internship', 'bachelor of', 'diploma in']
};
export function guessCurrentRole(text) {
  const lower = String(text || '').toLowerCase();
  let best = null, bestPos = Infinity;
  for (const [id, kws] of Object.entries(ROLE_HINTS)) for (const kw of kws) {
    const i = lower.indexOf(kw);
    if (i >= 0 && i < bestPos) { best = id; bestPos = i; }
  }
  return best;
}

export function localExtraction(text, data) {
  return { skills: E.extractSkillsFromText(text, data.skills), name: '', currentRole: guessCurrentRole(text), sectors: [] };
}
