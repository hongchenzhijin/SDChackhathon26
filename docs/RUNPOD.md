# Connecting the RunPod models

FutureReady Compass can call three models hosted on [RunPod Serverless](https://docs.runpod.io/serverless/overview). Each one is optional. When a model is not configured, or a call fails, the server uses a transparent fallback and labels the result with the engine that produced it. **No model ever changes a score:** scores always come from `public/js/engine.js`.

| Model | Env var | App endpoint | Fallback |
|---|---|---|---|
| Skill extraction | `RUNPOD_SKILL_ENDPOINT_ID` | `POST /api/ai/extract-skills` | Keyword matching against `skills.json` |
| Trend forecasting | `RUNPOD_FORECAST_ENDPOINT_ID` | `POST /api/ai/forecast` | Damped linear trend over the snapshot history |
| Explanations (LLM) | `RUNPOD_LLM_ENDPOINT_ID` + `RUNPOD_LLM_MODEL` | `POST /api/ai/explain` | Template sentences from the same facts |

All three also need `RUNPOD_API_KEY`. `GET /api/ai/status` reports which are connected. The client code is in [`scripts/ai.js`](../scripts/ai.js), and `test/ai.test.js` checks these contracts against a mock RunPod server.

## 1. Skill extraction (custom worker)

The server calls `POST https://api.runpod.ai/v2/{RUNPOD_SKILL_ENDPOINT_ID}/runsync`. If the job is still `IN_QUEUE` or `IN_PROGRESS`, it polls `/status/{id}`.

**Input** (`job["input"]` in your handler):

```json
{
  "task": "extract_skills",
  "text": "full CV text (max 60,000 chars)",
  "taxonomy": [{ "id": "python", "name": "Python programming", "category": "digital" }],
  "roles":    [{ "id": "bank_teller", "title": "Bank Teller" }],
  "levels":   ["none", "basic", "working", "advanced"]
}
```

**Output** (what your handler returns):

```json
{
  "skills": [
    { "id": "python", "level": 2, "confidence": 0.91, "evidence": ["Built Python scripts to automate reports"] }
  ],
  "currentRole": "bank_teller",
  "name": "optional",
  "sectors": ["finance"]
}
```

- `id` must be one of the taxonomy ids. Unknown ids are dropped, and `level` is clamped to 1–3.
- `evidence` can be strings or `{ "context": "...", "keyword": "..." }` objects. They are shown to the user next to each skill.
- `currentRole` must be one of the given role ids; otherwise it is ignored.
- The user always reviews and edits the result before it is saved.

Minimal handler:

```python
import runpod
def handler(job):
    inp = job["input"]
    preds = my_model.predict(inp["text"], [s["id"] for s in inp["taxonomy"]])
    return {"skills": [{"id": p.id, "level": p.level, "confidence": p.score, "evidence": p.spans} for p in preds]}
runpod.serverless.start({"handler": handler})
```

## 2. Trend forecasting (custom worker)

The server calls `POST /v2/{RUNPOD_FORECAST_ENDPOINT_ID}/runsync`.

**Input:**

```json
{
  "task": "forecast_skill_trends",
  "horizonMonths": 12,
  "scenario": "moderate",
  "series": { "python": [{ "asOf": "2026-04-19", "index": 41 }, { "asOf": "2026-10-19", "index": 38 }] }
}
```

`index` is the engine's trend index (−100 to +100) for each stored snapshot. History grows by one point per weekly refresh.

**Output:**

```json
{
  "model": "my-forecaster-v1",
  "forecasts": {
    "python": { "points": [{ "month": 3, "asOf": "2027-01-19", "index": 40, "low": 25, "high": 55 }] }
  }
}
```

## 3. Plain-language explanations (vLLM worker)

Deploy RunPod's **vLLM worker** (Quick Deploy → Serverless vLLM) with an instruction-tuned model. The server uses its OpenAI-compatible route:

`POST https://api.runpod.ai/v2/{RUNPOD_LLM_ENDPOINT_ID}/openai/v1/chat/completions` with `model = RUNPOD_LLM_MODEL`, `temperature 0.3` and `max_tokens 400`.

The prompt (`explainPrompt` in [`public/js/ai-shared.js`](../public/js/ai-shared.js)) contains:

- a system message: use only the given facts, invent nothing, keep names exactly, 120–170 words, reply in EN, BM or 中文;
- a user message with a JSON object of facts computed by the engine: score, score range, skills the user has, gaps, pathway weeks and hours, the first courses, and SDGs.

The browser cannot send free text to the LLM. The server rebuilds the facts from a sanitised profile, so prompt injection through the profile is not possible.

## Cost and safety controls

- `AI_RATE_LIMIT` (default 30 requests per IP per 10 minutes) caps spend on `/api/ai/*`.
- `RUNPOD_TIMEOUT_MS` (default 90 s) covers cold starts. On timeout, the fallback answers.
- Request bodies are limited to 256 KB. Profiles are reduced to the scored fields, so age, gender and similar fields are dropped before any model sees them.
