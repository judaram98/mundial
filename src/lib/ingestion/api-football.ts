import type {
  CyclePeriod,
  MatchHistoryProvider,
  TeamMatchHistoryRecord,
  TeamSourceIdentifiers
} from './contracts';

export interface ApiFootballConfig {
  baseUrl: string;
  apiKey: string;
  requestIntervalMs: number;
  maxRetries: number;
  retryDelayMs: number;
}

interface ApiFootballPayload {
  response?: unknown[];
  paging?: { current?: number; total?: number };
  errors?: unknown;
}

const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectErrorMessages(errors: unknown): string[] {
  if (Array.isArray(errors)) {
    return errors.map(String);
  }
  if (errors && typeof errors === 'object') {
    return Object.values(errors as Record<string, unknown>).map(String);
  }
  return [];
}

class ApiFootballClient {
  private lastRequestAt = 0;

  constructor(private readonly config: ApiFootballConfig) {}

  async getAllPages(path: string, params: Record<string, string>): Promise<unknown[]> {
    const results: unknown[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const payload = await this.getPage(path, { ...params, page: String(page) });
      results.push(...(payload.response ?? []));
      totalPages = payload.paging?.total ?? 1;
      page += 1;
    } while (page <= totalPages);

    return results;
  }

  private async throttle(): Promise<void> {
    const waitMs = this.config.requestIntervalMs - (Date.now() - this.lastRequestAt);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    this.lastRequestAt = Date.now();
  }

  private async getPage(path: string, params: Record<string, string>): Promise<ApiFootballPayload> {
    const url = new URL(path, this.config.baseUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt += 1) {
      await this.throttle();

      const response = await fetch(url, {
        headers: {
          'x-apisports-key': this.config.apiKey,
          Accept: 'application/json'
        }
      });

      if (response.status === 429) {
        if (attempt === this.config.maxRetries) {
          throw new Error('API-Football: límite de peticiones agotado tras agotar los reintentos.');
        }
        await sleep(this.config.retryDelayMs);
        continue;
      }

      if (!response.ok) {
        throw new Error(`API-Football respondió ${response.status} para ${url.pathname}.`);
      }

      const payload = (await response.json()) as ApiFootballPayload;
      const errorMessages = collectErrorMessages(payload.errors);

      if (errorMessages.length > 0) {
        throw new Error(`API-Football devolvió errores: ${errorMessages.join(' | ')}`);
      }

      return payload;
    }

    throw new Error('API-Football: reintentos agotados sin respuesta válida.');
  }
}

function mapFixture(team: TeamSourceIdentifiers, raw: unknown): TeamMatchHistoryRecord | null {
  const fixture = raw as {
    fixture?: { id?: number; date?: string; status?: { short?: string } };
    league?: { name?: string };
    teams?: { home?: { id?: number; name?: string }; away?: { id?: number; name?: string } };
    goals?: { home?: number | null; away?: number | null };
  };

  if (!FINISHED_STATUSES.has(String(fixture?.fixture?.status?.short))) {
    return null;
  }

  const goalsHome = fixture?.goals?.home;
  const goalsAway = fixture?.goals?.away;

  if (typeof goalsHome !== 'number' || typeof goalsAway !== 'number') {
    return null;
  }

  const isHome = fixture?.teams?.home?.id === team.api_football_team_id;
  const isAway = fixture?.teams?.away?.id === team.api_football_team_id;

  if (!isHome && !isAway) {
    return null;
  }

  const opponent = isHome ? fixture?.teams?.away?.name : fixture?.teams?.home?.name;
  const matchDate = String(fixture?.fixture?.date ?? '').slice(0, 10);

  if (!opponent || !/^\d{4}-\d{2}-\d{2}$/.test(matchDate)) {
    return null;
  }

  const goalsFor = isHome ? goalsHome : goalsAway;
  const goalsAgainst = isHome ? goalsAway : goalsHome;

  return {
    team_name: team.team_name,
    match_date: matchDate,
    opponent: String(opponent),
    competition: fixture?.league?.name ?? null,
    is_home: isHome,
    goals_for: goalsFor,
    goals_against: goalsAgainst,
    xg_for: null,
    xg_against: null,
    result: goalsFor > goalsAgainst ? 'W' : goalsFor === goalsAgainst ? 'D' : 'L',
    source: 'api_football',
    external_ref: fixture?.fixture?.id != null ? String(fixture.fixture.id) : null
  };
}

export function createApiFootballProvider(
  overrides: Partial<ApiFootballConfig> = {}
): MatchHistoryProvider {
  const config: ApiFootballConfig = {
    baseUrl: process.env.API_FOOTBALL_BASE_URL ?? 'https://v3.football.api-sports.io',
    apiKey: process.env.API_FOOTBALL_KEY ?? '',
    requestIntervalMs: 6500,
    maxRetries: 3,
    retryDelayMs: 61000,
    ...overrides
  };

  if (!config.apiKey) {
    throw new Error('Falta la variable de entorno API_FOOTBALL_KEY.');
  }

  const client = new ApiFootballClient(config);

  return {
    source: 'api_football',
    async fetchTeamHistory(
      team: TeamSourceIdentifiers,
      period: CyclePeriod
    ): Promise<TeamMatchHistoryRecord[]> {
      if (team.api_football_team_id == null) {
        return [];
      }

      const fixtures = await client.getAllPages('/fixtures', {
        team: String(team.api_football_team_id),
        from: period.start,
        to: period.end
      });

      const records: TeamMatchHistoryRecord[] = [];

      for (const fixture of fixtures) {
        const record = mapFixture(team, fixture);
        if (record) {
          records.push(record);
        }
      }

      return records;
    }
  };
}
