const PLACEHOLDER_PATTERN = /\dº|Ganador|Perdedor|Grupo/;

export function isPlaceholderTeam(teamName: string): boolean {
  return PLACEHOLDER_PATTERN.test(teamName);
}

export function isPlaceholderMatch(homeTeam: string, awayTeam: string): boolean {
  return isPlaceholderTeam(homeTeam) || isPlaceholderTeam(awayTeam);
}
