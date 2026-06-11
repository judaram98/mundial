create table if not exists matches (
  id bigint generated always as identity primary key,
  api_id integer not null unique,
  date timestamptz not null,
  home_team text not null,
  away_team text not null,
  home_score integer,
  away_score integer,
  status text not null default 'pending' check (status in ('pending', 'finished')),
  group_name text,
  matchday integer,
  prediction_cache jsonb
);

alter table matches add column if not exists group_name text;
alter table matches add column if not exists matchday integer;
alter table matches add column if not exists prediction_cache jsonb;
alter table matches add column if not exists stage text not null default 'group';
alter table matches drop constraint if exists matches_stage_check;
alter table matches add constraint matches_stage_check
  check (stage in ('group', 'round_32', 'round_16', 'quarter', 'semi', 'third', 'final'));
alter table matches drop constraint if exists matches_status_check;
alter table matches add constraint matches_status_check
  check (status in ('pending', 'awaiting_teams', 'finished'));
create index if not exists matches_group_idx on matches (group_name);
create index if not exists matches_stage_idx on matches (stage);

create table if not exists team_stats (
  team_name text primary key,
  elo integer not null,
  elo_cycle_start integer not null,
  avg_goals_scored numeric(4, 2) not null,
  avg_goals_conceded numeric(4, 2) not null,
  avg_xg_for numeric(4, 2),
  avg_xg_against numeric(4, 2),
  matches_played integer not null check (matches_played >= 0),
  wins integer not null check (wins >= 0),
  draws integer not null check (draws >= 0),
  losses integer not null check (losses >= 0),
  form_last_five text not null check (form_last_five ~ '^[WDL]{5}$'),
  form_trend text not null check (form_trend in ('up', 'stable', 'down')),
  stats_period_start date not null,
  stats_period_end date not null,
  data_source text not null default 'simulated',
  check (wins + draws + losses = matches_played),
  check (stats_period_start < stats_period_end)
);

alter table team_stats add column if not exists api_football_team_id integer;
alter table team_stats add column if not exists fbref_team_id text;
alter table team_stats add column if not exists eloratings_team_name text;
alter table team_stats add column if not exists last_synced_at timestamptz;
alter table team_stats alter column avg_xg_for drop not null;
alter table team_stats alter column avg_xg_against drop not null;

create table if not exists team_match_history (
  id bigint generated always as identity primary key,
  team_name text not null references team_stats (team_name) on delete cascade,
  match_date date not null,
  opponent text not null,
  competition text,
  is_home boolean,
  goals_for integer not null check (goals_for >= 0),
  goals_against integer not null check (goals_against >= 0),
  xg_for numeric(4, 2) check (xg_for >= 0),
  xg_against numeric(4, 2) check (xg_against >= 0),
  result text not null check (result in ('W', 'D', 'L')),
  source text not null,
  external_ref text,
  unique (team_name, match_date, opponent)
);

alter table team_match_history drop constraint if exists team_match_history_source_check;
alter table team_match_history add constraint team_match_history_source_check
  check (source in ('api_football', 'football_data', 'open_data', 'fbref', 'simulated'));

create table if not exists team_elo_history (
  id bigint generated always as identity primary key,
  team_name text not null references team_stats (team_name) on delete cascade,
  recorded_on date not null,
  elo integer not null,
  source text not null check (source in ('eloratings', 'simulated')),
  unique (team_name, recorded_on, source)
);

create table if not exists ingestion_runs (
  id bigint generated always as identity primary key,
  source text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  records_upserted integer not null default 0 check (records_upserted >= 0),
  detail text
);

alter table ingestion_runs drop constraint if exists ingestion_runs_source_check;
alter table ingestion_runs add constraint ingestion_runs_source_check
  check (source in ('api_football', 'football_data', 'open_data', 'eloratings', 'fbref'));

create index if not exists matches_date_idx on matches (date);
create index if not exists matches_status_idx on matches (status);
create unique index if not exists team_stats_api_football_idx
  on team_stats (api_football_team_id)
  where api_football_team_id is not null;
create index if not exists team_match_history_team_date_idx
  on team_match_history (team_name, match_date desc);
create index if not exists team_elo_history_team_date_idx
  on team_elo_history (team_name, recorded_on desc);
create index if not exists ingestion_runs_source_idx on ingestion_runs (source, started_at desc);

alter table matches enable row level security;
alter table team_stats enable row level security;
alter table team_match_history enable row level security;
alter table team_elo_history enable row level security;
alter table ingestion_runs enable row level security;

drop policy if exists "matches_public_read" on matches;
drop policy if exists "team_stats_public_read" on team_stats;
drop policy if exists "team_match_history_public_read" on team_match_history;
drop policy if exists "team_elo_history_public_read" on team_elo_history;

create policy "matches_public_read" on matches for select using (true);
create policy "team_stats_public_read" on team_stats for select using (true);
create policy "team_match_history_public_read" on team_match_history for select using (true);
create policy "team_elo_history_public_read" on team_elo_history for select using (true);
