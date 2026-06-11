import { isPlaceholderTeam } from './placeholders';

const PLACEHOLDER_FLAG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 88 88'%3E%3Ccircle cx='44' cy='44' r='43' fill='rgba(148,163,184,0.10)' stroke='rgba(148,163,184,0.35)' stroke-width='2'/%3E%3Ccircle cx='44' cy='33' r='13' fill='rgba(148,163,184,0.45)'/%3E%3Cpath d='M20 74c3-15 13-22 24-22s21 7 24 22z' fill='rgba(148,163,184,0.45)'/%3E%3C/svg%3E";

const FLAG_CODES: Record<string, string> = {
  Mexico: 'mx',
  'South Africa': 'za',
  'South Korea': 'kr',
  Poland: 'pl',
  Canada: 'ca',
  Morocco: 'ma',
  Ecuador: 'ec',
  Austria: 'at',
  'United States': 'us',
  Japan: 'jp',
  Norway: 'no',
  Ghana: 'gh',
  Argentina: 'ar',
  Senegal: 'sn',
  Switzerland: 'ch',
  Jordan: 'jo',
  France: 'fr',
  Tunisia: 'tn',
  Uruguay: 'uy',
  'New Zealand': 'nz',
  Brazil: 'br',
  Croatia: 'hr',
  Iran: 'ir',
  Panama: 'pa',
  England: 'gb-eng',
  Algeria: 'dz',
  Australia: 'au',
  'Curaçao': 'cw',
  Spain: 'es',
  Egypt: 'eg',
  Scotland: 'gb-sct',
  'Saudi Arabia': 'sa',
  Portugal: 'pt',
  Colombia: 'co',
  Uzbekistan: 'uz',
  Haiti: 'ht',
  Germany: 'de',
  'Ivory Coast': 'ci',
  Paraguay: 'py',
  Qatar: 'qa',
  Netherlands: 'nl',
  Denmark: 'dk',
  'Cape Verde': 'cv',
  Iraq: 'iq',
  Belgium: 'be',
  Italy: 'it',
  Turkey: 'tr',
  Bolivia: 'bo',
  'Bosnia and Herzegovina': 'ba',
  'DR Congo': 'cd',
  Czechia: 'cz',
  Sweden: 'se'
};

export type FlagWidth = 20 | 40 | 80 | 160 | 320;

export function getFlagCode(englishTeamName: string): string | null {
  return FLAG_CODES[englishTeamName.trim()] ?? null;
}

export function getFlagUrl(teamName: string, width: FlagWidth = 80): string | null {
  if (isPlaceholderTeam(teamName)) {
    return PLACEHOLDER_FLAG;
  }

  const code = getFlagCode(teamName);

  if (!code) {
    return null;
  }

  return `https://flagcdn.com/w${width}/${code}.png`;
}
