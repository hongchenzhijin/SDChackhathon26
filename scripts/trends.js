// AI-trend signal layer: pulls public, updatable signals and writes a dated snapshot.
//   1. Hacker News (Algolia Search API)  -> AI/tech discussion momentum per skill
//   2. Arbeitnow + Remotive job APIs      -> share of live job postings mentioning each skill
//   3. data.gov.my (DOSM) open data       -> Malaysian labour-market context
// The WEF Future of Jobs 2025 baseline lives in skills.json / roles.json (static, cited).
// Raw counts are stored; all scoring happens in public/js/engine.js so it stays explainable.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'public', 'data');
const SNAP_DIR = path.join(DATA, 'snapshots');
const DAY = 86400;
const WINDOW_DAYS = 180;
const UA = { 'User-Agent': 'FutureReady-Compass/0.1 (hackathon prototype; public data only)' };

async function getJSON(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i >= tries) throw new Error(`${url} -> ${err.message}`);
      await new Promise(r => setTimeout(r, 800 * i));
    }
  }
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const hnCount = async (query, from, to) => {
  const q = new URLSearchParams({ tags: 'story', hitsPerPage: '0', numericFilters: `created_at_i>${from},created_at_i<=${to}` });
  if (query) q.set('query', query);
  return (await getJSON(`https://hn.algolia.com/api/v1/search?${q}`)).nbHits;
};

async function hackerNewsSignals(skills, asOfSec, log) {
  const recent = [asOfSec - WINDOW_DAYS * DAY, asOfSec];
  const prior = [asOfSec - 2 * WINDOW_DAYS * DAY, asOfSec - WINDOW_DAYS * DAY];
  const [totalRecent, totalPrior] = await Promise.all([hnCount('', ...recent), hnCount('', ...prior)]);
  log(`HN total stories: recent=${totalRecent} prior=${totalPrior}`);
  const tracked = skills.filter(s => s.signal.hn);
  const counts = await pool(tracked, 4, async s => {
    const [r, p] = await Promise.all([hnCount(s.signal.hn, ...recent), hnCount(s.signal.hn, ...prior)]);
    return [s.id, { query: s.signal.hn, recent: r, prior: p }];
  });
  return {
    source: {
      id: 'hn', name: 'Hacker News stories (Algolia HN Search API)', url: 'https://hn.algolia.com/api',
      kind: 'AI & tech discussion momentum',
      window: { recent: recent.map(toISODate), prior: prior.map(toISODate) },
      totals: { recent: totalRecent, prior: totalPrior }
    },
    bySkill: Object.fromEntries(counts)
  };
}

const stripHtml = s => (s || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');

async function jobPostings(log) {
  const postings = new Map();
  const sources = [];
  try {
    let n = 0;
    for (let page = 1; page <= 5; page++) {
      const j = await getJSON(`https://www.arbeitnow.com/api/job-board-api?page=${page}`);
      if (!j.data?.length) break;
      for (const p of j.data) {
        postings.set(p.url, `${p.title} ${(p.tags || []).join(' ')} ${(p.job_types || []).join(' ')} ${stripHtml(p.description)}`);
        n++;
      }
    }
    sources.push({ id: 'arbeitnow', name: 'Arbeitnow Job Board API', url: 'https://www.arbeitnow.com/api/job-board-api', kind: 'Live job postings (EU-focused, incl. remote)', postings: n });
    log(`Arbeitnow postings: ${n}`);
  } catch (e) { log(`Arbeitnow failed: ${e.message}`); }
  try {
    const j = await getJSON('https://remotive.com/api/remote-jobs');
    for (const p of j.jobs || []) postings.set(p.url, `${p.title} ${p.category} ${(p.tags || []).join(' ')} ${stripHtml(p.description)}`);
    sources.push({ id: 'remotive', name: 'Remotive Remote Jobs API', url: 'https://remotive.com/api/remote-jobs', kind: 'Live remote job postings (global)', postings: j.jobs?.length || 0 });
    log(`Remotive postings: ${j.jobs?.length || 0}`);
  } catch (e) { log(`Remotive failed: ${e.message}`); }
  return { texts: [...postings.values()], sources };
}

function jobSignals(skills, texts) {
  const bySkill = {};
  for (const s of skills) {
    const re = new RegExp(s.signal.jobs, 'i');
    const mentions = texts.reduce((n, t) => n + (re.test(t) ? 1 : 0), 0);
    bySkill[s.id] = { mentions, total: texts.length, share: texts.length ? mentions / texts.length : 0 };
  }
  return bySkill;
}

async function malaysiaContext(log) {
  try {
    const lfs = await getJSON('https://api.data.gov.my/data-catalogue?id=lfs_month&sort=-date&limit=1');
    const sru = await getJSON('https://api.data.gov.my/data-catalogue?id=lfs_qtr_sru_age&sort=-date&limit=40');
    const rate = sru.filter(r => r.variable === 'rate');
    const latestSru = rate.find(r => r.age === 'overall');
    const ctx = {
      retrievedAt: new Date().toISOString(),
      source: { name: 'Department of Statistics Malaysia via data.gov.my', url: 'https://data.gov.my/data-catalogue' },
      labourForce: { dataset: 'lfs_month', ...lfs[0] },
      skillsUnderemployment: latestSru ? { dataset: 'lfs_qtr_sru_age', date: latestSru.date, overallRate: latestSru.sru, youth15to24Rate: rate.find(r => r.age === '15-24' && r.date === latestSru.date)?.sru } : null
    };
    await writeFile(path.join(DATA, 'context', 'malaysia.json'), JSON.stringify(ctx, null, 2));
    log(`Malaysia context: unemployment ${ctx.labourForce.u_rate}% (${ctx.labourForce.date})`);
  } catch (e) { log(`data.gov.my failed (kept previous context): ${e.message}`); }
}

const toISODate = sec => new Date(sec * 1000).toISOString().slice(0, 10);

export async function buildSnapshot({ asOf, log = console.log } = {}) {
  const { skills } = JSON.parse(await readFile(path.join(DATA, 'skills.json'), 'utf8'));
  const now = new Date();
  const asOfDate = asOf ? new Date(`${asOf}T00:00:00Z`) : now;
  const isBackfill = asOfDate < new Date(now.getTime() - 2 * DAY * 1000);
  const asOfSec = Math.floor(asOfDate.getTime() / 1000);

  const hn = await hackerNewsSignals(skills, asOfSec, log);
  let jobs = null, jobSources = [];
  if (!isBackfill) {
    const { texts, sources } = await jobPostings(log);
    if (texts.length) { jobs = jobSignals(skills, texts); jobSources = sources; }
    await mkdir(path.join(DATA, 'context'), { recursive: true });
    await malaysiaContext(log);
  }

  const id = `${toISODate(asOfSec)}${isBackfill ? '-backfill' : ''}`;
  const snapshot = {
    id,
    asOf: toISODate(asOfSec),
    generatedAt: now.toISOString(),
    mode: isBackfill ? 'backfill' : 'live',
    note: isBackfill
      ? 'Historical snapshot rebuilt from timestamped Hacker News data. Live job postings cannot be backfilled, so job demand is unavailable and its weight is redistributed.'
      : 'Live snapshot built from public APIs at the time shown.',
    sources: [
      hn.source,
      ...jobSources.map(s => ({ ...s, retrievedAt: now.toISOString() })),
      { id: 'wef', name: 'World Economic Forum – Future of Jobs Report 2025', url: 'https://www.weforum.org/publications/the-future-of-jobs-report-2025/', kind: 'Baseline skill & job outlook (employer survey, 2025–2030)', published: '2025-01' }
    ],
    skills: Object.fromEntries(skills.map(s => [s.id, { hn: hn.bySkill[s.id] || null, jobs: jobs?.[s.id] || null }]))
  };

  await mkdir(SNAP_DIR, { recursive: true });
  await writeFile(path.join(SNAP_DIR, `${id}.json`), JSON.stringify(snapshot, null, 2));
  const indexPath = path.join(SNAP_DIR, 'index.json');
  let index = [];
  try { index = JSON.parse(await readFile(indexPath, 'utf8')); } catch {}
  index = index.filter(e => e.id !== id);
  index.push({ id, asOf: snapshot.asOf, generatedAt: snapshot.generatedAt, mode: snapshot.mode });
  index.sort((a, b) => a.asOf.localeCompare(b.asOf));
  await writeFile(indexPath, JSON.stringify(index, null, 2));
  log(`Saved snapshot ${id}`);
  return snapshot;
}
