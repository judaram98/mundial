export interface TeamStats {
  team_name: string;
  elo: number;
  elo_cycle_start: number;
  avg_goals_scored: number;
  avg_goals_conceded: number;
  avg_xg_for: number | null;
  avg_xg_against: number | null;
  matches_played: number;
  wins: number;
  draws: number;
  losses: number;
  form_last_five: string;
  form_trend: 'up' | 'stable' | 'down';
  stats_period_start: string;
  stats_period_end: string;
  data_source: string;
}

export interface ThreeWayProbabilities {
  victoria_local: number;
  empate: number;
  victoria_visitante: number;
}

export interface PoissonModel {
  lambda_local: number;
  lambda_visitante: number;
  probabilidades: ThreeWayProbabilities;
  marcador_mas_probable: string;
  probabilidad_marcador: number;
  mejores_marcadores: {
    victoria_local: string;
    empate: string;
    victoria_visitante: string;
  };
}

export interface EloModel {
  elo_local: number;
  elo_visitante: number;
  diferencia: number;
  expectativa_local: number;
  delta_ciclo_local: number;
  delta_ciclo_visitante: number;
  paridad_tecnica: boolean;
  probabilidades: ThreeWayProbabilities;
}

export interface DrawRule {
  paridad_tecnica: boolean;
  diferencia_elo_absoluta: number;
  umbral_paridad_elo: number;
  probabilidad_empate_poisson: number;
  umbral_probabilidad_empate: number;
  empate_obligatorio: boolean;
}

export interface FormXgTeamPanel {
  puntuacion_forma: number;
  tendencia: 'up' | 'stable' | 'down';
  delta_finalizacion: number | null;
  delta_defensivo: number | null;
  balance_xg: number | null;
}

export interface FormXgModel {
  xg_disponible: boolean;
  local: FormXgTeamPanel;
  visitante: FormXgTeamPanel;
  favorece: string;
}

export interface DeterministicReport {
  simulacion_poisson: PoissonModel;
  diferencial_elo: EloModel;
  momento_forma_xg: FormXgModel;
  regla_empate: DrawRule;
}

export const ELO_PARITY_THRESHOLD = 60;
export const POISSON_DRAW_THRESHOLD = 23;

const MAX_GOALS = 10;
const MIN_LAMBDA = 0.05;
const MAX_DRAW_ANCHOR = 0.6;
const FORM_BALANCE_THRESHOLD = 0.15;
const FORM_WEIGHTS = [1, 1.25, 1.5, 1.75, 2];
const FORM_POINTS: Record<string, number> = { W: 3, D: 1, L: 0 };

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function poissonPmf(lambda: number, k: number): number {
  let probability = Math.exp(-lambda);
  for (let i = 1; i <= k; i += 1) {
    probability *= lambda / i;
  }
  return probability;
}

function toPercentages(home: number, draw: number, away: number): ThreeWayProbabilities {
  const total = home + draw + away;
  const exact = [home, draw, away].map((value) => (value / total) * 1000);
  const floored = exact.map(Math.floor);
  let remainder = 1000 - floored.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  for (const { index } of order) {
    if (remainder <= 0) {
      break;
    }
    floored[index] += 1;
    remainder -= 1;
  }

  return {
    victoria_local: floored[0] / 10,
    empate: floored[1] / 10,
    victoria_visitante: floored[2] / 10
  };
}

export function buildPoissonModel(home: TeamStats, away: TeamStats): PoissonModel {
  const lambdaHome = Math.max(MIN_LAMBDA, (home.avg_goals_scored + away.avg_goals_conceded) / 2);
  const lambdaAway = Math.max(MIN_LAMBDA, (away.avg_goals_scored + home.avg_goals_conceded) / 2);

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let totalMass = 0;
  let bestScore = '0-0';
  let bestCell = 0;
  
  let bestHomeWinScore = '1-0';
  let bestHomeWinCell = 0;
  let bestDrawScore = '0-0';
  let bestDrawCell = 0;
  let bestAwayWinScore = '0-1';
  let bestAwayWinCell = 0;

  for (let homeGoals = 0; homeGoals <= MAX_GOALS; homeGoals += 1) {
    const pHomeGoals = poissonPmf(lambdaHome, homeGoals);
    for (let awayGoals = 0; awayGoals <= MAX_GOALS; awayGoals += 1) {
      const cell = pHomeGoals * poissonPmf(lambdaAway, awayGoals);
      totalMass += cell;
      if (homeGoals > awayGoals) {
        homeWin += cell;
        if (cell > bestHomeWinCell) {
          bestHomeWinCell = cell;
          bestHomeWinScore = `${homeGoals}-${awayGoals}`;
        }
      } else if (homeGoals === awayGoals) {
        draw += cell;
        if (cell > bestDrawCell) {
          bestDrawCell = cell;
          bestDrawScore = `${homeGoals}-${awayGoals}`;
        }
      } else {
        awayWin += cell;
        if (cell > bestAwayWinCell) {
          bestAwayWinCell = cell;
          bestAwayWinScore = `${homeGoals}-${awayGoals}`;
        }
      }
      if (cell > bestCell) {
        bestCell = cell;
        bestScore = `${homeGoals}-${awayGoals}`;
      }
    }
  }

  return {
    lambda_local: roundTo(lambdaHome, 3),
    lambda_visitante: roundTo(lambdaAway, 3),
    probabilidades: toPercentages(homeWin, draw, awayWin),
    marcador_mas_probable: bestScore,
    probabilidad_marcador: roundTo((bestCell / totalMass) * 100, 1),
    mejores_marcadores: {
      victoria_local: bestHomeWinScore,
      empate: bestDrawScore,
      victoria_visitante: bestAwayWinScore
    }
  };
}

export function buildEloModel(home: TeamStats, away: TeamStats, drawAnchor: number): EloModel {
  const difference = home.elo - away.elo;
  const expectation = 1 / (1 + 10 ** (-difference / 400));
  const draw = Math.min(Math.max(drawAnchor, 0), MAX_DRAW_ANCHOR);
  const homeWin = Math.max(0, expectation - draw / 2);
  const awayWin = Math.max(0, 1 - expectation - draw / 2);

  return {
    elo_local: home.elo,
    elo_visitante: away.elo,
    diferencia: difference,
    expectativa_local: roundTo(expectation, 4),
    delta_ciclo_local: home.elo - home.elo_cycle_start,
    delta_ciclo_visitante: away.elo - away.elo_cycle_start,
    paridad_tecnica: Math.abs(difference) < ELO_PARITY_THRESHOLD,
    probabilidades: toPercentages(homeWin, draw, awayWin)
  };
}

export function buildDrawRule(poisson: PoissonModel, elo: EloModel): DrawRule {
  const drawProbability = poisson.probabilidades.empate;

  return {
    paridad_tecnica: elo.paridad_tecnica,
    diferencia_elo_absoluta: Math.abs(elo.diferencia),
    umbral_paridad_elo: ELO_PARITY_THRESHOLD,
    probabilidad_empate_poisson: drawProbability,
    umbral_probabilidad_empate: POISSON_DRAW_THRESHOLD,
    empate_obligatorio: elo.paridad_tecnica && drawProbability > POISSON_DRAW_THRESHOLD
  };
}

function computeFormScore(formLastFive: string): number {
  let weighted = 0;
  let maxWeighted = 0;
  formLastFive.split('').forEach((letter, index) => {
    const weight = FORM_WEIGHTS[index] ?? 1;
    weighted += (FORM_POINTS[letter] ?? 0) * weight;
    maxWeighted += FORM_POINTS.W * weight;
  });
  return maxWeighted === 0 ? 0 : roundTo((weighted / maxWeighted) * 100, 1);
}

function hasXgData(team: TeamStats): boolean {
  return team.avg_xg_for != null && team.avg_xg_against != null;
}

function buildTeamPanel(team: TeamStats): FormXgTeamPanel {
  const xgAvailable = hasXgData(team);

  return {
    puntuacion_forma: computeFormScore(team.form_last_five),
    tendencia: team.form_trend,
    delta_finalizacion: xgAvailable
      ? roundTo(team.avg_goals_scored - (team.avg_xg_for as number), 2)
      : null,
    delta_defensivo: xgAvailable
      ? roundTo(team.avg_goals_conceded - (team.avg_xg_against as number), 2)
      : null,
    balance_xg: xgAvailable
      ? roundTo((team.avg_xg_for as number) - (team.avg_xg_against as number), 2)
      : null
  };
}

export function buildFormXgModel(home: TeamStats, away: TeamStats): FormXgModel {
  const local = buildTeamPanel(home);
  const visitante = buildTeamPanel(away);
  const xgDisponible = hasXgData(home) && hasXgData(away);
  const composite = (panel: FormXgTeamPanel): number =>
    panel.puntuacion_forma / 100 + (panel.balance_xg ?? 0);
  const gap = composite(local) - composite(visitante);
  const favorece =
    Math.abs(gap) < FORM_BALANCE_THRESHOLD
      ? 'Equilibrado'
      : gap > 0
        ? home.team_name
        : away.team_name;

  return { xg_disponible: xgDisponible, local, visitante, favorece };
}

export function buildDeterministicReport(home: TeamStats, away: TeamStats): DeterministicReport {
  const simulacionPoisson = buildPoissonModel(home, away);
  const diferencialElo = buildEloModel(
    home,
    away,
    simulacionPoisson.probabilidades.empate / 100
  );

  return {
    simulacion_poisson: simulacionPoisson,
    diferencial_elo: diferencialElo,
    momento_forma_xg: buildFormXgModel(home, away),
    regla_empate: buildDrawRule(simulacionPoisson, diferencialElo)
  };
}
