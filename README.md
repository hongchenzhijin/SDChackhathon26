# FutureReady Compass

**From who you are today to where you can be in the AI era.**
A working prototype for the *Aiversecity Future-Ready Workforce* challenge (main SDG 4; also SDGs 5, 8, 9, 10).

FutureReady Compass tracks live AI and job-market signals. It uses them to estimate which skills are rising or declining, matches a person to future roles with a score you can explain, and builds a free or low-cost reskilling plan. It links every role and skill to the UN Sustainable Development Goals. It supports human career decisions and never replaces them.

---

## Quick start

Requires **Node.js 18+** and nothing else (no `npm install`; there are zero dependencies).

```bash
npm start              # http://localhost:3000
npm test               # 19 unit tests (engine, data integrity, fairness, AI layer vs a mock RunPod)
npm run refresh        # fetch a new live trend snapshot from the public APIs
npm run backfill -- 2026-04-19   # rebuild a historical snapshot (HN signals only)
```

Demo shortcuts: `http://localhost:3000/?persona=aisyah#matches`, `?persona=weijie&lang=ms`, `?persona=daniel&lang=zh#radar`

Optional AI models on RunPod: copy `.env.example` to `.env` and fill in the keys. See [docs/RUNPOD.md](docs/RUNPOD.md). Without them, everything works on transparent fallbacks.

The app also runs as a static site (e.g. GitHub Pages from `/public`). There, the scheduled GitHub Action refreshes the data and the in-app refresh button is disabled.

## 3-minute demo script

1. **Profile**: a new user picks one of three ways in: a 5-step **guided form**, a **CV upload** (`public/samples/cv-weijie.txt`) whose result is previewed and fully editable before saving, or one of **9 sample profiles**. Each skill detected from a CV shows the phrase it came from.
2. **Skills Radar**: the trend index (−100 to +100) for 39 skills, with uncertainty whiskers. Click *LLM apps, RAG & AI agents* to see the score worked out from WEF, Hacker News counts and job-ad counts, each with its date. *What changed since 2026-04-19* shows prompt engineering falling from +52 to about +6 in six months.
3. **Matches**: Aisyah's current role carries **high AI exposure**. The ranked future roles each show a score split into skills fit, outlook and interest. The *How the ranking changes by scenario* table shows scores and ranks under slow / moderate / fast AI disruption, and flags roles that are *robust* (top 5 in every scenario).
4. **Pathway**: an ordered, week-by-week plan with real free or low-cost courses, hours, and HRD Corp / MyFutureJobs next steps. Tick a step to earn a badge.
5. **SDG Impact**: how the chosen path contributes to each goal, with the reason for every link.
6. **HR Team View**: a skills-readiness heatmap and reskilling plan for a synthetic 8-person banking team, with CSV export.
7. **Data & Method**: every source and date, the formulas, the guardrails, and a live **fairness check**.

## How each must-have is delivered

| # | Requirement | Where | How |
|---|---|---|---|
| 1 | Skills profile intake | *Profile* | Three onboarding paths: a guided 5-step form (about you → interests → skills → levels → review), a CV upload (.txt / .pdf or pasted text) with an editable preview, or 9 synthetic sample profiles. CV extraction uses the RunPod skill-extraction model when connected, otherwise keyword matching in the browser; both show their evidence. |
| 2 | AI-trend signal layer | *Skills Radar*, `scripts/trends.js` | Three **updatable** public sources: Hacker News (Algolia API) for AI/tech discussion momentum over two 180-day windows; Arbeitnow + Remotive job APIs for skill share in about 1,500 live postings; data.gov.my (DOSM) for Malaysian labour-market context. The WEF Future of Jobs Report 2025 is the cited baseline. Each snapshot is dated and stores its sources; refresh with the button, CLI or weekly GitHub Action. |
| 3 | Future-role matching | *Matches* | 20 future roles ranked by a score with three visible parts: skills fit, role outlook and interest fit. Each card lists the skills you have (✓) and the gaps (✗) with current and needed levels. |
| 4 | Personalised pathway | *Pathway* | Gaps plus missing prerequisites, ordered prerequisites-first, matched to 38 real free or low-cost courses (Elements of AI, Kaggle Learn, CS50, Google certificates, Cisco NetAcad, FAO, SDG Academy…). Shows hours, weeks at your pace and cost. When no listed course reaches a level, the step says so. |
| 5 | SDG mapping | *SDG Impact*, badges throughout | Every skill and role carries 1–3 SDG tags, each with a one-line reason. The path view weights them into a contribution share and lists the reason behind every link. |
| 6 | Handling uncertainty | *Three possible futures* card, whiskers, *Matches* scenario table | Three scenarios (slow / moderate / fast AI disruption) change the skill trends and the match weighting. Uncertainty bands widen with faster disruption and missing data. Scores show their range across scenarios, roles that stay top 5 in all three are flagged *robust*, and every view says predictions are estimates. |

**Good-to-have features also included:** an HR / employer heatmap and team plan; automatic re-planning (comparing against the previous snapshot, a "your recommendations changed" banner, and a refresh toast); EN / BM / 中文 interface; a mobile-friendly, low-bandwidth build (about 105 KB of uncompressed JS/CSS, no framework, pdf.js only loaded when a PDF is uploaded); progress tracking and skill badges; a fairness test; and an SDG view aggregated per person and per team.

## Method (short version)

**Skill trend index**, per scenario with *k* = 0.3 / 1.0 / 2.0:

```
signals = 0.35·WEF baseline (+1/0/−1)
        + 0.35·HN momentum   (log₂ change in story share, relative to the median topic, shrunk when volume is low)
        + 0.30·job-ad demand (percentile of posting share)
          (missing parts are dropped and the weights re-normalised)
index   = 100 · clamp(0.65·signals + 0.35·k·(AI complement − AI exposure))
```

**Role outlook** = 40% WEF job outlook + 60% weighted trend of the role's skills.

**Match score** = skills fit · w₁ + outlook · w₂ + interest · w₃. The weights shift with the scenario (slow .70/.15/.15, moderate .60/.25/.15, fast .45/.40/.15): when change is slow, what you can do today matters most; when it's fast, choosing a growing role matters more. Under faster disruption, the AI-exposed requirements of a role also count less toward skills fit.

The full explanation is in the app under *Data & Method* and in [`public/js/engine.js`](public/js/engine.js), about 300 lines of pure, tested functions.

## Guardrails and responsible AI

- **Models never score.** Every recommendation comes from a transparent formula over cited data. The optional RunPod models only read CVs (output filtered to the taxonomy and confirmed by the user), forecast trends (labelled as projections), and rephrase engine-computed facts in plain language. The system cannot invent jobs, courses or statistics: roles, skills and courses come from curated public lists in `public/data/*.json`, and unit tests check that each one has a source or URL.
- **Assumptions are labelled.** The per-skill *AI exposure* and *AI complement* values are team assumptions (informed by the ILO 2023 generative-AI exposure study) and the app presents them as assumptions. Course hours are labelled as planning estimates.
- **Human-centred.** The app frames itself as decision support. It is not for hiring, firing or ranking employees against each other.
- **Fairness.** Age, gender, ethnicity, religion and disability are never collected, and years of experience (an age proxy) is not scored. A unit test and an in-app check inject these attributes and confirm that rankings are identical.
- **Privacy.** Profiles stay in the browser. A CV is read in the browser unless the skill-extraction model is connected; then the text goes to the server and RunPod to be read and is not stored. The server strips every profile field the engine does not score. All demo people and the HR team are synthetic.

## Project structure

```
server.js                  zero-dependency static server + /api/status, /api/refresh, /api/ai/*
scripts/ai.js              RunPod client: skill extraction, forecasting, LLM explanations (+ fallbacks)
scripts/trends.js          AI-trend signal layer (HN, Arbeitnow, Remotive, data.gov.my)
scripts/refresh-trends.js  CLI: live snapshot or --as-of backfill
public/index.html          single-page app shell
public/js/engine.js        scoring engine (trends, matching, pathway, SDG, fairness-safe)
public/js/app.js           views: profile (onboarding), radar, matches, pathway, SDG, HR team, method
public/js/ai-shared.js     explanation facts, template + forecast fallbacks, model-output filtering
public/js/i18n.js          English / Bahasa Malaysia / 中文
public/data/               skills, roles, resources, SDGs, synthetic personas & team
public/data/snapshots/     dated trend snapshots + index
test/*.test.js             node --test suites (engine, AI layer)
docs/RUNPOD.md             model input/output contracts
.replit                    Replit run + deployment config
.github/workflows/         weekly trend refresh
```

## Deploying on Replit

1. Import the GitHub repository into Replit (Create Repl → Import from GitHub). `.replit` already sets Node 20 and `npm start`.
2. Optional: add the RunPod variables from `.env.example` under **Secrets**.
3. Click **Run** to test, then **Deploy → Autoscale** (run command `node server.js`). The server listens on `$PORT` and `0.0.0.0`.

On autoscale deployments the file system resets between instances, so snapshots fetched with *Refresh live data* last only until the next restart. The weekly GitHub Action commits snapshots to the repository, which keeps them permanent.

## Data sources

| Source | Use | Licence / terms |
|---|---|---|
| [WEF Future of Jobs Report 2025](https://www.weforum.org/publications/the-future-of-jobs-report-2025/) | Baseline: fastest-growing / declining jobs and skills | Public report, cited |
| [Hacker News Search API (Algolia)](https://hn.algolia.com/api) | AI/tech discussion momentum | Public API |
| [Arbeitnow Job Board API](https://www.arbeitnow.com/api/job-board-api) | Live job-posting skill demand | Free public API, linked back |
| [Remotive Remote Jobs API](https://remotive.com/api/remote-jobs) | Live remote job postings | Free public API, linked back |
| [data.gov.my (DOSM)](https://data.gov.my/data-catalogue) | Malaysian unemployment and skills-related underemployment | Open data |
| Hays Asia Salary Guide 2025, MOSTI | Problem-statement context only | As cited by the organiser |

## Known limitations and next steps

- The job feeds are global/EU boards. Next step: Malaysian postings via MyFutureJobs, or partner data from JobStreet or LinkedIn.
- Hacker News is a leading but noisy tech signal. Next step: add arXiv research volume and GitHub repository activity.
- The RunPod models (skill extraction, forecasting, LLM explanations) are wired up with documented contracts but need trained models deployed; see [docs/RUNPOD.md](docs/RUNPOD.md).
- Skill and role names are English-only; translating them is next.
- Validate the taxonomy with TVET and university career centres and with HR practitioners.

---
Built for the Aiversecity hackathon. Demo data is synthetic. All predictions are estimates.
