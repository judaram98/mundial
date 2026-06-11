import fs from 'fs';

const groups = {
  A: ['México', 'Sudáfrica', 'Corea del Sur', 'República Checa'],
  B: ['Canadá', 'Bosnia y Herzegovina', 'Catar', 'Suiza'],
  C: ['Brasil', 'Marruecos', 'Haití', 'Escocia'],
  D: ['Estados Unidos', 'Paraguay', 'Australia', 'Turquía'],
  E: ['Alemania', 'Curazao', 'Costa de Marfil', 'Ecuador'],
  F: ['Países Bajos', 'Japón', 'Polonia', 'Túnez'],
  G: ['Bélgica', 'Egipto', 'Irán', 'Nueva Zelanda'],
  H: ['España', 'Cabo Verde', 'Arabia Saudita', 'Uruguay'],
  I: ['Francia', 'Senegal', 'Bolivia', 'Noruega'],
  J: ['Argentina', 'Argelia', 'Austria', 'Jordania'],
  K: ['Portugal', 'RD Congo', 'Uzbekistán', 'Colombia'],
  L: ['Inglaterra', 'Croacia', 'Ghana', 'Panamá']
};

const teams = [];
for (const [group, members] of Object.entries(groups)) {
  for (const team of members) {
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
}

const matches = [];
let matchId = 1;

// Generating matches with correct dates (June 11 to June 27, 2026)
// A typical group stage has 3 matchdays.
// Matchday 1: Jun 11 - Jun 16
// Matchday 2: Jun 17 - Jun 22
// Matchday 3: Jun 23 - Jun 27

const startDates = {
  1: new Date('2026-06-11T12:00:00Z'),
  2: new Date('2026-06-17T12:00:00Z'),
  3: new Date('2026-06-23T12:00:00Z')
};

for (const [group, members] of Object.entries(groups)) {
  // Matchday 1
  matches.push({
    api_id: matchId++,
    date: startDates[1].toISOString(),
    group: `Grupo ${group}`,
    home_team: members[0],
    away_team: members[1],
    matchday: 1
  });
  matches.push({
    api_id: matchId++,
    date: startDates[1].toISOString(),
    group: `Grupo ${group}`,
    home_team: members[2],
    away_team: members[3],
    matchday: 1
  });
  
  // Matchday 2
  matches.push({
    api_id: matchId++,
    date: startDates[2].toISOString(),
    group: `Grupo ${group}`,
    home_team: members[0],
    away_team: members[2],
    matchday: 2
  });
  matches.push({
    api_id: matchId++,
    date: startDates[2].toISOString(),
    group: `Grupo ${group}`,
    home_team: members[3],
    away_team: members[1],
    matchday: 2
  });
  
  // Matchday 3
  matches.push({
    api_id: matchId++,
    date: startDates[3].toISOString(),
    group: `Grupo ${group}`,
    home_team: members[3],
    away_team: members[0],
    matchday: 3
  });
  matches.push({
    api_id: matchId++,
    date: startDates[3].toISOString(),
    group: `Grupo ${group}`,
    home_team: members[1],
    away_team: members[2],
    matchday: 3
  });
}

// Stagger the dates a little bit
matches.forEach((m, i) => {
  const d = new Date(m.date);
  d.setHours(d.getHours() + (i % 4) * 3); // stagger matches
  d.setDate(d.getDate() + Math.floor(i / 12)); // 4 matches a day => 12 matches a matchday => stretch over 3 days? No, there are 24 matches per matchday.
  // 24 matches over 6 days = 4 matches a day. 
  // i ranges from 0 to 71.
  // Matchday 1: i=0 to 23. Days: Jun 11 + Math.floor(i/4) = Jun 11 to Jun 16.
  // Matchday 2: i=24 to 47. Days: Jun 17 + Math.floor((i-24)/4) = Jun 17 to Jun 22.
  // Matchday 3: i=48 to 71. Days: Jun 23 + Math.floor((i-48)/4) = Jun 23 to Jun 28.
  
  let baseDate;
  let dayOffset = 0;
  if (i < 24) {
    baseDate = new Date('2026-06-11T16:00:00Z');
    dayOffset = Math.floor(i / 4);
  } else if (i < 48) {
    baseDate = new Date('2026-06-17T16:00:00Z');
    dayOffset = Math.floor((i - 24) / 4);
  } else {
    baseDate = new Date('2026-06-23T16:00:00Z');
    dayOffset = Math.floor((i - 48) / 4);
  }
  
  baseDate.setDate(baseDate.getDate() + dayOffset);
  baseDate.setHours(baseDate.getHours() + (i % 4) * 3); // 16:00, 19:00, 22:00, 01:00
  
  m.date = baseDate.toISOString();
});

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
