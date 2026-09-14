import type { EmployeeFacts } from './payroll';
import type { Period, ResolvedConfig } from './types';
import { FormatProfile, RecordWriter, formatDate } from './writer';

/**
 * DATEV Lohn und Gehalt ASCII import (Bewegungsdaten), semicolon separated with a
 * header row, Windows-1252, CRLF. The column order in LUG_COLUMNS matches the standard
 * import definition "Bewegungsdaten"; verify it against the import definition configured
 * in Lohn und Gehalt (Extras, Import) before the first import.
 */

export const LUG_COLUMNS = ['Mandant', 'Personalnummer', 'Abrechnungsmonat', 'Lohnart', 'Anzahl', 'Betrag', 'Kostenstelle', 'Bemerkung'];

const PROFILE: FormatProfile = {
  separator: ';',
  quote: '',
  decimalMark: ',',
  dateFormat: 'DD.MM.YYYY',
  charset: 'windows-1252',
  lineBreak: '\r\n'
};

export function buildLugBewegungsdaten(employees: EmployeeFacts[], config: ResolvedConfig, period: Period): string {
  const w = new RecordWriter(PROFILE);
  const [year, month] = period.from.split('-');
  const abrechnungsmonat = `${month}/${year}`;
  const rows: string[][] = [LUG_COLUMNS.map(c => w.text(c))];
  for (const e of employees) {
    for (const line of e.lines) {
      rows.push([
        w.raw(config.mandantLohn),
        w.text(e.personalnummer),
        abrechnungsmonat,
        w.raw(line.lohnart),
        line.kind === 'amount' ? '' : w.number(line.value, 2),
        line.kind === 'amount' ? w.number(line.value, 2) : '',
        '',
        w.text(line.label, 40)
      ]);
    }
  }
  return w.build(rows);
}

export function lugFilename(period: Period): string {
  return `LuG_Bewegungsdaten_${formatDate(period.from, 'YYYYMMDD')}.txt`;
}
