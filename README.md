# Mundial 2026 · Predicciones IA

Aplicación web en Astro (SSR) que muestra el calendario de la fase de grupos del Mundial 2026 almacenado en Supabase y usa Claude (`claude-opus-4-8`) como motor de predicción basado en un modelo de consenso de tres metodologías: Simulación de Poisson, Diferencial Elo y Momento de Forma/xG.

> Nota: los grupos y estadísticas en `data/world_cup_2026.json` son datos base simulados. Edita ese archivo y vuelve a ejecutar el seed para ajustarlos al sorteo real.

## Requisitos

- Node.js 20.6+ (el seed usa `node --env-file`)
- Proyecto en Supabase
- API key de Anthropic
- (Opcional) API deportiva externa para sincronizar resultados reales

## Puesta en marcha

1. **Instalar dependencias**

   ```sh
   npm install
   ```

2. **Configurar variables de entorno**

   ```sh
   cp .env.example .env
   ```

   | Variable | Descripción |
   |---|---|
   | `SUPABASE_URL` | URL del proyecto Supabase |
   | `SUPABASE_SERVICE_ROLE_KEY` | Service role key (solo se usa en servidor) |
   | `ANTHROPIC_API_KEY` | API key de Anthropic |
   | `SPORTS_API_URL` | Base URL de la API deportiva externa (opcional) |
   | `SPORTS_API_KEY` | API key de la API deportiva externa (opcional) |

3. **Crear el esquema en Supabase**

   Ejecuta `supabase/schema.sql` en el SQL Editor de Supabase.

4. **Poblar la base de datos**

   ```sh
   npm run seed
   ```

   El seed es idempotente: hace upsert por `api_id` (matches) y `team_name` (team_stats).

5. **Levantar la aplicación**

   ```sh
   npm run dev
   ```

## Arquitectura

| Fase | Archivo | Responsabilidad |
|---|---|---|
| 1 | `supabase/schema.sql`, `scripts/seed.js`, `data/world_cup_2026.json` | Esquema y carga inicial (48 equipos, 72 partidos) |
| 2 | `src/lib/matches.ts` | Lógica híbrida: lee el calendario, detecta partidos vencidos con estado `pending` y los sincroniza contra la API externa antes de responder |
| 3 | `src/pages/api/predict.ts` | Endpoint `POST /api/predict` que cruza el partido con `team_stats` y consulta a Claude con salida estricta en JSON Schema |
| 4 | `src/pages/index.astro`, `src/layouts/Layout.astro` | UI con CSS nativo, tablas translúcidas y cliente JS puro |

## Contrato del endpoint de predicción

```
POST /api/predict
Content-Type: application/json

{ "matchId": 1 }
```

Respuesta:

```json
{
  "match": { "id": 1, "home_team": "México", "away_team": "Sudáfrica", "date": "..." },
  "prediction": {
    "probabilidades": { "victoria_local": 55, "empate": 25, "victoria_visitante": 20 },
    "marcador_exacto": "2-1",
    "ganador_esperado": "México",
    "nivel_certeza": "MEDIA",
    "analisis": "...",
    "desglose_consenso": {
      "simulacion_poisson": "...",
      "diferencial_elo": "...",
      "momento_forma_xg": "..."
    }
  }
}
```
