import type {
  CyclePeriod,
  MatchHistoryProvider,
  TeamMatchHistoryRecord,
  TeamSourceIdentifiers
} from './contracts';
import { lookupCandidates } from './team-aliases';

export interface FootballDataConfig {
  baseUrl: string;
  apiKey: string;
  competitionCodes: string[];
  requestIntervalMs: number;
  maxRetries: number;
  retryDelayMs: number;
  maxWindowDays: number;
}

interface ApiResult {
  status: number;
  payload: Record<string, unknown> | null;
}

interface FootballDataTeam {
  id?: number;
  name?: string;
  shortName?: string;
}

interface FootballDataMatch {
  id?: number;
  utcDate?: string;
  status?: string;
  competition?: { name?: string };
  homeTeam?: { id?: number; name?: string };
  awayTeam?: { id?: number; name?: string };
  score?: { fullTime?: { home?: number | null; away?: number | null } };
}

const DAY_MS = 86400000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

function splitPeriod(period: CyclePeriod, maxWindowDays: number): CyclePeriod[] {
  const windows: CyclePeriod[] = [];
  let cursor = new Date(`${period.start}T00:00:00Z`).getTime();
  const end = new Date(`${period.end}T00:00:00Z`).getTime();

  while (cursor <= end) {
    const windowEnd = Math.min(cursor + (maxWindowDays - 1) * DAY_MS, end);
    windows.push({
      start: new Date(cursor).toISOString().slice(0, 10),
      end: new Date(windowEnd).toISOString().slice(0, 10)
    });
    cursor = windowEnd + DAY_MS;
  }

  return windows;
}

class FootballDataClient {
  private lastRequestAt = 0;

  constructor(private readonly config: FootballDataConfig) {}

  async get(path: string, params: Record<string, string> = {}): Promise<ApiResult> {
    const url = new URL(path, this.config.baseUrl);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt += 1) {
      await this.throttle();

      const response = await fetch(url, {
        headers: { 'X-Auth-Token': this.config.apiKey, Accept: 'application/json' }
      });

      if (response.status === 429) {
        if (attempt === this.config.maxRetries) {
          throw new Error('football-data.org: límite de peticiones agotado tras los reintentos.');
        }
        await sleep(this.config.retryDelayMs);
        continue;
      }

      const payload = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;

      return { status: response.status, payload };
    }

    throw new Error('football-data.org: reintentos agotados sin respuesta válida.');
  }

  private async throttle(): Promise<void> {
    const waitMs = this.config.requestIntervalMs - (Date.now() - this.lastRequestAt);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    this.lastRequestAt = Date.now();
  }
}

function mapMatch(
  team: TeamSourceIdentifiers,
  teamId: number,
  raw: FootballDataMatch
): TeamMatchHistoryRecord | null {
  if (raw.status !== 'FINISHED') {
    return null;
  }

  const goalsHome = raw.score?.fullTime?.home;
  const goalsAway = raw.score?.fullTime?.away;

  if (typeof goalsHome !== 'number' || typeof goalsAway !== 'number') {
    return null;
  }

  const isHome = raw.homeTeam?.id === teamId;
  const isAway = raw.awayTeam?.id === teamId;

  if (!isHome && !isAway) {
    return null;
  }

  const opponent = isHome ? raw.awayTeam?.name : raw.homeTeam?.name;
  const matchDate = String(raw.utcDate ?? '').slice(0, 10);

  if (!opponent || !/^\d{4}-\d{2}-\d{2}$/.test(matchDate)) {
    return null;
  }

  const goalsFor = isHome ? goalsHome : goalsAway;
  const goalsAgainst = isHome ? goalsAway : goalsHome;

  return {
    team_name: team.team_name,
    match_date: matchDate,
    opponent: String(opponent),
    competition: raw.competition?.name ?? null,
    is_home: isHome,
    goals_for: goalsFor,
    goals_against: goalsAgainst,
    xg_for: null,
    xg_against: null,
    result: goalsFor > goalsAgainst ? 'W' : goalsFor === goalsAgainst ? 'D' : 'L',
    source: 'football_data',
    external_ref: raw.id != null ? String(raw.id) : null
  };
}

export function createFootballDataProvider(
  overrides: Partial<FootballDataConfig> = {}
): MatchHistoryProvider {
  const competitionsEnv = process.env.FOOTBALL_DATA_COMPETITIONS;

  const config: FootballDataConfig = {
    baseUrl: process.env.SPORTS_API_URL ?? 'https://api.football-data.org/v4',
    apiKey: process.env.SPORTS_API_KEY ?? '',
    competitionCodes: competitionsEnv
      ? competitionsEnv.split(',').map((code) => code.trim()).filter(Boolean)
      : ['WC', 'EC'],
    requestIntervalMs: 6500,
    maxRetries: 3,
    retryDelayMs: 61000,
    maxWindowDays: 730,
    ...overrides
  };

  if (!config.apiKey) {
    throw new Error('Falta la variable de entorno SPORTS_API_KEY.');
  }

  const client = new FootballDataClient(config);
  let teamIndexPromise: Promise<Map<string, number>> | null = null;

  const loadTeamIndex = (): Promise<Map<string, number>> => {
    teamIndexPromise ??= (async () => {
      const index = new Map<string, number>();

      for (const code of config.competitionCodes) {
        const { status, payload } = await client.get(`/competitions/${code}/teams`);

        if (status !== 200 || !payload) {
          continue;
        }

        for (const entry of (payload.teams as FootballDataTeam[] | undefined) ?? []) {
          if (entry.id == null) {
            continue;
          }
          for (const alias of [entry.name, entry.shortName]) {
            if (alias && !index.has(normalizeName(alias))) {
              index.set(normalizeName(alias), entry.id);
            }
          }
        }
      }

      return index;
    })();

    return teamIndexPromise;
  };

  return {
    source: 'football_data',
    async fetchTeamHistory(
      team: TeamSourceIdentifiers,
      period: CyclePeriod
    ): Promise<TeamMatchHistoryRecord[]> {
      const index = await loadTeamIndex();
      let teamId: number | undefined;

      for (const candidate of lookupCandidates(team.eloratings_team_name ?? team.team_name)) {
        teamId = index.get(normalizeName(candidate));
        if (teamId != null) {
          break;
        }
      }

      if (teamId == null) {
        return [];
      }

      const records: TeamMatchHistoryRecord[] = [];

      for (const window of splitPeriod(period, config.maxWindowDays)) {
        const { status, payload } = await client.get(`/teams/${teamId}/matches`, {
          dateFrom: window.start,
          dateTo: window.end,
          limit: '500'
        });

        if (status !== 200 || !payload) {
          continue;
        }

        for (const raw of (payload.matches as FootballDataMatch[] | undefined) ?? []) {
          const record = mapMatch(team, teamId, raw);
          if (record) {
            records.push(record);
          }
        }
      }

      return records;
    }
  };
}
