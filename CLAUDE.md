# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Astro SSR app (Node standalone adapter, `output: 'server'`) that shows the World Cup 2026 group-stage calendar stored in Supabase and generates match predictions with an LLM. UI text, code comments, and error messages are in Spanish — keep that convention.

**README discrepancy:** the README claims predictions use Claude (`claude-opus-4-8`) with `ANTHROPIC_API_KEY`, but the actual code (`src/pages/api/predict.ts`) uses the OpenAI SDK with `gpt-4o` and `OPENAI_API_KEY` (matching `.env.example`). Trust the code, not the README.

## Commands

```sh
npm run dev        # dev server
npm run build      # production build to dist/
npm run preview    # preview the build
npm run seed       # seed Supabase from data/world_cup_2026.json (uses node --env-file=.env, needs Node 20.6+)
npm run map-teams  # inject external IDs (eloratings/API-Football/FBref) into team_stats for all 48 teams
npm run ingest     # real-data ingestion (API-Football + eloratings.net + FBref/Apify) — writes to Supabase; only processes teams whose api_football_team_id is set
npx astro check    # type-check (.astro + TS); no lint or test setup exists
```

Setup requires a `.env` (copy from `.env.example`) with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, and optionally `SPORTS_API_URL`/`SPORTS_API_KEY`. The DB schema must be created manually by running `supabase/schema.sql` in the Supabase SQL editor; there are no migrations.

## Architecture

Data flow has four pieces:

1. **Seed layer** — `data/world_cup_2026.json` (48 teams, 72 matches, simulated stats) → `scripts/seed.js` → Supabase tables `matches` and `team_stats` (defined in `supabase/schema.sql`). Matches upsert on `api_id` but deliberately omit scores/status/prediction_cache so re-seeding never clobbers results or cached predictions; `team_stats` is insert-only (`ignoreDuplicates`) so re-seeding never overwrites ingested real stats. Matches carry `group_name`/`matchday` from the JSON.

2. **Hybrid calendar sync** — `src/lib/matches.ts#getCalendar()` reads all matches, finds ones that are `pending` but whose date has passed ("stale"), and lazily syncs their results from the external sports API (if `SPORTS_API_URL`/`SPORTS_API_KEY` are set) before re-reading. Sync failures are silently skipped per-match; without API credentials it just returns the data as-is. This happens on every page load of `index.astro` — there is no background job.

3. **Prediction endpoint** — `POST /api/predict` (`src/pages/api/predict.ts`) takes `{ matchId }`, rejects finished matches (409), and joins both teams' rows from `team_stats`. All math is deterministic TypeScript in `src/lib/prediction-engine.ts` (`buildDeterministicReport`): full Poisson scoreline matrix (0–10 goals), Elo expectation `E = 1/(1+10^(-d/400))` split three ways using the Poisson draw as anchor, and a recency-weighted form/xG panel; percentages use largest-remainder rounding so each method sums to exactly 100. xG is nullable (`avg_xg_for/against: number | null`): when either team lacks xG the form panel reports `xg_disponible: false` with null deltas, the math degrades to Poisson + Elo only, and the system prompt instructs the LLM to weight consensus and certainty accordingly. The LLM (`gpt-4o`, `temperature: 0`) only does consensus + textual synthesis over those pre-computed numbers. Output is strictly validated (`validateRules`): integer probabilities summing to exactly 100, `G-G` score format, winner ∈ {home, away, Empate}, score/winner/max-probability coherence — with one retry that feeds the validation error back. Changing the `Prediction` shape requires touching the system prompt's JSON template, the `Prediction` interface, and `parseStructure` together. The response adds a `motor_determinista` field alongside `prediction`; the UI only reads `prediction`.

4. **Prediction cache** — `matches.prediction_cache` (JSONB) stores `{ prediction, motor_determinista, generado_en }` (`PredictionCache` in `src/lib/prediction-types.ts`). The endpoint returns it instantly (`cached: true`) when present; otherwise it generates, UPDATEs the cache, and returns `cached: false`. Finished matches still 409 before the cache check.

5. **UI** — split-panel "liquid glass" layout in `src/pages/index.astro` (SSR): CSS Grid `350px 1fr`, scrollable calendar sidebar, main analysis view rendered client-side (big circular flags via `src/lib/flags.ts` → flagcdn.com keyed by `eloratings_team_name`, stacked probability bar, head-to-head stats table from `team_stats`, consensus text). Data reaches the client through a `<script type="application/json" id="app-data">` payload. `src/pages/grupos.astro` renders 12 hybrid standings tables computed by `src/lib/standings.ts`: real score if `status === 'finished'`, else cached prediction's `marcador_exacto`, else the match doesn't count; rows deduped/sorted by points → goal difference → goals for. All plain scoped CSS with shared variables in `Layout.astro` (which also holds the top nav); glass panels use rgba + backdrop-filter only — no solid table backgrounds, no Tailwind.

6. **Real-data ingestion** — `npm run ingest` runs `scripts/ingest-real-data.js` (plain JS importing `.ts` providers via `node --import tsx`). Providers implement the contracts in `src/lib/ingestion/contracts.ts`. Active sources, in run order: `football-data.ts` (football-data.org via existing `SPORTS_API_URL`/`SPORTS_API_KEY`; resolves team IDs by name from `/competitions/{WC,EC}/teams`, splits the cycle into ≤730-day windows because the API caps at 750, throttles ~6.5s for the 10 req/min free tier — note: free tier yields almost no historical national-team matches, it ran with 0 records), `open-data.ts` (martj42/international_results CSV on GitHub, no key needed — this is the actual workhorse for real goals/W-D-L, 2228 matches ingested for all 48 teams), and `scrapers.ts` eloratings.net (static TSV endpoints: `World.tsv` current, `2022.tsv` cycle-start anchor, `en.teams.tsv` aliases). FBref/Apify xG is gated off behind `FBREF_INGESTION_ENABLED=true` — the configured generic Apify web-scraper actor (input: `startUrls` + `pageFunction`) is blocked by FBref's anti-bot even with proxies. `npm run map-teams` must run first: the orchestrator only processes teams with `eloratings_team_name` set (all 48 since the full mapping; the name doubles as the lookup key for open-data and football-data, which resolve by English name — it must match the CSV byte-for-byte, e.g. `Curaçao` with cedilla). Aggregates recompute from `team_match_history` (deduped by match_date) for teams with ≥5 matches; `avg_xg_for/against` become NULL when no real xG exists and `data_source` becomes `real`. API-Football provider (`api-football.ts`) exists but is unused until `API_FOOTBALL_KEY` is configured; 9 of the 48 teams still lack a verified `api_football_team_id` (marked null in `scripts/map-teams.js`).

## Notes

- The server uses the Supabase **service role key** (`src/lib/supabase.ts`), bypassing RLS; the schema's RLS policies only allow public reads, so all writes must go through server code or the seed script.
- Env vars are read via `import.meta.env` in app code but `process.env` in `scripts/seed.js` (which runs outside Astro).
- `dist/` is build output — never edit it.
