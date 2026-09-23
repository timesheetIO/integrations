import type { EmployeeFacts, WageLine } from './payroll';
import type { Period, ResolvedConfig } from './types';
import { FormatProfile, RecordWriter, formatDate, monthBounds } from './writer';

/**
 * DATEV LODAS import files (ASCII, Windows-1252, CRLF).
 *
 * Layout implemented: the LODAS import format with an [Allgemein] section, a
 * [Satzbeschreibung] declaring the record layouts, and a data section. Two files are
 * produced: Stammdaten (record 100, u_lod_psd_mitarbeiter) and Bewegungsdaten
 * (record 200, u_lod_bwd_buchung_standard).
 *
 * Assumptions to verify against the LODAS Schnittstellenbeschreibung of the Kanzlei:
 * - field names in LODAS_STAMMDATEN_FIELDS and LODAS_BEWEGUNGSDATEN_FIELDS
 * - the Bearbeitungsschluessel values in LODAS_BS_NR (1 = Stunden, 2 = Tage, 3 = Betrag)
 */

export const LODAS_STAMMDATEN_RECORD = '100';
export const LODAS_BEWEGUNGSDATEN_RECORD = '200';
export const LODAS_STAMMDATEN_FIELDS = ['pnr_betriebliche#psd', 'duevo_familienname#psd', 'duevo_vorname#psd'];
export const LODAS_BEWEGUNGSDATEN_FIELDS = [
  'pnr#bwd',
  'abrechnung_zeitraum#bwd',
  'la_eigene#bwd',
  'bs_wert_butab#bwd',
  'bs_nr#bwd',
  'kostenstelle#bwd'
];
export const LODAS_BS_NR: Record<WageLine['kind'], string> = { hours: '1', days: '2', amount: '3' };

const PROFILE: FormatProfile = {
  separator: ';',
  quote: '"',
  decimalMark: ',',
  dateFormat: 'DD.MM.YYYY',
  charset: 'windows-1252',
  lineBreak: '\r\n'
};

function allgemein(config: ResolvedConfig): string[] {
  return [
    '[Allgemein]',
    'Ziel=LODAS',
    'Version_SST=1.0',
    `BeraterNr=${config.beraternummer}`,
    `MandantenNr=${config.mandantLohn}`,
    'Kommentarzeichen=*',
    'Feldtrennzeichen=;',
    'Zahlenkomma=,',
    'Datumsformat=TT.MM.JJJJ',
    'StringBegrenzer="',
    ''
  ];
}

export function buildLodasStammdaten(employees: EmployeeFacts[], config: ResolvedConfig): string {
  const w = new RecordWriter(PROFILE);
  const lines = [
    ...allgemein(config),
    '[Satzbeschreibung]',
    `${LODAS_STAMMDATEN_RECORD};u_lod_psd_mitarbeiter;${LODAS_STAMMDATEN_FIELDS.join(';')};`,
    '',
    '[Stammdaten]'
  ];
  for (const e of employees) {
    lines.push(w.row([LODAS_STAMMDATEN_RECORD, w.text(e.personalnummer), w.text(e.lastname, 30), w.text(e.firstname, 30)]) + ';');
  }
  return lines.join(PROFILE.lineBreak) + PROFILE.lineBreak;
}

export function buildLodasBewegungsdaten(employees: EmployeeFacts[], config: ResolvedConfig, period: Period): string {
  const w = new RecordWriter(PROFILE);
  const abrechnungszeitraum = formatDate(monthBounds(period.from).from, 'DD.MM.YYYY');
  const lines = [
    ...allgemein(config),
    '[Satzbeschreibung]',
    `${LODAS_BEWEGUNGSDATEN_RECORD};u_lod_bwd_buchung_standard;${LODAS_BEWEGUNGSDATEN_FIELDS.join(';')};`,
    '',
    '[Bewegungsdaten]'
  ];
  for (const e of employees) {
    for (const line of e.lines) {
      lines.push(
        w.row([
          LODAS_BEWEGUNGSDATEN_RECORD,
          w.text(e.personalnummer),
          abrechnungszeitraum,
          w.raw(line.lohnart),
          w.number(line.value, 2),
          LODAS_BS_NR[line.kind],
          ''
        ]) + ';'
      );
    }
  }
  return lines.join(PROFILE.lineBreak) + PROFILE.lineBreak;
}

export function lodasFilenames(period: Period): { stammdaten: string; bewegungsdaten: string } {
  const tag = formatDate(period.from, 'YYYYMMDD');
  return { stammdaten: `LODAS_Stammdaten_${tag}.txt`, bewegungsdaten: `LODAS_Bewegungsdaten_${tag}.txt` };
}
