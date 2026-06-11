import { supabase } from './supabase';
import type { PredictionCache } from './prediction-types';
import type { MatchStage } from './stages';

export interface Match {
  id: number;
  api_id: number;
  date: string;
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
  status: 'pending' | 'awaiting_teams' | 'finished';
  group_name: string | null;
  matchday: number | null;
  stage: MatchStage;
  prediction_cache: PredictionCache | null;
}

interface ExternalFixtureResult {
  home_score: number;
  away_score: number;
  finished: boolean;
}

export async function getCalendar(): Promise<Match[]> {
  const matches = await fetchAllMatches();
  const staleMatches = findStaleMatches(matches);

  if (staleMatches.length === 0) {
    return matches;
  }

  const syncedAny = await syncStaleMatches(staleMatches);
  return syncedAny ? fetchAllMatches() : matches;
}

async function fetchAllMatches(): Promise<Match[]> {
  const { data, error } = await supabase
    .from('matches')
    .select('*')
    .order('date', { ascending: true });

  if (error) {
    throw new Error(`Error al consultar el calendario: ${error.message}`);
  }

  return (data ?? []) as Match[];
}

function findStaleMatches(matches: Match[]): Match[] {
  const now = Date.now();
  return matches.filter(
    (match) => match.status === 'pending' && new Date(match.date).getTime() < now
  );
}

async function syncStaleMatches(staleMatches: Match[]): Promise<boolean> {
  const apiUrl = import.meta.env.SPORTS_API_URL;
  const apiKey = import.meta.env.SPORTS_API_KEY;

  if (!apiUrl || !apiKey) {
    return false;
  }

  let updatedAny = false;

  for (const match of staleMatches) {
    try {
      const result = await fetchExternalResult(apiUrl, apiKey, match.api_id);

      if (!result || !result.finished) {
        continue;
      }

      const { error } = await supabase
        .from('matches')
        .update({
          home_score: result.home_score,
          away_score: result.away_score,
          status: 'finished'
        })
        .eq('id', match.id);

      if (!error) {
        updatedAny = true;
      }
    } catch {
      continue;
    }
  }

  return updatedAny;
}

async function fetchExternalResult(
  apiUrl: string,
  apiKey: string,
  apiId: number
): Promise<ExternalFixtureResult | null> {
  const response = await fetch(`${apiUrl}/fixtures/${apiId}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  const fixture = payload?.fixture ?? payload?.data ?? payload;

  const homeScore = Number(fixture?.home_score ?? fixture?.score?.home);
  const awayScore = Number(fixture?.away_score ?? fixture?.score?.away);
  const statusValue = String(fixture?.status ?? '').toLowerCase();

  if (Number.isNaN(homeScore) || Number.isNaN(awayScore)) {
    return null;
  }

  return {
    home_score: homeScore,
    away_score: awayScore,
    finished: ['finished', 'ft', 'completed'].includes(statusValue)
  };
}
