# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Astro SSR app (`output: 'server'`, **Netlify adapter** — `@astrojs/node` is still installed but unused) that shows the full World Cup 2026 calendar (group stage + knockout) stored in Supabase and generates match predictions with an LLM. UI text, code comments, and error messages are in Spanish — keep that convention.

**README discrepancy:** the README claims predictions use Claude (`claude-opus-4-8`) with `ANTHROPIC_API_KEY`, but the actual code (`src/pages/api/predict.ts`) uses the OpenAI SDK with `gpt-4o` and `OPENAI_API_KEY` (matching `.env.example`). Trust the code, not the README.

**Dead code warning:** `src/lib/consensus.ts` is a stale, unused duplicate of the consensus logic. The canonical implementation is `requestConsensus` exported from `src/pages/api/predict.ts` (also imported by `scripts/precompute-predictions.js`). Prompt/validation changes go there, not in `consensus.ts`.

## Commands

```sh
npm run dev            # dev server (user runs it on port 4321)
npm run build          # production build to dist/
npm run preview        # preview the build
npm run seed           # seed Supabase from data/world_cup_2026.json (node --env-file=.env, needs Node 20.6+)
npm run set-result -- "<Local>" "<Visitante>" <gl> <gv>   # record a real result (status → finished)
npm run map-teams      # inject external IDs (eloratings/API-Football/FBref) into team_stats for all 48 teams
npm run ingest         # real-data ingestion (football-data + open-data CSV + eloratings) — writes to Supabase
npm run precompute     # batch-generate predictions for all pending matches without cache (~4s delay between LLM calls)
npm run clear-cache    # clear prediction_cache ONLY for non-finished matches (finished ones keep theirs for the feedback loop)
npm run hard-reset     # purge ALL Supabase tables, then re-seed — destructive
npm run deploy-reality # full pipeline: hard-reset → map-teams → ingest → precompute
npx astro check        # type-check (.astro + TS); no lint or test setup exists
```

`scripts/parse-schedule.js` and `scripts/generate-json.js` are one-off generators that build `data/world_cup_2026.json` from `data/raw_schedule.txt`; they have no npm script.

Setup requires a `.env` (copy from `.env.example`) with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, and optionally `SPORTS_API_URL`/`SPORTS_API_KEY`. The DB schema must be created manually by running `supabase/schema.sql` in the Supabase SQL editor; there are no migrations (the file uses idempotent `alter table ... if not exists` blocks so re-running it upgrades older databases).

## Architecture

Data flow:

1. **Seed layer** — `data/world_cup_2026.json` (48 teams, **104 matches**: 72 group + 32 knockout) → `scripts/seed.js` → Supabase tables `matches` and `team_stats`. Matches carry `group_name`/`matchday`/`stage` (`group | round_32 | round_16 | quarter | semi | third | final`; labels in `src/lib/stages.ts`). Knockout matches with unresolved teams (names matching the placeholder regex `\dº|Ganador|Perdedor|Grupo`, see `src/lib/placeholders.ts`) are seeded with `status: 'awaiting_teams'`; once the JSON carries real names, re-seeding upserts them and promotes their status to `pending`. Match upserts (on `api_id`) deliberately omit scores/status(for resolved rows)/prediction_cache so re-seeding never clobbers results or cached predictions; `team_stats` is insert-only (`ignoreDuplicates`) so re-seeding never overwrites ingested real stats.

2. **Hybrid calendar sync** — `src/lib/matches.ts#getCalendar()` reads all matches, finds ones that are `pending` but whose date has passed ("stale"), and lazily syncs their results from the external sports API (if `SPORTS_API_URL`/`SPORTS_API_KEY` are set) before re-reading. Sync failures are silently skipped per-match; without API credentials it just returns the data as-is. This runs on every page load — there is no background job. Real results can also be recorded manually with `npm run set-result`.

3. **Prediction engine** — all math is deterministic TypeScript in `src/lib/prediction-engine.ts` (`buildDeterministicReport`): full Poisson scoreline matrix (0–10 goals) including `mejores_marcadores` (most probable scoreline per outcome), Elo expectation `E = 1/(1+10^(-d/400))` split three ways, and a recency-weighted form/xG panel; percentages use largest-remainder rounding so each method sums to exactly 100. Poisson lambdas are **opponent-quality adjusted**: raw goal averages are scaled by Elo ratios against `REFERENCE_ELO` (1600), clamped to [0.5, 1.5], to correct confederation bias. Tournament hosts (`HOST_TEAMS`: México, Estados Unidos, Canadá) get `HOST_ELO_BONUS` (+80) added to their effective Elo when playing as `home_team`, applied to both the Elo expectation and the Poisson weighting. The Elo three-way split uses additive smoothing (`MIN_OUTCOME_SHARE` = 5% floor) so no outcome can be 0%. The report also emits `mercado_1x2`: the deterministic 50/50 blend of Poisson and Elo probabilities with `ganador_argmax` (draw only if strictly greater than both win probabilities; team-vs-draw ties resolve to the team) and `marcador_argmax`. xG is nullable: when either team lacks xG the form panel reports `xg_disponible: false` with null deltas and the math degrades to Poisson + Elo.

4. **LLM consensus** — `requestConsensus` in `src/pages/api/predict.ts` (`gpt-4o`, `temperature: 0`, JSON mode) only does consensus weighting + textual synthesis over the pre-computed numbers, anchored on `mercado_1x2`. Output is validated (`validateRules`: integer probabilities summing to exactly 100, winner ∈ {home, away, Empate}, winner/max-probability coherence, and the **argmax rule**: Empate may only be declared if its probability is strictly greater than both win probabilities) with one retry that feeds the validation error back. There is no forced-draw heuristic. **The LLM does not choose the scoreline**: after validation, `marcador_exacto` is overwritten with the Poisson `mejores_marcadores` entry matching the predicted winner. Changing the `Prediction` shape requires touching the system prompt's JSON template, the `Prediction` interface (`src/lib/prediction-types.ts`), and `parseStructure` together.

5. **Feedback loop (dampened)** — `src/lib/feedback-loop.ts#buildTournamentFeedback` compares finished matches' real scores against their cached predictions (`src/lib/accuracy.ts#evaluatePrediction`) per team. With **≥ 3 evaluable finished matches** it emits one aggregated "Diagnóstico acumulado" per team (hit rate plus mean attack/defense calibration deltas; a bias is only named when the mean delta reaches ±0.5 goals). With 1–2 matches it emits a neutral "Contexto informativo" that the system prompt explicitly forbids using for weight adjustments — never per-match directional lessons, to avoid amplifying single-match variance. Used by both the API endpoint and `npm run precompute`. This is why `npm run clear-cache` preserves finished matches' caches — they are the accuracy history.

6. **Prediction endpoint** — `POST /api/predict` takes `{ matchId }`, 409s on finished matches and on `awaiting_teams`/placeholder matches, returns `matches.prediction_cache` (JSONB `{ prediction, motor_determinista, generado_en }`, typed as `PredictionCache`) instantly when present (`cached: true`), otherwise generates, UPDATEs the cache, and returns `cached: false`. `npm run precompute` does the same in batch for all pending uncached matches.

7. **UI** — split-panel "liquid glass" layout in `src/pages/index.astro` (SSR): scrollable calendar sidebar grouped by day, main analysis view rendered client-side (flags via `src/lib/flags.ts` → flagcdn.com keyed by `eloratings_team_name`, stacked probability bar, head-to-head stats, consensus text). Data reaches the client through a `<script type="application/json" id="app-data">` payload that includes `stage`, `has_cache`, and the accuracy `verdict` per match. `src/pages/grupos.astro` renders 12 hybrid standings tables computed by `src/lib/standings.ts`: real score if `status === 'finished'`, else cached prediction's `marcador_exacto`, else the match doesn't count; sorted by points → goal difference → goals for. All plain scoped CSS with shared variables and the top nav in `Layout.astro`; glass panels use rgba + backdrop-filter only — no solid table backgrounds, no Tailwind.

8. **Real-data ingestion** — `npm run ingest` runs `scripts/ingest-real-data.js` (plain JS importing `.ts` providers via `node --import tsx`). Providers implement the contracts in `src/lib/ingestion/contracts.ts`. Active sources, in run order: `football-data.ts` (football-data.org via `SPORTS_API_URL`/`SPORTS_API_KEY`; ≤730-day windows, ~6.5s throttle for the 10 req/min free tier — the free tier yields almost no historical national-team matches), `open-data.ts` (martj42/international_results CSV on GitHub, no key — the actual workhorse for real goals/W-D-L), and `scrapers.ts` eloratings.net (static TSV endpoints: `World.tsv` current, `2022.tsv` cycle-start anchor, `en.teams.tsv` aliases). FBref/Apify xG is gated behind `FBREF_INGESTION_ENABLED=true` and currently blocked by FBref's anti-bot even with proxies. `npm run map-teams` must run first: the orchestrator only processes teams with `eloratings_team_name` set; that name doubles as the lookup key for open-data and football-data and must match the CSV byte-for-byte (e.g. `Curaçao` with cedilla). Aggregates recompute from `team_match_history` (deduped by match_date) for teams with ≥5 matches; `avg_xg_for/against` become NULL when no real xG exists and `data_source` becomes `real`. `api-football.ts` exists but is unused until `API_FOOTBALL_KEY` is configured; some teams lack a verified `api_football_team_id`.

## Notes

- The server uses the Supabase **service role key** (`src/lib/supabase.ts`), bypassing RLS; the schema's RLS policies only allow public reads, so all writes must go through server code or the scripts.
- Env vars are read via `import.meta.env` in app code but `process.env` in `scripts/*.js` (which run outside Astro); `predict.ts` checks both because it is also imported by the precompute script.
- `matches.status` has three values: `pending`, `awaiting_teams` (unresolved knockout bracket), `finished`.
- `dist/` is build output — never edit it.
