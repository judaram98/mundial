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

export interface EngineParams {
  rho: number;
  poissonWeight: number;
  homeEloBonus?: number;
}

export interface ThreeWayProbabilities {
  victoria_local: number;
  empate: number;
  victoria_visitante: number;
}

export interface PoissonModel {
  lambda_local: number;
  lambda_visitante: number;
  rho_dixon_coles: number;
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
  bonus_localia: number;
  elo_local_efectivo: number;
  diferencia: number;
  expectativa_local: number;
  delta_ciclo_local: number;
  delta_ciclo_visitante: number;
  probabilidades: ThreeWayProbabilities;
}

export interface MarketConsensus {
  peso_poisson: number;
  probabilidades: ThreeWayProbabilities;
  ganador_argmax: string;
  marcador_argmax: string;
}

export interface FinalConsensus {
  probabilidades: ThreeWayProbabilities;
  ganador: string;
  marcador: string;
  nivel_certeza: 'ALTA' | 'MEDIA' | 'BAJA';
  metodologias_alineadas: number;
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
  mercado_1x2: MarketConsensus;
  consenso_final: FinalConsensus;
}

export const HOST_TEAMS = new Set(['México', 'Estados Unidos', 'Canadá']);
export const REFERENCE_ELO = 1600;
export const MIN_OUTCOME_SHARE = 0.05;

export const DEFAULT_ENGINE_PARAMS: EngineParams = {
  rho: -0.1,
  poissonWeight: 0.2,
  homeEloBonus: 40
};

const MAX_GOALS = 10;
const MIN_LAMBDA = 0.05;
const MAX_DRAW_ANCHOR = 0.6;
const MIN_QUALITY_FACTOR = 0.5;
const MAX_QUALITY_FACTOR = 1.5;
const FORM_BALANCE_THRESHOLD = 0.15;
const FORM_WEIGHTS = [1, 1.25, 1.5, 1.75, 2];
const FORM_POINTS: Record<string, number> = { W: 3, D: 1, L: 0 };

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function poissonPmf(lambda: number, k: number): number {
  let probability = Math.exp(-lambda);
  for (let i = 1; i <= k; i += 1) {
    probability *= lambda / i;
  }
  return probability;
}

function dixonColesTau(
  homeGoals: number,
  awayGoals: number,
  lambdaHome: number,
  lambdaAway: number,
  rho: number
): number {
  if (homeGoals === 0 && awayGoals === 0) {
    return Math.max(0, 1 - lambdaHome * lambdaAway * rho);
  }
  if (homeGoals === 0 && awayGoals === 1) {
    return Math.max(0, 1 + lambdaHome * rho);
  }
  if (homeGoals === 1 && awayGoals === 0) {
    return Math.max(0, 1 + lambdaAway * rho);
  }
  if (homeGoals === 1 && awayGoals === 1) {
    return Math.max(0, 1 - rho);
  }
  return 1;
}

function distributeWithFloor(
  home: number,
  draw: number,
  away: number,
  scaleTotal: number
): number[] {
  const total = home + draw + away;
  const shares = total > 0 ? [home / total, draw / total, away / total] : [1 / 3, 1 / 3, 1 / 3];
  const scale = 1 - 3 * MIN_OUTCOME_SHARE;
  const smoothed = shares.map((share) => MIN_OUTCOME_SHARE + scale * share);
  const exact = smoothed.map((value) => value * scaleTotal);
  const floored = exact.map(Math.floor);
  let remainder = scaleTotal - floored.reduce((sum, value) => sum + value, 0);
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

  return floored;
}

function toPercentages(home: number, draw: number, away: number): ThreeWayProbabilities {
  const [local, empate, visitante] = distributeWithFloor(home, draw, away, 1000);
  return {
    victoria_local: local / 10,
    empate: empate / 10,
    victoria_visitante: visitante / 10
  };
}

function toIntegerPercentages(home: number, draw: number, away: number): ThreeWayProbabilities {
  const [local, empate, visitante] = distributeWithFloor(home, draw, away, 100);
  return {
    victoria_local: local,
    empate: empate,
    victoria_visitante: visitante
  };
}

export function hostEloBonus(team: TeamStats, params: EngineParams = DEFAULT_ENGINE_PARAMS): number {
  return HOST_TEAMS.has(team.team_name) ? (params.homeEloBonus ?? 0) : 0;
}

function rivalAdjustedLambda(
  attackAverage: number,
  concessionAverage: number,
  attackerElo: number,
  defenderElo: number
): number {
  const rivalStrengthFactor = clamp(
    REFERENCE_ELO / defenderElo,
    MIN_QUALITY_FACTOR,
    MAX_QUALITY_FACTOR
  );
  const attackerQualityFactor = clamp(
    attackerElo / REFERENCE_ELO,
    MIN_QUALITY_FACTOR,
    MAX_QUALITY_FACTOR
  );

  return Math.max(
    MIN_LAMBDA,
    (attackAverage * rivalStrengthFactor + concessionAverage * attackerQualityFactor) / 2
  );
}

export function buildPoissonModel(
  home: TeamStats,
  away: TeamStats,
  homeEffectiveElo: number = home.elo,
  awayEffectiveElo: number = away.elo,
  rho: number = DEFAULT_ENGINE_PARAMS.rho
): PoissonModel {
  const lambdaHome = rivalAdjustedLambda(
    home.avg_goals_scored,
    away.avg_goals_conceded,
    homeEffectiveElo,
    awayEffectiveElo
  );
  const lambdaAway = rivalAdjustedLambda(
    away.avg_goals_scored,
    home.avg_goals_conceded,
    awayEffectiveElo,
    homeEffectiveElo
  );

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
      const tau = dixonColesTau(homeGoals, awayGoals, lambdaHome, lambdaAway, rho);
      const cell = pHomeGoals * poissonPmf(lambdaAway, awayGoals) * tau;
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
    rho_dixon_coles: rho,
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

export function buildEloModel(
  home: TeamStats,
  away: TeamStats,
  drawAnchor: number,
  hostBonus: number
): EloModel {
  const effectiveHomeElo = home.elo + hostBonus;
  const difference = effectiveHomeElo - away.elo;
  const expectation = 1 / (1 + 10 ** (-difference / 400));
  const draw = clamp(drawAnchor, 0, MAX_DRAW_ANCHOR);
  const homeWin = Math.max(0, expectation - draw / 2);
  const awayWin = Math.max(0, 1 - expectation - draw / 2);

  return {
    elo_local: home.elo,
    elo_visitante: away.elo,
    bonus_localia: hostBonus,
    elo_local_efectivo: effectiveHomeElo,
    diferencia: difference,
    expectativa_local: roundTo(expectation, 4),
    delta_ciclo_local: home.elo - home.elo_cycle_start,
    delta_ciclo_visitante: away.elo - away.elo_cycle_start,
    probabilidades: toPercentages(homeWin, draw, awayWin)
  };
}

function blendOutcomes(
  poisson: PoissonModel,
  elo: EloModel,
  poissonWeight: number
): { home: number; draw: number; away: number } {
  const eloWeight = 1 - poissonWeight;
  return {
    home:
      poisson.probabilidades.victoria_local * poissonWeight +
      elo.probabilidades.victoria_local * eloWeight,
    draw: poisson.probabilidades.empate * poissonWeight + elo.probabilidades.empate * eloWeight,
    away:
      poisson.probabilidades.victoria_visitante * poissonWeight +
      elo.probabilidades.victoria_visitante * eloWeight
  };
}

function resolveArgmax(
  probabilities: ThreeWayProbabilities,
  homeName: string,
  awayName: string
): string {
  const { victoria_local, empate, victoria_visitante } = probabilities;

  if (empate > victoria_local && empate > victoria_visitante) {
    return 'Empate';
  }

  return victoria_local >= victoria_visitante ? homeName : awayName;
}

function scorelineFor(poisson: PoissonModel, winner: string, homeName: string): string {
  if (winner === 'Empate') {
    return poisson.mejores_marcadores.empate;
  }

  return winner === homeName
    ? poisson.mejores_marcadores.victoria_local
    : poisson.mejores_marcadores.victoria_visitante;
}

export function buildMarketConsensus(
  poisson: PoissonModel,
  elo: EloModel,
  home: TeamStats,
  away: TeamStats,
  poissonWeight: number
): MarketConsensus {
  const blend = blendOutcomes(poisson, elo, poissonWeight);
  const probabilidades = toPercentages(blend.home, blend.draw, blend.away);
  const ganadorArgmax = resolveArgmax(probabilidades, home.team_name, away.team_name);

  return {
    peso_poisson: poissonWeight,
    probabilidades,
    ganador_argmax: ganadorArgmax,
    marcador_argmax: scorelineFor(poisson, ganadorArgmax, home.team_name)
  };
}

function buildFinalConsensus(
  poisson: PoissonModel,
  elo: EloModel,
  forma: FormXgModel,
  home: TeamStats,
  away: TeamStats,
  poissonWeight: number
): FinalConsensus {
  const blend = blendOutcomes(poisson, elo, poissonWeight);
  const probabilidades = toIntegerPercentages(blend.home, blend.draw, blend.away);
  const ganador = resolveArgmax(probabilidades, home.team_name, away.team_name);

  const methodVerdicts = [
    resolveArgmax(poisson.probabilidades, home.team_name, away.team_name),
    resolveArgmax(elo.probabilidades, home.team_name, away.team_name),
    forma.favorece === 'Equilibrado' ? 'Empate' : forma.favorece
  ];
  const aligned = methodVerdicts.filter((verdict) => verdict === ganador).length;

  return {
    probabilidades,
    ganador,
    marcador: scorelineFor(poisson, ganador, home.team_name),
    nivel_certeza: aligned === 3 ? 'ALTA' : aligned === 2 ? 'MEDIA' : 'BAJA',
    metodologias_alineadas: aligned
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

export function buildDeterministicReport(
  home: TeamStats,
  away: TeamStats,
  overrides: Partial<EngineParams> = {}
): DeterministicReport {
  const params: EngineParams = { ...DEFAULT_ENGINE_PARAMS, ...overrides };
  const hostBonus =
    overrides.homeEloBonus !== undefined ? (overrides.homeEloBonus ?? 0) : hostEloBonus(home, params);
  const effectiveHomeElo = home.elo + hostBonus;
  const simulacionPoisson = buildPoissonModel(
    home,
    away,
    effectiveHomeElo,
    away.elo,
    params.rho
  );
  const diferencialElo = buildEloModel(
    home,
    away,
    simulacionPoisson.probabilidades.empate / 100,
    hostBonus
  );
  const momentoFormaXg = buildFormXgModel(home, away);

  return {
    simulacion_poisson: simulacionPoisson,
    diferencial_elo: diferencialElo,
    momento_forma_xg: momentoFormaXg,
    mercado_1x2: buildMarketConsensus(
      simulacionPoisson,
      diferencialElo,
      home,
      away,
      params.poissonWeight
    ),
    consenso_final: buildFinalConsensus(
      simulacionPoisson,
      diferencialElo,
      momentoFormaXg,
      home,
      away,
      params.poissonWeight
    )
  };
}
