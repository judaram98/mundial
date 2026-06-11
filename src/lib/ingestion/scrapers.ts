import * as cheerio from 'cheerio';
import type {
  CyclePeriod,
  EloHistoryProvider,
  EloSnapshotRecord,
  TeamMatchHistoryRecord,
  TeamSourceIdentifiers,
  XgHistoryProvider
} from './contracts';

export interface EloRatingsConfig {
  baseUrl: string;
  currentFile: string;
  cycleStartFile: string;
  cycleStartDate: string;
  userAgent: string;
}

export interface FbrefApifyConfig {
  webhookUrl: string;
  token: string | null;
  fbrefBaseUrl: string;
  proxyGroups: string[] | null;
  navigationTimeoutSecs: number;
  timeoutMs: number;
}

const RATING_MIN = 800;
const RATING_MAX = 2600;

const FBREF_PAGE_FUNCTION = `async function pageFunction(context) {
  const $ = context.$ || context.jQuery;
  const request = context.request;
  const rows = [];
  $('table[id^="matchlogs"] tbody tr').each(function () {
    const tr = $(this);
    const cell = function (name) {
      return tr.find('[data-stat="' + name + '"]').text().trim();
    };
    const date = cell('date');
    if (!date) return;
    rows.push({
      match_date: date,
      competition: cell('comp'),
      venue: cell('venue'),
      result: cell('result'),
      gf: cell('goals_for'),
      ga: cell('goals_against'),
      opponent: cell('opponent'),
      xg: cell('xg_for'),
      xga: cell('xg_against'),
      source_url: request.url
    });
  });
  return rows;
}`;

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

async function fetchText(url: string, userAgent: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': userAgent,
      Accept: 'text/tab-separated-values, text/plain, text/html'
    }
  });

  if (!response.ok) {
    throw new Error(`eloratings.net respondió ${response.status} para ${url}.`);
  }

  return response.text();
}

function buildAliasIndex(teamsTsv: string): Map<string, string> {
  const aliasToCode = new Map<string, string>();

  for (const line of teamsTsv.split('\n')) {
    const cells = line
      .split('\t')
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);

    if (cells.length < 2 || cells[0].includes('_')) {
      continue;
    }

    for (const alias of cells.slice(1)) {
      aliasToCode.set(normalizeName(alias), cells[0]);
    }
  }

  return aliasToCode;
}

function extractRatingFromCells(
  cells: string[],
  matchCell: (cell: string) => string | null
): { code: string; rating: number } | null {
  for (let index = 0; index < cells.length - 1; index += 1) {
    const code = matchCell(cells[index].trim());

    if (!code) {
      continue;
    }

    const rating = Number(cells[index + 1].trim());

    if (Number.isInteger(rating) && rating >= RATING_MIN && rating <= RATING_MAX) {
      return { code, rating };
    }
  }

  return null;
}

function parseRatingsTsv(ratingsTsv: string, knownCodes: Set<string>): Map<string, number> {
  const ratings = new Map<string, number>();
  const matchCell = (cell: string): string | null => (knownCodes.has(cell) ? cell : null);

  for (const line of ratingsTsv.split('\n')) {
    const extracted = extractRatingFromCells(line.split('\t'), matchCell);
    if (extracted && !ratings.has(extracted.code)) {
      ratings.set(extracted.code, extracted.rating);
    }
  }

  return ratings;
}

function parseRatingsHtml(html: string, aliasIndex: Map<string, string>): Map<string, number> {
  const $ = cheerio.load(html);
  const ratings = new Map<string, number>();
  const matchCell = (cell: string): string | null => aliasIndex.get(normalizeName(cell)) ?? null;

  $('tr').each((_, row) => {
    const cells = $(row)
      .find('td, th')
      .map((__, cell) => $(cell).text())
      .get();

    const extracted = extractRatingFromCells(cells, matchCell);

    if (extracted && !ratings.has(extracted.code)) {
      ratings.set(extracted.code, extracted.rating);
    }
  });

  return ratings;
}

export function createEloRatingsProvider(
  overrides: Partial<EloRatingsConfig> = {}
): EloHistoryProvider {
  const config: EloRatingsConfig = {
    baseUrl: process.env.ELORATINGS_BASE_URL ?? 'https://www.eloratings.net',
    currentFile: process.env.ELORATINGS_CURRENT_FILE ?? 'World',
    cycleStartFile: process.env.ELORATINGS_CYCLE_START_FILE ?? '2022',
    cycleStartDate: process.env.ELORATINGS_CYCLE_START_DATE ?? '2022-12-31',
    userAgent: process.env.INGESTION_USER_AGENT ?? 'Mundial2026Predictor/1.0',
    ...overrides
  };

  let aliasIndexPromise: Promise<Map<string, string>> | null = null;
  const ratingsCache = new Map<string, Promise<Map<string, number>>>();

  const loadAliasIndex = (): Promise<Map<string, string>> => {
    aliasIndexPromise ??= fetchText(`${config.baseUrl}/en.teams.tsv`, config.userAgent).then(
      buildAliasIndex
    );
    return aliasIndexPromise;
  };

  const loadRatings = (file: string): Promise<Map<string, number>> => {
    const cached = ratingsCache.get(file);

    if (cached) {
      return cached;
    }

    const pending = (async () => {
      const aliasIndex = await loadAliasIndex();
      const knownCodes = new Set(aliasIndex.values());

      try {
        const tsv = await fetchText(`${config.baseUrl}/${file}.tsv`, config.userAgent);
        const ratings = parseRatingsTsv(tsv, knownCodes);

        if (ratings.size > 0) {
          return ratings;
        }
      } catch {
        ratingsCache.delete(file);
      }

      const html = await fetchText(`${config.baseUrl}/${file}`, config.userAgent);
      const ratings = parseRatingsHtml(html, aliasIndex);

      if (ratings.size === 0) {
        throw new Error(`No fue posible extraer ratings de eloratings.net para "${file}".`);
      }

      return ratings;
    })();

    ratingsCache.set(file, pending);
    return pending;
  };

  return {
    source: 'eloratings',
    async fetchEloHistory(
      team: TeamSourceIdentifiers,
      _period: CyclePeriod
    ): Promise<EloSnapshotRecord[]> {
      if (!team.eloratings_team_name) {
        return [];
      }

      const aliasIndex = await loadAliasIndex();
      const code = aliasIndex.get(normalizeName(team.eloratings_team_name));

      if (!code) {
        return [];
      }

      const [currentRatings, cycleStartRatings] = await Promise.all([
        loadRatings(config.currentFile),
        loadRatings(config.cycleStartFile)
      ]);

      const snapshots: EloSnapshotRecord[] = [];
      const cycleStartElo = cycleStartRatings.get(code);
      const currentElo = currentRatings.get(code);

      if (cycleStartElo != null) {
        snapshots.push({
          team_name: team.team_name,
          recorded_on: config.cycleStartDate,
          elo: cycleStartElo,
          source: 'eloratings'
        });
      }

      if (currentElo != null) {
        snapshots.push({
          team_name: team.team_name,
          recorded_on: new Date().toISOString().slice(0, 10),
          elo: currentElo,
          source: 'eloratings'
        });
      }

      return snapshots;
    }
  };
}

function parseLeadingInt(value: unknown): number | null {
  const match = String(value ?? '').match(/^\d+/);

  if (!match) {
    return null;
  }

  return Number(match[0]);
}

function toNullableNumber(value: unknown): number | null {
  if (value == null || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveIsHome(venue: unknown): boolean | null {
  const normalized = String(venue ?? '').toLowerCase();

  if (normalized === 'home') {
    return true;
  }

  if (normalized === 'away') {
    return false;
  }

  return null;
}

function cycleSeasons(period: CyclePeriod): number[] {
  const startYear = Number(period.start.slice(0, 4));
  const endYear = Number(period.end.slice(0, 4));
  const seasons: number[] = [];

  for (let year = startYear; year <= endYear; year += 1) {
    seasons.push(year);
  }

  return seasons;
}

function normalizeFbrefRecord(
  team: TeamSourceIdentifiers,
  value: unknown,
  period: CyclePeriod
): TeamMatchHistoryRecord | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const raw = value as Record<string, unknown>;

  if (raw['#error']) {
    return null;
  }

  const matchDate = String(raw.match_date ?? '').slice(0, 10);
  const opponent = String(raw.opponent ?? '').trim();
  const goalsFor = parseLeadingInt(raw.gf);
  const goalsAgainst = parseLeadingInt(raw.ga);

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(matchDate) ||
    matchDate < period.start ||
    matchDate > period.end ||
    !opponent ||
    goalsFor == null ||
    goalsAgainst == null
  ) {
    return null;
  }

  const reportedResult = String(raw.result ?? '').trim().toUpperCase();
  const derivedResult = goalsFor > goalsAgainst ? 'W' : goalsFor === goalsAgainst ? 'D' : 'L';

  return {
    team_name: team.team_name,
    match_date: matchDate,
    opponent,
    competition: raw.competition ? String(raw.competition) : null,
    is_home: resolveIsHome(raw.venue),
    goals_for: goalsFor,
    goals_against: goalsAgainst,
    xg_for: toNullableNumber(raw.xg),
    xg_against: toNullableNumber(raw.xga),
    result: ['W', 'D', 'L'].includes(reportedResult)
      ? (reportedResult as 'W' | 'D' | 'L')
      : derivedResult,
    source: 'fbref',
    external_ref: raw.source_url ? String(raw.source_url) : null
  };
}

export function createFbrefApifyProvider(
  overrides: Partial<FbrefApifyConfig> = {}
): XgHistoryProvider {
  const proxyGroupsEnv = process.env.APIFY_PROXY_GROUPS;

  const config: FbrefApifyConfig = {
    webhookUrl: process.env.APIFY_FBREF_WEBHOOK ?? '',
    token: process.env.APIFY_TOKEN ?? null,
    fbrefBaseUrl: process.env.FBREF_BASE_URL ?? 'https://fbref.com',
    proxyGroups: proxyGroupsEnv
      ? proxyGroupsEnv.split(',').map((group) => group.trim()).filter(Boolean)
      : null,
    navigationTimeoutSecs: 90,
    timeoutMs: 300000,
    ...overrides
  };

  if (!config.webhookUrl) {
    throw new Error('Falta la variable de entorno APIFY_FBREF_WEBHOOK.');
  }

  return {
    source: 'fbref',
    async fetchXgHistory(
      team: TeamSourceIdentifiers,
      period: CyclePeriod
    ): Promise<TeamMatchHistoryRecord[]> {
      if (!team.fbref_team_id) {
        return [];
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      };

      if (config.token) {
        headers.Authorization = `Bearer ${config.token}`;
      }

      const startUrls = cycleSeasons(period).map((season) => ({
        url: `${config.fbrefBaseUrl}/en/squads/${team.fbref_team_id}/${season}/matchlogs/all_comps/schedule/Scores-and-Fixtures`
      }));

      const proxyConfiguration: Record<string, unknown> = { useApifyProxy: true };

      if (config.proxyGroups && config.proxyGroups.length > 0) {
        proxyConfiguration.apifyProxyGroups = config.proxyGroups;
      }

      const response = await fetch(config.webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          startUrls,
          pageFunction: FBREF_PAGE_FUNCTION,
          injectJQuery: true,
          proxyConfiguration,
          waitUntil: 'domcontentloaded',
          navigationTimeoutSecs: config.navigationTimeoutSecs
        }),
        signal: AbortSignal.timeout(config.timeoutMs)
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 200);
        throw new Error(`El actor de Apify respondió ${response.status} para ${team.team_name}: ${detail}`);
      }

      const payload = (await response.json()) as unknown;
      const items: unknown[] = Array.isArray(payload) ? payload : [];
      const blockedItems = items.filter(
        (item) => typeof item === 'object' && item !== null && (item as Record<string, unknown>)['#error']
      );

      const records: TeamMatchHistoryRecord[] = [];

      for (const item of items) {
        const record = normalizeFbrefRecord(team, item, period);
        if (record) {
          records.push(record);
        }
      }

      if (records.length === 0 && blockedItems.length > 0) {
        throw new Error(
          `FBref bloqueó el rastreo para ${team.team_name} (${blockedItems.length} URLs con error); el actor necesita proxy residencial o un actor dedicado.`
        );
      }

      return records;
    }
  };
}
