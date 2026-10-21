// Zero-dependency server: serves the static app, a live-refresh API and the AI endpoints.
//   GET  /api/status             -> health + latest snapshot + which AI models are connected
//   POST /api/refresh            -> fetch new public trend signals and save a dated snapshot
//   GET  /api/ai/status          -> which RunPod models are connected (and the fallback for each)
//   POST /api/ai/extract-skills  -> { text }                                  -> skills found in a CV
//   POST /api/ai/forecast        -> { skillIds, horizonMonths?, scenario? }   -> forecast trend index per skill
//   POST /api/ai/explain         -> { profile, roleId, scenario?, lang? }     -> plain-language explanation
// Optional: AUTO_REFRESH_HOURS=24 npm start  -> refresh on a schedule. RunPod settings: see .env.example.
import './scripts/env.js';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from './scripts/trends.js';
import { aiStatus, extractSkills, forecast, explain } from './scripts/ai.js';
import { SCENARIOS } from './public/js/engine.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MIN_REFRESH_MS = 5 * 60 * 1000; // be polite to the free public APIs
const MAX_BODY = 256 * 1024;
const AI_LIMIT = { windowMs: 10 * 60 * 1000, max: Number(process.env.AI_RATE_LIMIT) || 30 }; // per IP, protects RunPod credit
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

let lastRefresh = 0;
let inFlight = null;

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const httpError = (code, message) => Object.assign(new Error(message), { code });

// ---------- data used by the AI endpoints ----------
const readJSON = async rel => JSON.parse(await readFile(path.join(ROOT, 'data', rel), 'utf8'));
let dataCache = null;
async function getData() {
  if (!dataCache) {
    const [skills, roles, res] = await Promise.all(['skills.json', 'roles.json', 'resources.json'].map(readJSON));
    dataCache = { skills: skills.skills, roles: roles.roles, resources: res.resources };
  }
  return dataCache;
}
const snapCache = new Map();
async function getSnapshots() {
  const index = await readJSON('snapshots/index.json');
  return Promise.all(index.map(async s => {
    if (!snapCache.has(s.id)) snapCache.set(s.id, await readJSON(`snapshots/${s.id}.json`));
    return snapCache.get(s.id);
  }));
}
async function getSnapshot(id) {
  const all = await getSnapshots();
  return all.find(s => s.id === id) || [...all].reverse().find(s => s.mode === 'live') || all.at(-1);
}

// Only the fields the engine scores are accepted; anything else (age, gender, …) is dropped here.
function cleanProfile(p, data) {
  const ids = new Set(data.skills.map(s => s.id));
  const sectors = new Set(data.roles.flatMap(r => r.sectors));
  const skills = {};
  for (const [id, lvl] of Object.entries(p?.skills || {})) if (ids.has(id)) skills[id] = Math.min(3, Math.max(0, Math.round(+lvl || 0)));
  return {
    name: String(p?.name || '').slice(0, 40),
    currentRole: data.roles.some(r => r.id === p?.currentRole) ? p.currentRole : 'other',
    hoursPerWeek: Math.min(40, Math.max(1, +p?.hoursPerWeek || 5)),
    sectors: (Array.isArray(p?.sectors) ? p.sectors : []).filter(s => sectors.has(s)),
    skills
  };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw httpError(413, 'Request body too large');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw httpError(400, 'Body must be JSON'); }
}

const hits = new Map();
function rateLimit(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < AI_LIMIT.windowMs);
  if (recent.length >= AI_LIMIT.max) throw httpError(429, 'Too many AI requests — please wait a few minutes.');
  recent.push(now);
  hits.set(ip, recent);
}

const AI_ROUTES = {
  async 'extract-skills'(body) {
    const text = String(body.text || '').slice(0, 60000);
    if (text.trim().length < 20) throw httpError(400, 'CV text is too short.');
    return extractSkills(text, await getData());
  },
  async forecast(body) {
    const data = await getData();
    const skillIds = (Array.isArray(body.skillIds) ? body.skillIds : []).slice(0, 40);
    if (!skillIds.length) throw httpError(400, 'skillIds is required.');
    const scenario = SCENARIOS[body.scenario] ? body.scenario : 'moderate';
    const horizonMonths = Math.min(36, Math.max(3, Math.round(+body.horizonMonths || 12)));
    return forecast({ skillIds, horizonMonths, scenario }, data, await getSnapshots());
  },
  async explain(body) {
    const data = await getData();
    const scenario = SCENARIOS[body.scenario] ? body.scenario : 'moderate';
    const lang = ['en', 'ms', 'zh'].includes(body.lang) ? body.lang : 'en';
    return explain({ profile: cleanProfile(body.profile, data), roleId: String(body.roleId || ''), scenario, lang }, data, await getSnapshot(body.snapshotId));
  }
};

async function refresh() {
  if (inFlight) return inFlight;
  if (Date.now() - lastRefresh < MIN_REFRESH_MS) {
    throw Object.assign(new Error(`Data was refreshed less than ${MIN_REFRESH_MS / 60000} minutes ago — please wait.`), { code: 429 });
  }
  inFlight = (async () => {
    const snapshot = await buildSnapshot({ log: m => console.log('[refresh]', m) });
    lastRefresh = Date.now();
    const index = JSON.parse(await readFile(path.join(ROOT, 'data', 'snapshots', 'index.json'), 'utf8'));
    return { snapshot, index };
  })().finally(() => { inFlight = null; });
  return inFlight;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/status') {
      const index = JSON.parse(await readFile(path.join(ROOT, 'data', 'snapshots', 'index.json'), 'utf8'));
      return send(res, 200, { ok: true, latest: index.at(-1), lastRefresh: lastRefresh ? new Date(lastRefresh).toISOString() : null, ai: aiStatus() });
    }
    if (url.pathname === '/api/refresh') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      try { return send(res, 200, await refresh()); }
      catch (e) { return send(res, e.code === 429 ? 429 : 502, { error: e.message }); }
    }
    if (url.pathname === '/api/ai/status') return send(res, 200, aiStatus());
    if (url.pathname.startsWith('/api/ai/')) {
      const route = AI_ROUTES[url.pathname.slice('/api/ai/'.length)];
      if (!route) return send(res, 404, { error: 'Unknown AI endpoint' });
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      try {
        rateLimit(req);
        return send(res, 200, await route(await readBody(req)));
      } catch (e) {
        if (!e.code) console.error(e);
        return send(res, typeof e.code === 'number' ? e.code : 500, { error: typeof e.code === 'number' ? e.message : 'AI service error' });
      }
    }
    let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT)) return send(res, 403, { error: 'Forbidden' });
    if ((await stat(file).catch(() => null))?.isDirectory()) file = path.join(file, 'index.html');
    const body = await readFile(file).catch(() => null);
    if (!body) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    send(res, 200, body, TYPES[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  const ai = aiStatus();
  console.log(`FutureReady Compass running at http://localhost:${PORT}`);
  console.log(`AI models: skills ${ai.skills.connected ? 'RunPod' : 'fallback'} · forecast ${ai.forecast.connected ? 'RunPod' : 'fallback'} · LLM ${ai.llm.connected ? 'RunPod' : 'fallback'}`);
});

const auto = Number(process.env.AUTO_REFRESH_HOURS);
if (auto > 0) {
  setInterval(() => refresh().catch(e => console.error('[auto-refresh]', e.message)), auto * 3600 * 1000);
  console.log(`Auto-refresh every ${auto} h`);
}
