import type { DocumentDto } from '@timesheet/integration-sdk';
import type { ResolvedConfig } from './types';
import { customerKey, isCreditNote, profileFromConfig } from './common';
import { absDecimal, addDecimals, ExportWarning, PeriodGuard, RecordWriter, toScaled, WarningCollector } from './writer';

/**
 * BMD NTCS FIBU Buchungsimport, standard column set. Column order lives here and only
 * here; adjust it when the customer's NTCS import definition differs.
 */
export const FIBU_COLUMNS = [
  'satzart',
  'konto',
  'gkonto',
  'belegnr',
  'belegdatum',
  'buchdatum',
  'buchsymbol',
  'buchcode',
  'prozent',
  'steuercode',
  'betrag',
  'steuer',
  'text',
  'extbelegnr',
  'faelligkeit',
  'kost',
  'filiale'
] as const;

export interface FibuBuildInput {
  documents: DocumentDto[];
  config: ResolvedConfig;
  /** customer key (number or name) to Debitorenkonto. */
  debtors: Map<string, string>;
  period: PeriodGuard;
}

export interface FibuBuildResult {
  text: string;
  /** Exported invoices. */
  count: number;
  /** Booking lines written, header excluded. */
  lines: number;
  warnings: ExportWarning[];
}

interface RateLine {
  /** Tax rate in percent, scaled to two decimals. */
  rate: string;
  /** Gross amount, positive. */
  gross: string;
  /** Tax amount, positive. */
  tax: string;
  reverseCharge: boolean;
}

interface AccountChoice {
  account: string;
  steuercode: string;
}

function chooseAccount(rate: string, reverseCharge: boolean, cfg: ResolvedConfig): AccountChoice | null {
  if (reverseCharge) {
    return { account: cfg.erloeskontoReverseCharge, steuercode: cfg.steuercodeReverseCharge };
  }
  switch (rate) {
    case '20.00':
      return { account: cfg.erloeskonto20, steuercode: cfg.steuercode20 };
    case '10.00':
      return { account: cfg.erloeskonto10, steuercode: cfg.steuercode10 };
    case '13.00':
      return { account: cfg.erloeskonto13, steuercode: cfg.steuercode13 };
    case '0.00':
      return { account: cfg.erloeskontoSteuerfrei, steuercode: cfg.steuercodeSteuerfrei };
    default:
      return null;
  }
}

function hasSecondTax(doc: DocumentDto): boolean {
  if (doc.showSecondTax === false) return false;
  const value = toScaled(doc.taxSecondValue ?? '0', 2);
  return value !== '0.00';
}

/** Splits a document into one line per tax rate, or returns null with a warning. */
function rateLines(doc: DocumentDto, warnings: WarningCollector): RateLine[] | null {
  const label = doc.invoiceId || doc.id;
  const total = absDecimal(toScaled(doc.total ?? '0', 2));
  if (doc.isReverseCharge) {
    return [{ rate: '0.00', gross: total, tax: '0.00', reverseCharge: true }];
  }
  const rate = toScaled(doc.tax ?? '0', 2);
  const taxValue = absDecimal(toScaled(doc.taxValue ?? '0', 2));
  if (!hasSecondTax(doc)) {
    return [{ rate, gross: total, tax: taxValue, reverseCharge: false }];
  }
  const rate2 = toScaled(doc.taxSecond ?? '0', 2);
  const taxValue2 = absDecimal(toScaled(doc.taxSecondValue ?? '0', 2));
  if (rate === '0.00' || rate2 === '0.00') {
    warnings.add('second-tax-unsplittable', `Beleg ${label}: zweiter Steuersatz kann nicht aufgeteilt werden, Beleg übersprungen.`, {
      invoiceId: doc.invoiceId,
      documentId: doc.id
    });
    return null;
  }
  // Net of the second rate follows from its tax amount; the first rate takes the rest so
  // that both gross amounts add up to the document total exactly.
  const net2 = toScaled((Number(taxValue2) * 100) / Number(rate2), 2);
  const netTotal = addDecimals(addDecimals(total, `-${taxValue}`, 2), `-${taxValue2}`, 2);
  const net1 = addDecimals(netTotal, `-${net2}`, 2);
  if (net1.startsWith('-') || net2.startsWith('-')) {
    warnings.add('second-tax-unsplittable', `Beleg ${label}: Steuerbeträge passen nicht zum Gesamtbetrag, Beleg übersprungen.`, {
      invoiceId: doc.invoiceId,
      documentId: doc.id
    });
    return null;
  }
  return [
    { rate, gross: addDecimals(net1, taxValue, 2), tax: taxValue, reverseCharge: false },
    { rate: rate2, gross: addDecimals(net2, taxValue2, 2), tax: taxValue2, reverseCharge: false }
  ];
}

export function buildFibuFile(input: FibuBuildInput): FibuBuildResult {
  const { config: cfg, period } = input;
  const writer = new RecordWriter(profileFromConfig(cfg));
  const warnings = new WarningCollector();
  const rows: string[][] = [];
  if (cfg.headerRow) {
    rows.push([...FIBU_COLUMNS]);
  }
  let count = 0;
  let lines = 0;

  for (const doc of input.documents) {
    if (doc.category !== 0) continue;
    const label = doc.invoiceId || doc.id;
    period.assert(doc.date, `Beleg ${label}`);

    const key = customerKey(doc);
    let debtor = key ? input.debtors.get(key) : undefined;
    if (!debtor) {
      debtor = cfg.debitorStandard;
      warnings.add('debtor-unmapped', `Kunde "${key || '(ohne Namen)'}" hat kein Debitorenkonto, Standardkonto ${debtor} verwendet.`, {
        customer: key,
        invoiceId: doc.invoiceId,
        documentId: doc.id
      });
    }

    const split = rateLines(doc, warnings);
    if (!split) continue;

    const accounts: AccountChoice[] = [];
    let skip = false;
    for (const line of split) {
      const choice = chooseAccount(line.rate, line.reverseCharge, cfg);
      if (!choice) {
        warnings.add('tax-rate-unconfigured', `Beleg ${label}: für den Steuersatz ${line.rate.replace('.', ',')} % ist kein Erlöskonto konfiguriert, Beleg übersprungen.`, {
          rate: line.rate,
          invoiceId: doc.invoiceId,
          documentId: doc.id
        });
        skip = true;
        break;
      }
      accounts.push(choice);
    }
    if (skip) continue;

    const credit = isCreditNote(doc);
    const buchcode = credit && cfg.gutschriftModus === 'buchcode' ? '2' : '1';
    const sign = credit && cfg.gutschriftModus === 'negativ' ? '-' : '';
    const bookingText = [doc.customer ?? '', doc.invoiceId ?? ''].map(v => v.trim()).filter(Boolean).join(' ');

    split.forEach((line, index) => {
      const choice = accounts[index];
      rows.push([
        writer.raw('0'),
        writer.raw(debtor as string),
        writer.raw(choice.account),
        writer.text(doc.invoiceId ?? '', 20),
        writer.date(doc.date),
        writer.date(doc.date),
        writer.raw(cfg.buchungssymbol),
        writer.raw(buchcode),
        writer.number(line.rate, 2),
        writer.raw(choice.steuercode),
        writer.number(`${sign}${line.gross}`, 2),
        writer.number(`${sign}${line.tax}`, 2),
        writer.text(bookingText, 60),
        writer.text(doc.customerOrderNumber || doc.orderReference || '', 20),
        doc.dueDate ? writer.date(doc.dueDate) : writer.raw(''),
        writer.text(doc.costCenter || cfg.kostenstelle, 20),
        writer.text(cfg.filiale, 10)
      ]);
      lines++;
    });
    count++;
  }

  return { text: rows.length > 0 ? writer.build(rows) : '', count, lines, warnings: warnings.list() };
}
