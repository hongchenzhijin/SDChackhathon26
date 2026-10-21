// FutureReady Compass scoring engine.
// Pure functions, no DOM, no network: the same code runs in the browser and in `node --test`.
// Every number it produces can be traced back to (a) a cited source in the snapshot,
// (b) a curated, documented assumption in skills.json / roles.json, or (c) the user's own input.
// It deliberately has NO access to age, gender, ethnicity, religion or years of experience.

export const SCENARIOS = {
  slow:     { id: 'slow',     k: 0.3, label: 'Slow AI adoption',       blurb: 'AI spreads gradually; most of today\'s roles change slowly.',
              match: { skills: 0.70, outlook: 0.15, interest: 0.15 } },
  moderate: { id: 'moderate', k: 1.0, label: 'Moderate AI disruption', blurb: 'Current pace continues; routine tasks automate over 3–5 years.',
              match: { skills: 0.60, outlook: 0.25, interest: 0.15 } },
  fast:     { id: 'fast',     k: 2.0, label: 'Fast AI disruption',     blurb: 'Agentic AI is adopted quickly; AI-exposed tasks shrink sharply.',
              match: { skills: 0.45, outlook: 0.40, interest: 0.15 } }
};

// Weights of the three trend components (renormalised when one is missing).
export const TREND_WEIGHTS = { wef: 0.35, momentum: 0.35, demand: 0.30 };
// Weights of the three match components (moderate scenario). Each scenario sets its own:
// when change is slow, what you can do today matters most; when it is fast, a role's outlook matters more.
export const MATCH_WEIGHTS = SCENARIOS.moderate.match;

const clamp = (x, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, x));
const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };
const round = (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d;

// ---------- 1. Signals: raw snapshot counts -> normalised components in [-1, 1] ----------

export function computeSignals(skills, snapshot) {
  const hnSrc = snapshot.sources.find(s => s.id === 'hn');
  const totals = hnSrc?.totals;
  const raw = {};
  for (const s of skills) {
    const sig = snapshot.skills[s.id] || {};
    let logRatio = null, volume = 0;
    if (sig.hn && totals) {
      const PSEUDO = 5; // smoothing so tiny counts don't swing wildly
      const rRate = (sig.hn.recent + PSEUDO) / totals.recent;
      const pRate = (sig.hn.prior + PSEUDO) / totals.prior;
      logRatio = Math.log2(rRate / pRate);
      volume = sig.hn.recent + sig.hn.prior;
    }
    raw[s.id] = { logRatio, volume, jobs: sig.jobs, hn: sig.hn };
  }
  // Momentum is RELATIVE to the median tracked topic, so platform-wide volume drift cancels out.
  const med = median(Object.values(raw).filter(r => r.logRatio !== null).map(r => r.logRatio));
  // Job demand is a percentile rank among skills with job data.
  const shares = Object.values(raw).filter(r => r.jobs).map(r => r.jobs.share).sort((a, b) => a - b);
  const pct = v => shares.length > 1 ? shares.filter(x => x < v).length / (shares.length - 1) : 0.5;

  const out = {};
  for (const s of skills) {
    const r = raw[s.id];
    const confidence = r.logRatio === null ? 0 : Math.min(1, r.volume / 60); // shrink low-volume topics toward 0
    out[s.id] = {
      momentum: r.logRatio === null ? null : clamp((r.logRatio - med) / 1.2) * confidence,
      momentumConfidence: confidence,
      demand: r.jobs ? clamp(2 * pct(r.jobs.share) - 1) : null,
      wef: s.wef.direction,
      hn: r.hn, jobs: r.jobs
    };
  }
  return out;
}

// ---------- 2. Trend index per skill under a scenario ----------

export function skillTrend(skill, sig, scenario) {
  const parts = [['wef', sig.wef], ['momentum', sig.momentum], ['demand', sig.demand]].filter(([, v]) => v !== null && v !== undefined);
  const wsum = parts.reduce((a, [k]) => a + TREND_WEIGHTS[k], 0);
  const core = parts.reduce((a, [k, v]) => a + TREND_WEIGHTS[k] * v, 0) / wsum;
  const aiPressure = skill.aiComplement - skill.aiExposure; // +: AI raises demand, -: AI automates it
  const k = SCENARIOS[scenario].k;
  const index = clamp(0.65 * core + 0.35 * k * aiPressure) * 100;
  const missing = 3 - parts.length;
  const band = 100 * (0.08 + 0.06 * k + 0.07 * missing); // heuristic: wider when faster or when data is missing
  return {
    index: round(index),
    low: round(clamp(index / 100 - band / 100) * 100),
    high: round(clamp(index / 100 + band / 100) * 100),
    status: index >= 15 ? 'rising' : index <= -15 ? 'declining' : 'stable',
    components: {
      wef: { value: sig.wef, weight: TREND_WEIGHTS.wef / wsum },
      momentum: sig.momentum === null ? null : { value: round(sig.momentum, 2), weight: TREND_WEIGHTS.momentum / wsum },
      demand: sig.demand === null ? null : { value: round(sig.demand, 2), weight: TREND_WEIGHTS.demand / wsum },
      aiPressure: { value: round(aiPressure, 2), k }
    }
  };
}

export function trendTable(data, snapshot, scenario) {
  const sigs = computeSignals(data.skills, snapshot);
  return Object.fromEntries(data.skills.map(s => [s.id, { ...skillTrend(s, sigs[s.id], scenario), signal: sigs[s.id] }]));
}

// ---------- 3. Role outlook ----------

export function roleOutlook(role, trends) {
  const wsum = role.skills.reduce((a, s) => a + s.weight, 0) || 1;
  const skillAvg = role.skills.reduce((a, s) => a + s.weight * (trends[s.id]?.index ?? 0), 0) / wsum;
  const index = clamp((0.4 * role.wef.direction * 100 + 0.6 * skillAvg) / 100) * 100;
  return { index: round(index), fromWef: role.wef.direction * 100, fromSkills: round(skillAvg) };
}

// ---------- 4. Matching ----------

const userLevel = (profile, id) => profile.skills?.[id] || 0;

// Under faster disruption, the parts of a role that AI can automate matter less,
// so skills fit is re-weighted toward the AI-resilient skills of the role.
export const relevance = (skill, k) => clamp(1 - 0.35 * k * skill.aiExposure, 0.25, 1);

export function matchRole(profile, role, trends, skillById = {}, scenario = 'moderate') {
  const { k, match: W } = SCENARIOS[scenario];
  const w = req => req.weight * (skillById[req.id] ? relevance(skillById[req.id], k) : 1);
  const wsum = role.skills.reduce((a, s) => a + w(s), 0);
  const have = [], gaps = [];
  let fit = 0;
  for (const req of role.skills) {
    const lvl = userLevel(profile, req.id);
    const credit = Math.min(lvl / req.level, 1);
    fit += w(req) * credit;
    (lvl >= req.level ? have : gaps).push({ id: req.id, have: lvl, need: req.level, weight: req.weight });
  }
  const skillFit = fit / wsum;
  const outlook = roleOutlook(role, trends);
  const outlookScore = (outlook.index + 100) / 200;
  const sectorHit = (profile.sectors || []).some(s => role.sectors.includes(s));
  const interest = sectorHit ? 1 : 0;
  const score = 100 * (W.skills * skillFit + W.outlook * outlookScore + W.interest * interest);
  return {
    roleId: role.id,
    score: round(score),
    parts: {
      skills: { value: round(skillFit * 100), weight: W.skills },
      outlook: { value: round(outlookScore * 100), weight: W.outlook, index: outlook.index, fromWef: outlook.fromWef, fromSkills: outlook.fromSkills },
      interest: { value: round(interest * 100), weight: W.interest, sectorHit }
    },
    have, gaps
  };
}

export function rankRoles(profile, data, snapshot, scenario) {
  const trends = trendTable(data, snapshot, scenario);
  const skillById = Object.fromEntries(data.skills.map(s => [s.id, s]));
  return data.roles.filter(r => r.type === 'future')
    .map(r => matchRole(profile, r, trends, skillById, scenario))
    .sort((a, b) => b.score - a.score || a.roleId.localeCompare(b.roleId));
}

// Rank every role under every scenario: shows how robust a recommendation is.
export function scenarioMatrix(profile, data, snapshot) {
  const out = {};
  for (const sc of Object.keys(SCENARIOS)) {
    rankRoles(profile, data, snapshot, sc).forEach((m, i) => {
      (out[m.roleId] ||= {})[sc] = { rank: i + 1, score: m.score };
    });
  }
  for (const v of Object.values(out)) {
    const scores = Object.values(v).map(x => x.score);
    v.min = Math.min(...scores); v.max = Math.max(...scores);
    v.robust = Object.keys(SCENARIOS).every(sc => v[sc].rank <= 5);
  }
  return out;
}

// Exposure of the user's CURRENT role (an estimate, shown with its inputs).
export function currentRoleRisk(profile, data, snapshot, scenario) {
  const role = data.roles.find(r => r.id === profile.currentRole);
  if (!role || !role.skills.length) return null;
  const trends = trendTable(data, snapshot, scenario);
  const outlook = roleOutlook(role, trends);
  const level = outlook.index <= -30 ? 'high' : outlook.index <= 0 ? 'medium' : 'low';
  const atRisk = role.skills.map(s => ({ id: s.id, index: trends[s.id].index })).sort((a, b) => a.index - b.index);
  return { roleId: role.id, outlook, level, atRisk, wef: role.wef };
}

// ---------- 5. Reskilling pathway ----------

const COST_ORDER = { free: 0, audit: 1, low: 2 };

function pickResources(skillId, from, to, resources, used) {
  const picks = [];
  let level = from;
  // Reuse a resource already in the plan if it covers this skill.
  const reused = resources.find(r => used.has(r.id) && (r.teaches[skillId] || 0) > level);
  if (reused) { level = reused.teaches[skillId]; picks.push({ ...reused, reused: true }); }
  while (level < to) {
    const cands = resources.filter(r => !used.has(r.id) && !picks.some(p => p.id === r.id) && (r.teaches[skillId] || 0) > level);
    if (!cands.length) break;
    cands.sort((a, b) =>
      ((b.teaches[skillId] >= to) - (a.teaches[skillId] >= to)) ||   // reaches the target first
      (COST_ORDER[a.cost] - COST_ORDER[b.cost]) ||                     // then cheapest
      (a.hours - b.hours));                                            // then shortest
    const r = cands[0];
    picks.push(r);
    level = r.teaches[skillId];
  }
  return { picks, reached: level };
}

export function buildPathway(profile, role, data, snapshot, scenario) {
  const trends = trendTable(data, snapshot, scenario);
  const skillById = Object.fromEntries(data.skills.map(s => [s.id, s]));
  const need = new Map(); // skillId -> target level
  const addNeed = (id, lvl) => { if (userLevel(profile, id) < lvl && (need.get(id) || 0) < lvl) need.set(id, lvl); };
  role.skills.forEach(r => addNeed(r.id, r.level));
  // Pull in missing prerequisites at a basic level.
  for (const id of [...need.keys()]) for (const p of skillById[id].prereqs) addNeed(p, 1);

  // Order: prerequisites first (topological), then by role importance and trend.
  const weightOf = id => role.skills.find(s => s.id === id)?.weight || 0;
  const ids = [...need.keys()].sort((a, b) => weightOf(b) - weightOf(a) || trends[b].index - trends[a].index);
  const ordered = [], seen = new Set();
  const visit = id => {
    if (seen.has(id)) return; seen.add(id);
    skillById[id].prereqs.filter(p => need.has(p)).forEach(visit);
    ordered.push(id);
  };
  ids.slice().sort((a, b) => (skillById[a].prereqs.length - skillById[b].prereqs.length)).forEach(visit);
  // Keep high-weight foundation skills before low-weight extras where prerequisites allow.
  const used = new Set();
  const hpw = Math.max(1, profile.hoursPerWeek || 5);
  let cumHours = 0;
  const steps = ordered.map((id, i) => {
    const from = userLevel(profile, id), to = need.get(id);
    const { picks, reached } = pickResources(id, from, to, data.resources, used);
    picks.forEach(p => used.add(p.id));
    const courseHours = picks.filter(p => !p.reused).reduce((a, p) => a + p.hours, 0);
    const shortfall = Math.max(0, to - reached);
    const practiceHours = 4 * (to - from) + shortfall * skillById[id].hoursPerLevel;
    const hours = courseHours + practiceHours;
    const startWeek = Math.floor(cumHours / hpw) + 1;
    cumHours += hours;
    return {
      n: i + 1, skillId: id, from, to, resources: picks, courseHours, practiceHours, hours,
      shortfall, startWeek, endWeek: Math.max(startWeek, Math.ceil(cumHours / hpw)),
      trend: trends[id].index, sdgs: skillById[id].sdgs
    };
  });
  const totalHours = steps.reduce((a, s) => a + s.hours, 0);
  return {
    roleId: role.id, steps, totalHours,
    weeks: Math.ceil(totalHours / hpw), hoursPerWeek: hpw,
    allFree: steps.every(s => s.resources.every(r => r.cost === 'free' || r.cost === 'audit'))
  };
}

// ---------- 6. SDG contribution ----------

export function sdgContribution(profile, role, pathway, data) {
  const skillById = Object.fromEntries(data.skills.map(s => [s.id, s]));
  const score = {}, why = {};
  const add = (goal, pts, reason) => { score[goal] = (score[goal] || 0) + pts; (why[goal] ||= []).push(reason); };
  role.sdgs.forEach(g => add(g.goal, 3, { from: 'role', name: role.title, text: g.why }));
  // Skills the role uses (both those you already have and those you will learn).
  role.skills.forEach(req => {
    const learned = pathway.steps.find(s => s.skillId === req.id);
    skillById[req.id].sdgs.forEach(g => add(g.goal, learned ? 1 + 0.5 * (learned.to - learned.from) : 0.5,
      { from: learned ? 'new-skill' : 'skill', name: skillById[req.id].name, text: g.why }));
  });
  const max = Math.max(...Object.values(score));
  return Object.entries(score)
    .map(([goal, pts]) => ({ goal: +goal, share: round(pts / max * 100), points: round(pts, 1), reasons: why[goal] }))
    .sort((a, b) => b.points - a.points);
}

// ---------- 7. Re-planning: what changed between two snapshots ----------

export function compareSnapshots(profile, data, oldSnap, newSnap, scenario) {
  const a = trendTable(data, oldSnap, scenario), b = trendTable(data, newSnap, scenario);
  const skillMoves = data.skills.map(s => ({ id: s.id, from: a[s.id].index, to: b[s.id].index, delta: b[s.id].index - a[s.id].index }))
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  const ra = rankRoles(profile, data, oldSnap, scenario), rb = rankRoles(profile, data, newSnap, scenario);
  const roleMoves = rb.map((m, i) => {
    const j = ra.findIndex(x => x.roleId === m.roleId);
    return { roleId: m.roleId, fromRank: j + 1, toRank: i + 1, fromScore: ra[j].score, toScore: m.score };
  });
  return { skillMoves, roleMoves, topChanged: ra[0].roleId !== rb[0].roleId };
}

// ---------- 8. CV parsing (transparent keyword extraction) ----------

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function extractSkillsFromText(text, skills) {
  const found = {};
  const lower = ' ' + text.toLowerCase().replace(/\s+/g, ' ') + ' ';
  for (const s of skills) {
    const hits = [];
    for (const kw of s.cvKeywords) {
      const re = new RegExp(`(^|[^a-z0-9])${esc(kw.toLowerCase())}([^a-z0-9]|$)`, 'g');
      let m; while ((m = re.exec(lower))) {
        const start = Math.max(0, m.index - 30);
        hits.push({ keyword: kw, context: lower.slice(start, m.index + kw.length + 32).trim() });
        if (hits.length >= 3) break;
      }
    }
    if (hits.length) {
      // Level is a suggestion from evidence count only; the user confirms or edits it.
      const distinct = new Set(hits.map(h => h.keyword)).size;
      found[s.id] = { level: distinct >= 3 || hits.length >= 3 ? 2 : 1, evidence: hits.slice(0, 3) };
    }
  }
  return found;
}

// ---------- 9. Team / HR view ----------

export function teamAnalysis(team, data, snapshot, scenario) {
  const rows = team.employees.map(e => {
    const ranked = rankRoles(e, data, snapshot, scenario);
    const best = ranked[0];
    const role = data.roles.find(r => r.id === best.roleId);
    const path = buildPathway(e, role, data, snapshot, scenario);
    const risk = currentRoleRisk(e, data, snapshot, scenario);
    return { employee: e, best, role, path, risk };
  });
  return rows;
}
