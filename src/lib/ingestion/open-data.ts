import type {
  CyclePeriod,
  MatchHistoryProvider,
  TeamMatchHistoryRecord,
  TeamSourceIdentifiers
} from './contracts';
import { lookupCandidates } from './team-aliases';

export interface OpenDataConfig {
  csvUrl: string;
  userAgent: string;
}

interface OpenDataRow {
  date: string;
  home_team: string;
  away_team: string;
  home_score: number;
  away_score: number;
  tournament: string;
  neutral: boolean;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let insideQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (insideQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
      continue;
    }

    if (char === ',' && !insideQuotes) {
      cells.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells;
}

function parseResultsCsv(csv: string): OpenDataRow[] {
  const lines = csv.split('\n');
  const rows: OpenDataRow[] = [];

  for (const line of lines.slice(1)) {
    if (!line.trim()) {
      continue;
    }

    const cells = parseCsvLine(line);

    if (cells.length < 9) {
      continue;
    }

    const [date, homeTeam, awayTeam, homeScore, awayScore, tournament] = cells;
    const neutral = cells[8].trim().toUpperCase() === 'TRUE';

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d+$/.test(homeScore) || !/^\d+$/.test(awayScore)) {
      continue;
    }

    rows.push({
      date,
      home_team: homeTeam.trim(),
      away_team: awayTeam.trim(),
      home_score: Number(homeScore),
      away_score: Number(awayScore),
      tournament: tournament.trim(),
      neutral
    });
  }

  return rows;
}

function toRecord(
  team: TeamSourceIdentifiers,
  row: OpenDataRow,
  isHome: boolean
): TeamMatchHistoryRecord {
  const goalsFor = isHome ? row.home_score : row.away_score;
  const goalsAgainst = isHome ? row.away_score : row.home_score;

  return {
    team_name: team.team_name,
    match_date: row.date,
    opponent: isHome ? row.away_team : row.home_team,
    competition: row.tournament || null,
    is_home: row.neutral ? null : isHome,
    goals_for: goalsFor,
    goals_against: goalsAgainst,
    xg_for: null,
    xg_against: null,
    result: goalsFor > goalsAgainst ? 'W' : goalsFor === goalsAgainst ? 'D' : 'L',
    source: 'open_data',
    external_ref: null
  };
}

export function createOpenDataProvider(
  overrides: Partial<OpenDataConfig> = {}
): MatchHistoryProvider {
  const config: OpenDataConfig = {
    csvUrl:
      process.env.OPEN_RESULTS_CSV_URL ??
      'https://raw.githubusercontent.com/martj42/international_results/master/results.csv',
    userAgent: process.env.INGESTION_USER_AGENT ?? 'Mundial2026Predictor/1.0',
    ...overrides
  };

  let rowsPromise: Promise<OpenDataRow[]> | null = null;

  const loadRows = (): Promise<OpenDataRow[]> => {
    rowsPromise ??= (async () => {
      const response = await fetch(config.csvUrl, {
        headers: { 'User-Agent': config.userAgent, Accept: 'text/csv, text/plain' }
      });

      if (!response.ok) {
        throw new Error(`El dataset abierto respondió ${response.status} para ${config.csvUrl}.`);
      }

      const rows = parseResultsCsv(await response.text());

      if (rows.length === 0) {
        throw new Error('El dataset abierto no contiene filas válidas.');
      }

      return rows;
    })();

    return rowsPromise;
  };

  return {
    source: 'open_data',
    async fetchTeamHistory(
      team: TeamSourceIdentifiers,
      period: CyclePeriod
    ): Promise<TeamMatchHistoryRecord[]> {
      const candidates = new Set(lookupCandidates(team.eloratings_team_name ?? team.team_name));
      const rows = await loadRows();
      const records: TeamMatchHistoryRecord[] = [];

      for (const row of rows) {
        if (row.date < period.start || row.date > period.end) {
          continue;
        }

        if (candidates.has(row.home_team)) {
          records.push(toRecord(team, row, true));
        } else if (candidates.has(row.away_team)) {
          records.push(toRecord(team, row, false));
        }
      }

      return records;
    }
  };
}
