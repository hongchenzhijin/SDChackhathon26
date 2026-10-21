import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import * as A from '../public/js/ai-shared.js';

const load = f => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url), 'utf8'));
const data = { skills: load('skills.json').skills, roles: load('roles.json').roles, resources: load('resources.json').resources };
const profiles = load('profiles.json').profiles;
const index = load('snapshots/index.json');
const snaps = index.map(s => load(`snapshots/${s.id}.json`));
const live = snaps.filter(s => s.mode === 'live').at(-1);

test('there are 9 sample profiles, each valid against the taxonomy', () => {
  assert.equal(profiles.length, 9);
  const skillIds = new Set(data.skills.map(s => s.id));
  const roleIds = new Set(data.roles.filter(r => r.type === 'current').map(r => r.id));
  for (const p of profiles) {
    assert.ok(roleIds.has(p.currentRole), p.id);
    for (const [id, lvl] of Object.entries(p.skills)) assert.ok(skillIds.has(id) && lvl >= 1 && lvl <= 3, `${p.id}/${id}`);
  }
});

test('model output is filtered to the taxonomy and levels are clamped', () => {
  const out = A.normaliseExtraction({
    skills: [{ id: 'python', level: 7, evidence: ['wrote Python scripts'], confidence: 0.912 }, { id: 'made_up_skill', level: 2 }, { id: 'sql', level: 0 }],
    currentRole: 'bank_teller', name: 'X'.repeat(80)
  }, data);
  assert.deepEqual(Object.keys(out.skills).sort(), ['python', 'sql']);
  assert.equal(out.skills.python.level, 3);
  assert.equal(out.skills.sql.level, 1);
  assert.equal(out.skills.python.confidence, 0.91);
  assert.equal(out.currentRole, 'bank_teller');
  assert.equal(out.name.length, 40);
  assert.equal(A.normaliseExtraction({ currentRole: 'astronaut' }, data).currentRole, null);
});

test('explanation facts and template are built for every sample profile', () => {
  for (const p of profiles) {
    for (const sc of ['slow', 'moderate', 'fast']) {
      const roleId = (p.id === 'aisyah' ? 'fintech_analyst' : 'data_analyst');
      const f = A.buildExplainFacts(p, roleId, data, live, sc);
      const text = A.templateExplanation(f);
      assert.ok(text.includes(f.targetRole) && text.includes(String(f.score)), p.id);
      const msgs = A.explainPrompt(f, 'ms');
      assert.match(msgs[0].content, /Bahasa Malaysia/);
      assert.deepEqual(JSON.parse(msgs[1].content), f);
    }
  }
  assert.throws(() => A.buildExplainFacts(profiles[0], 'bank_teller', data, live), /Unknown future role/);
});

test('fallback forecast stays within bounds and widens over time', () => {
  const hist = A.trendHistory(data, snaps, 'moderate');
  for (const [id, h] of Object.entries(hist)) {
    const { points } = A.linearForecast(h, 12);
    assert.equal(points.length, 4, id);
    for (const p of points) assert.ok(p.low <= p.index && p.index <= p.high && p.low >= -100 && p.high <= 100, id);
    assert.ok(points.at(-1).high - points.at(-1).low >= points[0].high - points[0].low, id);
  }
});

// ---------- RunPod integration against a local mock ----------
let mock, calls = [], fail = false;
before(async () => {
  mock = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    calls.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    const send = o => { res.writeHead(fail ? 500 : 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(fail ? { error: 'boom' } : o)); };
    if (req.url === '/skill-ep/runsync') return send({ id: 'j1', status: 'IN_QUEUE' });
    if (req.url === '/skill-ep/status/j1') return send({ id: 'j1', status: 'COMPLETED', output: { skills: [{ id: 'python', level: 2, evidence: ['Python'] }, { id: 'nope', level: 3 }], currentRole: 'student' } });
    if (req.url === '/fc-ep/runsync') return send({ status: 'COMPLETED', output: { model: 'mock-arima', forecasts: { python: { points: [{ month: 12, asOf: '2027-10-19', index: 40, low: 20, high: 60 }] } } } });
    if (req.url === '/llm-ep/openai/v1/chat/completions') return send({ choices: [{ message: { content: 'Plain words.' } }] });
    res.writeHead(404); res.end('{}');
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    RUNPOD_BASE_URL: `http://127.0.0.1:${mock.address().port}`, RUNPOD_API_KEY: 'test-key',
    RUNPOD_SKILL_ENDPOINT_ID: 'skill-ep', RUNPOD_FORECAST_ENDPOINT_ID: 'fc-ep', RUNPOD_LLM_ENDPOINT_ID: 'llm-ep', RUNPOD_LLM_MODEL: 'mock-llm'
  });
});
after(() => mock.close());

test('RunPod endpoints are called with the documented contracts, and fall back on failure', async () => {
  const ai = await import('../scripts/ai.js');
  assert.ok(ai.aiStatus().llm.connected);

  const ex = await ai.extractSkills('I write Python every day as a student.', data);
  assert.equal(ex.source.engine, 'runpod');
  assert.deepEqual(Object.keys(ex.skills), ['python']);
  assert.equal(ex.currentRole, 'student');
  const job = calls.find(c => c.url === '/skill-ep/runsync');
  assert.equal(job.auth, 'Bearer test-key');
  assert.equal(job.body.input.task, 'extract_skills');
  assert.equal(job.body.input.taxonomy.length, data.skills.length);

  const fc = await ai.forecast({ skillIds: ['python'], horizonMonths: 12 }, data, snaps);
  assert.equal(fc.source.engine, 'runpod');
  assert.equal(fc.forecasts.python.points[0].index, 40);
  assert.ok(calls.find(c => c.url === '/fc-ep/runsync').body.input.series.python.length === snaps.length);

  const exp = await ai.explain({ profile: profiles[0], roleId: 'fintech_analyst' }, data, live);
  assert.equal(exp.text, 'Plain words.');
  const chat = calls.find(c => c.url.endsWith('/chat/completions')).body;
  assert.equal(chat.model, 'mock-llm');
  assert.equal(JSON.parse(chat.messages[1].content).targetRole, exp.facts.targetRole);

  fail = true;
  const ex2 = await ai.extractSkills('Customer service and cash handling at a bank teller counter.', data);
  assert.equal(ex2.source.engine, 'keywords');
  assert.ok(ex2.source.usedFallback && ex2.skills.cash_handling);
  assert.equal((await ai.explain({ profile: profiles[0], roleId: 'fintech_analyst' }, data, live)).source.engine, 'template');
  assert.equal((await ai.forecast({ skillIds: ['python'] }, data, snaps)).source.engine, 'linear');
});
