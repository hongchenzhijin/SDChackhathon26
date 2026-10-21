// AI layer: calls three models hosted on RunPod Serverless, each with a transparent local fallback.
//   1. Skill extraction  (RUNPOD_SKILL_ENDPOINT_ID)    custom worker, /runsync  -> skills found in a CV
//   2. Trend forecasting (RUNPOD_FORECAST_ENDPOINT_ID) custom worker, /runsync  -> future trend index per skill
//   3. Explanations      (RUNPOD_LLM_ENDPOINT_ID)      vLLM worker, OpenAI-compatible chat completions
// Input/output contracts are documented in docs/RUNPOD.md. Nothing here is required: with no
// environment variables set, every endpoint answers from the deterministic fallback and says so.
import {
  normaliseExtraction, localExtraction, buildExplainFacts, templateExplanation, explainPrompt,
  trendHistory, linearForecast
} from '../public/js/ai-shared.js';

const env = process.env;
const BASE = (env.RUNPOD_BASE_URL || 'https://api.runpod.ai/v2').replace(/\/$/, '');
const TIMEOUT_MS = Number(env.RUNPOD_TIMEOUT_MS) || 90000;

const ENDPOINTS = {
  skills: env.RUNPOD_SKILL_ENDPOINT_ID,
  forecast: env.RUNPOD_FORECAST_ENDPOINT_ID,
  llm: env.RUNPOD_LLM_ENDPOINT_ID
};
const configured = key => Boolean(env.RUNPOD_API_KEY && ENDPOINTS[key]);

export function aiStatus() {
  return {
    skills: { connected: configured('skills'), fallback: 'keyword matching against the skills taxonomy' },
    forecast: { connected: configured('forecast'), fallback: 'damped linear extrapolation of the snapshot history' },
    llm: { connected: configured('llm'), model: configured('llm') ? env.RUNPOD_LLM_MODEL || null : null, fallback: 'template sentences built from the computed facts' }
  };
}

async function rp(url, init = {}, deadline = Date.now() + TIMEOUT_MS) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}`, 'Content-Type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now()))
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`RunPod HTTP ${res.status}${body.error ? `: ${body.error}` : ''}`);
  return body;
}

// RunPod serverless job: /runsync waits up to ~90 s; on a cold start it may return IN_QUEUE, so poll /status.
async function runJob(endpointId, input) {
  const deadline = Date.now() + TIMEOUT_MS;
  let job = await rp(`${BASE}/${endpointId}/runsync`, { method: 'POST', body: JSON.stringify({ input }) }, deadline);
  while (['IN_QUEUE', 'IN_PROGRESS'].includes(job.status)) {
    if (Date.now() > deadline - 1500) throw new Error('RunPod job timed out');
    await new Promise(r => setTimeout(r, 1500));
    job = await rp(`${BASE}/${endpointId}/status/${job.id}`, {}, deadline);
  }
  if (job.status !== 'COMPLETED') throw new Error(`RunPod job ${job.status || 'failed'}${job.error ? `: ${job.error}` : ''}`);
  return job.output;
}

const fallbackNote = (key, err) => ({ connected: configured(key), usedFallback: true, error: err ? err.message : undefined });

// ---------- 1. Skill extraction ----------
export async function extractSkills(text, data) {
  if (configured('skills')) {
    try {
      const output = await runJob(ENDPOINTS.skills, {
        task: 'extract_skills',
        text,
        taxonomy: data.skills.map(s => ({ id: s.id, name: s.name, category: s.category })),
        roles: data.roles.filter(r => r.type === 'current').map(r => ({ id: r.id, title: r.title })),
        levels: ['none', 'basic', 'working', 'advanced']
      });
      return { ...normaliseExtraction(output, data), source: { engine: 'runpod', label: 'Skill-extraction model (RunPod)' } };
    } catch (err) {
      console.error('[ai] skill extraction fell back:', err.message);
      return { ...localExtraction(text, data), source: { engine: 'keywords', label: 'Keyword matching (model unavailable)', ...fallbackNote('skills', err) } };
    }
  }
  return { ...localExtraction(text, data), source: { engine: 'keywords', label: 'Keyword matching', ...fallbackNote('skills') } };
}

// ---------- 2. Forecasting ----------
export async function forecast({ skillIds, horizonMonths = 12, scenario = 'moderate' }, data, snapshots) {
  const history = trendHistory(data, snapshots, scenario);
  const ids = skillIds.filter(id => history[id]);
  if (configured('forecast')) {
    try {
      const output = await runJob(ENDPOINTS.forecast, {
        task: 'forecast_skill_trends', horizonMonths, scenario,
        series: Object.fromEntries(ids.map(id => [id, history[id]]))
      });
      const forecasts = {};
      for (const id of ids) {
        const pts = output?.forecasts?.[id]?.points;
        if (Array.isArray(pts)) forecasts[id] = { history: history[id], points: pts.map(p => ({ month: +p.month, asOf: p.asOf, index: +p.index, low: +(p.low ?? p.index), high: +(p.high ?? p.index) })) };
      }
      return { forecasts, source: { engine: 'runpod', label: output?.model ? `Forecasting model (${output.model}, RunPod)` : 'Forecasting model (RunPod)' } };
    } catch (err) {
      console.error('[ai] forecast fell back:', err.message);
      return localForecast(ids, history, horizonMonths, fallbackNote('forecast', err));
    }
  }
  return localForecast(ids, history, horizonMonths, fallbackNote('forecast'));
}

function localForecast(ids, history, horizonMonths, note) {
  return {
    forecasts: Object.fromEntries(ids.map(id => [id, { history: history[id], ...linearForecast(history[id], horizonMonths) }])),
    source: { engine: 'linear', label: 'Damped linear trend (forecasting model not connected)', ...note }
  };
}

// ---------- 3. Plain-language explanation ----------
export async function explain({ profile, roleId, scenario = 'moderate', lang = 'en' }, data, snapshot) {
  const facts = buildExplainFacts(profile, roleId, data, snapshot, scenario);
  if (configured('llm')) {
    try {
      const body = await rp(`${BASE}/${ENDPOINTS.llm}/openai/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({ model: env.RUNPOD_LLM_MODEL, messages: explainPrompt(facts, lang), temperature: 0.3, max_tokens: 400 })
      });
      const text = body.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error('empty LLM response');
      return { text, facts, source: { engine: 'runpod', label: `LLM on RunPod${env.RUNPOD_LLM_MODEL ? ` (${env.RUNPOD_LLM_MODEL})` : ''}` } };
    } catch (err) {
      console.error('[ai] explanation fell back:', err.message);
      return { text: templateExplanation(facts), facts, source: { engine: 'template', label: 'Template (LLM unavailable)', ...fallbackNote('llm', err) } };
    }
  }
  return { text: templateExplanation(facts), facts, source: { engine: 'template', label: 'Template (LLM not connected)', ...fallbackNote('llm') } };
}
