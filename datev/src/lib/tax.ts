import type { DocumentDto } from '@timesheet/integration-sdk';
import type { ResolvedConfig } from './types';
import { isNegativeDecimal, toScaled } from './writer';

/**
 * Tax classification of an invoice, mirroring the category derivation in
 * backend/reports/.../zugferd/ZugferdInvoiceBuilder.java (UNTDID 5305):
 * S standard rated, E exempt with reason, Z zero rated, AE reverse charge.
 * Standard rated is split further by rate into the two configured revenue accounts.
 */
export type TaxCategory = 'standard' | 'reduced' | 'exempt' | 'zeroRated' | 'reverseCharge';

export interface TaxClassification {
  category: TaxCategory;
  /** Rate in percent as a scaled decimal string, e.g. "19.00". */
  ratePercent: string;
  reason?: string;
  /** Revenue account (Gegenkonto). */
  revenueAccount: string;
  /** BU-Schluessel; empty because the configured revenue accounts are automatic accounts. */
  buSchluessel: string;
}

export type Classified =
  | { ok: true; tax: TaxClassification }
  | { ok: false; code: string; message: string };

function flag(doc: DocumentDto, name: string): boolean {
  const raw = (doc as unknown as Record<string, unknown>)[name];
  return raw === true;
}

function trimToNull(value: string | undefined): string | undefined {
  const v = (value ?? '').trim();
  return v === '' ? undefined : v;
}

export function hasSecondTax(doc: DocumentDto): boolean {
  const shown = doc.showSecondTax === true || flag(doc, 'showSecondTax');
  const value = toScaled(doc.taxSecondValue ?? '0', 2);
  return shown && value !== '0.00';
}

export function isCreditNote(doc: DocumentDto): boolean {
  if ((doc.invoiceTypeCode ?? '').trim() === '381') return true;
  if ((doc.eInvoiceDocumentType ?? '').trim().toUpperCase() === 'CREDIT_NOTE') return true;
  return isNegativeDecimal(doc.total ?? '0');
}

export function classifyDocument(doc: DocumentDto, config: ResolvedConfig): Classified {
  if (hasSecondTax(doc)) {
    return {
      ok: false,
      code: 'second_tax',
      message: 'Rechnung mit zweitem Steuersatz kann nicht in einer Buchungszeile abgebildet werden'
    };
  }
  const reason = trimToNull(doc.taxExemptionReason);
  if (doc.isReverseCharge === true) {
    return {
      ok: true,
      tax: {
        category: 'reverseCharge',
        ratePercent: '0.00',
        reason: reason ?? 'Reverse charge',
        revenueAccount: config.erloeskontoReverseCharge,
        buSchluessel: ''
      }
    };
  }
  // hideTaxes is a presentation flag the SDK view leaves out; the API still sends it.
  const hideTaxes = flag(doc, 'hideTaxes');
  const rate = hideTaxes ? '0.00' : toScaled(doc.tax ?? '0', 2);
  if (rate !== '0.00' && !rate.startsWith('-')) {
    if (rate === toScaled(config.steuersatzStandard, 2)) {
      return {
        ok: true,
        tax: { category: 'standard', ratePercent: rate, revenueAccount: config.erloeskontoStandard, buSchluessel: '' }
      };
    }
    if (rate === toScaled(config.steuersatzErmaessigt, 2)) {
      return {
        ok: true,
        tax: { category: 'reduced', ratePercent: rate, revenueAccount: config.erloeskontoErmaessigt, buSchluessel: '' }
      };
    }
    return {
      ok: false,
      code: 'unsupported_tax_rate',
      message: `Steuersatz ${rate.replace('.', ',')} % entspricht weder dem Regelsteuersatz noch dem ermaessigten Steuersatz`
    };
  }
  if (reason) {
    return {
      ok: true,
      tax: { category: 'exempt', ratePercent: '0.00', reason, revenueAccount: config.erloeskontoSteuerfrei, buSchluessel: '' }
    };
  }
  return {
    ok: true,
    tax: { category: 'zeroRated', ratePercent: '0.00', revenueAccount: config.erloeskontoSteuerfrei, buSchluessel: '' }
  };
}
