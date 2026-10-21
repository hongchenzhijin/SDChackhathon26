import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as E from '../public/js/engine.js';

const load = f => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url), 'utf8'));
const data = { skills: load('skills.json').skills, roles: load('roles.json').roles, resources: load('resources.json').resources };
const profiles = load('profiles.json').profiles;
const index = load('snapshots/index.json');
const live = load(`snapshots/${index.filter(s => s.mode === 'live').at(-1).id}.json`);

test('taxonomy is internally consistent', () => {
  const ids = new Set(data.skills.map(s => s.id));
  for (const r of data.roles) for (const s of r.skills) assert.ok(ids.has(s.id), `${r.id} uses unknown skill ${s.id}`);
  for (const s of data.skills) for (const p of s.prereqs) assert.ok(ids.has(p), `${s.id} has unknown prereq ${p}`);
  for (const r of data.resources) for (const id of Object.keys(r.teaches)) assert.ok(ids.has(id), `${r.id} teaches unknown ${id}`);
});

test('every skill and future role is tagged to at least one SDG', () => {
  for (const s of data.skills) assert.ok(s.sdgs.length && s.sdgs.every(g => g.goal >= 1 && g.goal <= 17 && g.why), s.id);
  for (const r of data.roles.filter(r => r.type === 'future')) assert.ok(r.sdgs.length && r.sdgs.every(g => g.why), r.id);
});

test('every skill a future role needs has at least one learning resource', () => {
  const taught = new Set(data.resources.flatMap(r => Object.keys(r.teaches)));
  for (const r of data.roles.filter(r => r.type === 'future')) for (const s of r.skills) assert.ok(taught.has(s.id), `no resource for ${s.id}`);
});

test('every resource has a real https URL and an explicit cost', () => {
  for (const r of data.resources) {
    assert.match(r.url, /^https:\/\//, r.id);
    assert.ok(['free', 'audit', 'low'].includes(r.cost), r.id);
  }
});

test('snapshot cites its sources with dates', () => {
  assert.ok(live.sources.length >= 2);
  for (const s of live.sources) {
    assert.ok(s.name && s.url, s.id);
    assert.ok(s.window || s.published || s.retrievedAt, `${s.id} has no date`);
  }
});

test('trend index stays within bounds and has an uncertainty range', () => {
  for (const sc of Object.keys(E.SCENARIOS)) {
    for (const [id, tr] of Object.entries(E.trendTable(data, live, sc))) {
      assert.ok(tr.index >= -100 && tr.index <= 100, id);
      assert.ok(tr.low <= tr.index && tr.index <= tr.high, id);
    }
  }
});

test('faster disruption pushes AI-exposed routine skills further down', () => {
  const slow = E.trendTable(data, live, 'slow'), fast = E.trendTable(data, live, 'fast');
  for (const id of ['data_entry', 'cash_handling', 'admin_support']) assert.ok(fast[id].index < slow[id].index, id);
  for (const id of ['llm_engineering', 'responsible_ai']) assert.ok(fast[id].index > slow[id].index, id);
});

test('scenarios produce genuinely different rankings, not one prediction', () => {
  const differs = profiles.some(p => {
    const order = sc => E.rankRoles(p, data, live, sc).slice(0, 8).map(m => m.roleId).join();
    return order('slow') !== order('fast');
  });
  assert.ok(differs);
});

test('output changes when trend data changes', () => {
  const p = profiles[0];
  const tweaked = structuredClone(live);
  // Simulate new data: discussion of fintech collapses and it vanishes from job ads.
  tweaked.skills.fintech.hn.recent = 0;
  tweaked.skills.fintech.jobs = { mentions: 0, total: tweaked.skills.fintech.jobs.total, share: 0 };
  const before = E.rankRoles(p, data, live, 'moderate').find(m => m.roleId === 'fintech_analyst').score;
  const after = E.rankRoles(p, data, tweaked, 'moderate').find(m => m.roleId === 'fintech_analyst').score;
  assert.ok(after < before, `${after} should be < ${before}`);
});

test('match score explanation adds up to the score', () => {
  for (const p of profiles) {
    for (const m of E.rankRoles(p, data, live, 'moderate')) {
      const sum = Object.values(m.parts).reduce((a, x) => a + x.value * x.weight, 0);
      assert.ok(Math.abs(sum - m.score) <= 1.5, `${p.id}/${m.roleId}: ${sum} vs ${m.score}`);
    }
  }
});

test('fairness: protected attributes and years of experience do not change rankings', () => {
  for (const p of profiles) {
    for (const sc of Object.keys(E.SCENARIOS)) {
      const base = E.rankRoles(p, data, live, sc);
      for (const extra of [{ age: 22, gender: 'female' }, { age: 60, gender: 'male', ethnicity: 'x', years: 40 }]) {
        assert.deepEqual(E.rankRoles({ ...p, ...extra }, data, live, sc), base);
      }
    }
  }
});

test('pathway closes every gap, orders prerequisites first, uses only listed resources', () => {
  const resIds = new Set(data.resources.map(r => r.id));
  for (const p of profiles) {
    const top = E.rankRoles(p, data, live, 'moderate')[0];
    const role = data.roles.find(r => r.id === top.roleId);
    const pw = E.buildPathway(p, role, data, live, 'moderate');
    for (const g of top.gaps) assert.ok(pw.steps.some(s => s.skillId === g.id && s.to >= g.need), `${p.id}: gap ${g.id} not covered`);
    const pos = Object.fromEntries(pw.steps.map((s, i) => [s.skillId, i]));
    for (const s of pw.steps) for (const pre of data.skills.find(x => x.id === s.skillId).prereqs) if (pre in pos) assert.ok(pos[pre] < pos[s.skillId], `${pre} before ${s.skillId}`);
    for (const s of pw.steps) for (const r of s.resources) assert.ok(resIds.has(r.id));
    assert.ok(pw.totalHours > 0 && pw.weeks > 0);
  }
});

test('CV extraction finds skills with evidence from the synthetic CV', () => {
  const cv = readFileSync(new URL('../public/samples/cv-aisyah.txt', import.meta.url), 'utf8');
  const found = E.extractSkillsFromText(cv, data.skills);
  for (const id of ['customer_service', 'cash_handling', 'spreadsheets', 'ai_literacy', 'fintech']) assert.ok(found[id], `missing ${id}`);
  for (const f of Object.values(found)) assert.ok(f.evidence.length > 0);
});

test('SDG contribution covers the role goals', () => {
  const p = profiles[1];
  const role = data.roles.find(r => r.id === 'renewable_technician');
  const contrib = E.sdgContribution(p, role, E.buildPathway(p, role, data, live, 'moderate'), data);
  for (const g of role.sdgs) assert.ok(contrib.some(c => c.goal === g.goal));
});
