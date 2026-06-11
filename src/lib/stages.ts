export type MatchStage =
  | 'group'
  | 'round_32'
  | 'round_16'
  | 'quarter'
  | 'semi'
  | 'third'
  | 'final';

const STAGE_LABELS: Record<MatchStage, string> = {
  group: 'Fase de Grupos',
  round_32: 'Dieciseisavos de Final',
  round_16: 'Octavos de Final',
  quarter: 'Cuartos de Final',
  semi: 'Semifinal',
  third: 'Tercer Puesto',
  final: 'Final'
};

const STAGE_SHORT_LABELS: Record<MatchStage, string> = {
  group: 'Grupos',
  round_32: '16vos',
  round_16: '8vos',
  quarter: '4tos',
  semi: 'Semis',
  third: '3er Puesto',
  final: 'Final'
};

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage as MatchStage] ?? stage;
}

export function stageShortLabel(stage: string): string {
  return STAGE_SHORT_LABELS[stage as MatchStage] ?? stage;
}
