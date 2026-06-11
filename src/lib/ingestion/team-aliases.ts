const TEAM_NAME_ALIASES: Record<string, string[]> = {
  Czechia: ['Czech Republic'],
  'South Korea': ['Korea Republic'],
  Iran: ['IR Iran'],
  'United States': ['USA'],
  'Ivory Coast': ["Côte d'Ivoire"],
  Turkey: ['Türkiye'],
  'Cape Verde': ['Cabo Verde'],
  Curaçao: ['Curacao'],
  'DR Congo': ['Congo DR']
};

export function lookupCandidates(canonicalName: string): string[] {
  const trimmed = canonicalName.trim();
  return [trimmed, ...(TEAM_NAME_ALIASES[trimmed] ?? [])];
}
