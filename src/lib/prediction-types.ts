import type { DeterministicReport } from './prediction-engine';

export interface Prediction {
  probabilidades: {
    victoria_local: number;
    empate: number;
    victoria_visitante: number;
  };
  marcador_exacto: string;
  ganador_esperado: string;
  nivel_certeza: 'ALTA' | 'MEDIA' | 'BAJA';
  analisis: string;
  desglose_consenso: {
    simulacion_poisson: string;
    diferencial_elo: string;
    momento_forma_xg: string;
  };
}

export interface PredictionCache {
  prediction: Prediction;
  motor_determinista: DeterministicReport;
  generado_en: string;
}

export function parseScoreline(scoreline: string): { home: number; away: number } | null {
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(scoreline);

  if (!match) {
    return null;
  }

  return { home: Number(match[1]), away: Number(match[2]) };
}
