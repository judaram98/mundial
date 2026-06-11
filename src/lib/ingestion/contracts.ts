export type IngestionSourceName =
  | 'api_football'
  | 'football_data'
  | 'open_data'
  | 'eloratings'
  | 'fbref';

export type MatchHistorySource =
  | 'api_football'
  | 'football_data'
  | 'open_data'
  | 'fbref'
  | 'simulated';

export type EloSnapshotSource = 'eloratings' | 'simulated';

export interface CyclePeriod {
  start: string;
  end: string;
}

export interface TeamSourceIdentifiers {
  team_name: string;
  api_football_team_id: number | null;
  fbref_team_id: string | null;
  eloratings_team_name: string | null;
}

export interface TeamMatchHistoryRecord {
  team_name: string;
  match_date: string;
  opponent: string;
  competition: string | null;
  is_home: boolean | null;
  goals_for: number;
  goals_against: number;
  xg_for: number | null;
  xg_against: number | null;
  result: 'W' | 'D' | 'L';
  source: MatchHistorySource;
  external_ref: string | null;
}

export interface EloSnapshotRecord {
  team_name: string;
  recorded_on: string;
  elo: number;
  source: EloSnapshotSource;
}

export interface MatchHistoryProvider {
  readonly source: IngestionSourceName;
  fetchTeamHistory(
    team: TeamSourceIdentifiers,
    period: CyclePeriod
  ): Promise<TeamMatchHistoryRecord[]>;
}

export interface EloHistoryProvider {
  readonly source: IngestionSourceName;
  fetchEloHistory(
    team: TeamSourceIdentifiers,
    period: CyclePeriod
  ): Promise<EloSnapshotRecord[]>;
}

export interface XgHistoryProvider {
  readonly source: IngestionSourceName;
  fetchXgHistory(
    team: TeamSourceIdentifiers,
    period: CyclePeriod
  ): Promise<TeamMatchHistoryRecord[]>;
}

export interface IngestionRunResult {
  source: IngestionSourceName;
  status: 'completed' | 'failed';
  records_upserted: number;
  detail: string | null;
}
