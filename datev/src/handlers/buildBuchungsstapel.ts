import { defineHandler, DocumentDto, WrittenFile } from '@timesheet/integration-sdk';
import { fiscalYearEnd, fiscalYearStart, nowIso, pageAll, recordRun, requireOrganization, resolveConfig, resolvePeriod, loadMappingIndex } from '../lib/common';
import { Booking, buildExtfFile, extfFilename } from '../lib/extf';
import { classifyDocument, isCreditNote } from '../lib/tax';
import { DatevConfig, ExportResult, PeriodInput } from '../lib/types';
import { PeriodGuard, WarningCollector, encodeForFile, isoDate, toScaled } from '../lib/writer';

export function customerKey(doc: DocumentDto): string {
  const id = (doc.customerId ?? '').trim();
  if (id) return id;
  return (doc.customer ?? '').trim();
}

export const buildBuchungsstapel = defineHandler<PeriodInput | undefined, ExportResult, DatevConfig>(
  async (input, context) => {
    const organizationId = requireOrganization(context);
    const config = resolveConfig(context.config);
    const period = resolvePeriod(input);
    const guard = new PeriodGuard(period.from, period.to);
    const warnings = new WarningCollector();

    context.logger.info('Building DATEV Buchungsstapel', { organizationId, period });

    const documents = await pageAll<DocumentDto>((page, limit, count) =>
      context.data.listDocuments({
        organizationId,
        category: 0,
        template: false,
        startDate: period.from,
        endDate: period.to,
        page,
        limit,
        count
      })
    );
    const debtors = await loadMappingIndex(context, 'customer');

    const byFiscalYear = new Map<string, Booking[]>();
    let count = 0;
    for (const doc of documents) {
      if (doc.category !== 0 || doc.organizationId !== organizationId) continue;
      const belegdatum = isoDate(doc.date);
      guard.assert(belegdatum, `Rechnung ${doc.invoiceId ?? doc.id}`);

      const currency = (doc.eInvoiceCurrency ?? 'EUR').trim().toUpperCase() || 'EUR';
      if (currency !== 'EUR') {
        warnings.add('foreign_currency', 'Rechnung in Fremdwaehrung ohne Kurs, ausgelassen', { invoiceId: doc.invoiceId, currency });
        continue;
      }
      const classified = classifyDocument(doc, config);
      if (!classified.ok) {
        warnings.add(classified.code, classified.message, { invoiceId: doc.invoiceId, documentId: doc.id });
        continue;
      }
      const total = toScaled(doc.total ?? '0', 2);
      if (total === '0.00') {
        warnings.add('zero_total', 'Rechnung ohne Betrag, ausgelassen', { invoiceId: doc.invoiceId });
        continue;
      }
      const key = customerKey(doc);
      let konto = key ? debtors.get(key) : undefined;
      if (!konto) {
        konto = config.debitorStandard;
        warnings.add('customer_unmapped', 'Kunde ohne Debitorenkonto, Sammeldebitor verwendet', {
          customer: doc.customer ?? '',
          customerId: doc.customerId ?? '',
          invoiceId: doc.invoiceId ?? ''
        });
      }
      const creditNote = isCreditNote(doc);
      const booking: Booking = {
        amount: total,
        sollHaben: creditNote ? 'H' : 'S',
        currency,
        konto,
        gegenkonto: classified.tax.revenueAccount,
        buSchluessel: classified.tax.buSchluessel,
        belegdatum,
        belegfeld1: doc.invoiceId ?? doc.id,
        buchungstext: [doc.customer, doc.invoiceId].filter(Boolean).join(' '),
        kost1: doc.costCenter?.trim() || undefined,
        euLandUstId: classified.tax.category === 'reverseCharge' ? doc.customerVatId?.trim() || undefined : undefined,
        faelligkeit: doc.dueDate ? isoDate(doc.dueDate) : undefined,
        leistungsdatum: doc.deliveryDate ? isoDate(doc.deliveryDate) : undefined
      };
      const fy = fiscalYearStart(belegdatum, config.wirtschaftsjahrBeginn);
      const list = byFiscalYear.get(fy) ?? [];
      list.push(booking);
      byFiscalYear.set(fy, list);
      count++;
    }

    const files: WrittenFile[] = [];
    const createdAt = new Date();
    for (const fy of [...byFiscalYear.keys()].sort()) {
      const bookings = byFiscalYear.get(fy) ?? [];
      bookings.sort((a, b) => (a.belegdatum < b.belegdatum ? -1 : a.belegdatum > b.belegdatum ? 1 : a.belegfeld1.localeCompare(b.belegfeld1)));
      const from = period.from > fy ? period.from : fy;
      const fyEnd = fiscalYearEnd(fy);
      const to = period.to < fyEnd ? period.to : fyEnd;
      const text = buildExtfFile(bookings, { config, from, to, wjBeginn: fy, createdAt, exportedBy: 'Timesheet' });
      const encoded = encodeForFile(text, config.charset);
      const file = await context.files.write({
        filename: extfFilename(from, to),
        contentType: 'text/csv',
        content: encoded.content
      });
      files.push({ ...file, bytes: file.bytes || encoded.bytes });
    }
    if (files.length > 1) {
      warnings.add('fiscal_year_split', 'Zeitraum umfasst zwei Wirtschaftsjahre, je Wirtschaftsjahr eine Datei erzeugt', { files: files.map(f => f.filename) });
    }

    const result: ExportResult = { surface: 'buchungsstapel', period, files, count, warnings: warnings.list() };
    await recordRun(context, {
      at: nowIso(createdAt),
      surface: 'buchungsstapel',
      period,
      files: files.map(f => ({ filename: f.filename, bytes: f.bytes })),
      count,
      warnings: warnings.count
    });
    context.logger.info('DATEV Buchungsstapel built', { count, files: files.length, warnings: warnings.count });
    return result;
  }
);
