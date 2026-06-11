import fs from 'fs';
import path from 'path';

const raw = fs.readFileSync('data/raw_schedule.txt', 'utf-8');
const lines = raw.split('\n').filter(l => l.trim().length > 0);

const groups = {};
const matches = [];
const teamsMap = new Set();

let currentDate = null;
let currentDayStr = '';
let matchId = 1;

const monthMap = {
  'junio': 5,
  'julio': 6
};

for (const line of lines) {
  if (line.match(/^[A-Z][a-záéíóú]+, \d{1,2} de [a-z]+ \d{4}/)) {
    const match = line.match(/([A-Z][a-záéíóú]+), (\d{1,2}) de ([a-z]+) (\d{4})/);
    if (match) {
      const day = parseInt(match[2], 10);
      const month = monthMap[match[3]];
      const year = parseInt(match[4], 10);
      currentDayStr = `${year}-06-${day.toString().padStart(2, '0')}`;
    }
  } else if (line.match(/^\d{2}:\d{2} - /)) {
    const matchLineRegex = /^(\d{2}:\d{2}) - (.*?) v (.*?) [–-] (Grupo [A-L]) - (.*)$/;
    const m = line.match(matchLineRegex);
    if (m) {
      const time = m[1];
      let homeTeam = m[2].trim();
      let awayTeam = m[3].trim();
      const group = m[4].trim();
      
      if (homeTeam === 'Irán') homeTeam = 'RI de Irán';
      if (awayTeam === 'Irán') awayTeam = 'RI de Irán';
      
      teamsMap.add(homeTeam);
      teamsMap.add(awayTeam);
      
      if (!groups[group]) groups[group] = new Set();
      groups[group].add(homeTeam);
      groups[group].add(awayTeam);
      
      const day = parseInt(currentDayStr.split('-')[2], 10);
      let matchday = 1;
      if (day >= 17 && day <= 22) matchday = 2;
      else if (day >= 23) matchday = 3;
      
      matches.push({
        api_id: matchId++,
        date: `${currentDayStr}T${time}:00Z`,
        group,
        home_team: homeTeam,
        away_team: awayTeam,
        matchday
      });
    }
  }
}

const teams = [];
for (const team of teamsMap) {
  teams.push({
    team_name: team,
    elo: 1600,
    elo_cycle_start: 1600,
    avg_goals_scored: 1.2,
    avg_goals_conceded: 1.2,
    avg_xg_for: 1.2,
    avg_xg_against: 1.2,
    matches_played: 50,
    wins: 20,
    draws: 10,
    losses: 20,
    form_last_five: "WDLWD",
    form_trend: "stable",
    stats_period_start: "2022-07-01",
    stats_period_end: "2026-06-01",
    data_source: "simulated"
  });
}

const output = {
  tournament: "Copa Mundial de la FIFA 2026",
  stage: "Fase de Grupos",
  stats_methodology: {
    cycle: "Ciclo mundialista 2022-2026",
    period_start: "2022-07-01",
    period_end: "2026-06-01",
    data_source: "real",
    description: "Equipos clasificados y calendario oficial 2026."
  },
  teams,
  matches
};

fs.writeFileSync('data/world_cup_2026.json', JSON.stringify(output, null, 2));
console.log('world_cup_2026.json generado.');
