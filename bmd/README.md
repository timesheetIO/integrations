# BMD NTCS Export

> Export outgoing invoices and payroll data from Timesheet as import files for BMD NTCS.

Produces two files the tax advisor imports into BMD NTCS: the FIBU Buchungsimport for outgoing invoices and the Lohn import with worked time, overtime, absences and allowances per employee. Nothing is sent to BMD; the user downloads the files and hands them to the Kanzlei.

- Package: `@timesheet/plugin-bmd`
- Manifest id: `bmd`
- Category: accounting
- Install scope: organization only (`installScope = ORGANIZATION_ONLY`), Business plan (`minimumTier = BUSINESS`)

## Requirements

The integration only works on an organization installation. Every handler throws when `context.organizationId` is missing, because invoices, absences and overtime of other members only exist at organization level. The marketplace row must therefore be `ORGANIZATION_ONLY` and Business gated.

Data access: `documents`, `absences`, `overtime`, `tasks`, `expenses`, `colleagues`.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `firmennummer` | | Required. Written into every line of the Lohn import. |
| `mandantennummer` | | Informational. |
| `buchungssymbol` | `AR` | Booking symbol for outgoing invoices. |
| `erloeskonto20` / `erloeskonto10` / `erloeskonto13` | `4000` / `4001` / `4002` | Revenue accounts per Austrian VAT rate. |
| `erloeskontoSteuerfrei` | `4010` | Revenue account for tax exempt invoices (rate 0 %). |
| `erloeskontoReverseCharge` | `4020` | Revenue account for reverse charge invoices. |
| `steuercode20` / `steuercode10` / `steuercode13` | `1` / `2` / `3` | BMD tax codes. Confirm with the tax advisor. |
| `steuercodeSteuerfrei` | `9` | Tax code for tax exempt invoices. |
| `steuercodeReverseCharge` | `22` | Tax code for reverse charge invoices. |
| `debitorStandard` | `20000` | Debtor account for customers without a mapping. |
| `gutschriftModus` | `buchcode` | `buchcode`: credit notes get Buchcode `2` with positive amounts. `negativ`: Buchcode `1` with negative amounts. |
| `kostenstelle` | | Default cost centre when the invoice has none. |
| `filiale` | | Branch number. |
| `charset` | `windows-1252` | `windows-1252`, `iso-8859-1` or `utf-8`. |
| `separator` | `;` | `;`, `,`, `tab` or `\|`. |
| `decimalMark` | `,` | `,` or `.`. |
| `dateFormat` | `DD.MM.YYYY` | `DD.MM.YYYY`, `DDMMYYYY`, `YYYYMMDD` or `YYYY-MM-DD`. |
| `headerRow` | `true` | Write the column names as the first line. |
| `quoteText` | `false` | Wrap text fields in double quotes. Without quotes, separators inside text are replaced by spaces. |
| `taggeldKeyword` | | Expenses whose description contains this word are exported as Taggeld. Empty skips Taggeld. |
| `naechtigungsgeldKeyword` | | Same for Nächtigungsgeld. |
| `monthlyFibu` / `monthlyLohn` | `true` | Which surfaces the monthly schedule produces. |

Charset, separator, decimal mark and date format are configurable because BMD NTCS import definitions are set up per installation by the BMD consultant.

## Mappings

All right-hand sides are free text; there is no BMD API to fetch them from.

| Mapping | Local entity | External value |
| --- | --- | --- |
| `employees` | `user` (Timesheet member) | Dienstverhältnisnummer or Personalnummer in BMD Lohn. Falls back to `Member.employeeId`. |
| `wage-types` | `absence_type` via `list-absence-types` | BMD Lohnart for the absence type. |
| `surcharge-types` | `surcharge_type` via `list-surcharge-types` (fixed list) | BMD Lohnart for `normalstunden`, `ueberstunden-50`, `ueberstunden-100`, `nachtarbeit`, `sonntagsarbeit`, `feiertagsarbeit`, `seg-zulage`, `taggeld`, `naechtigungsgeld`. |
| `debtors` | `customer` via `list-customers` (distinct customers on invoices, keyed by customer number, else name) | Debitorenkonto in BMD FIBU. |

Unmapped employees, absence types, surcharge types and customers never fail a run. They are skipped (or fall back to the default debtor) and reported in `warnings`, so the tables fill themselves from real usage.

## Actions and triggers

| Action | Input | Output |
| --- | --- | --- |
| `build-fibu` | `{ from, to }` (yyyy-MM-dd, defaults to the previous month) | `{ surface, period, files, count, warnings }`, count = invoices |
| `build-lohn` | `{ from, to }` | same, count = lines |
| `build-monthly` (internal, schedule `0 6 1 * *` Europe/Vienna) | none | `{ period, fibu?, lohn?, skipped }` |
| `list-customers`, `list-absence-types`, `list-surcharge-types` (internal) | none | `{ items: [{ id, name }] }` for the mapping editor |
| `list-history` (internal) | none | last 12 runs from state (metadata only; download links expire) |

Two `user_action` triggers with `placement: page` and the `export` page carry the buttons. The period form is rendered by the web from the action `inputSchema`. Do not add an action named `run-full-sync`: the backend queues it after every mapping save.

## File layouts

Both files are CSV with the configured separator, CRLF line breaks and the configured charset (Windows-1252 by default, encoded without any library; `TextEncoder` in the runtime is UTF-8 only).

### FIBU Buchungsimport (`BMD_FIBU_<from>_<to>.csv`)

One line per invoice and tax rate, columns in this order (`FIBU_COLUMNS` in `src/lib/fibu.ts`):

| Column | Content |
| --- | --- |
| `satzart` | `0` |
| `konto` | Debtor account from the `debtors` mapping, else `debitorStandard` |
| `gkonto` | Revenue account by tax rate (20, 10, 13, 0, reverse charge) |
| `belegnr` | Invoice number |
| `belegdatum` / `buchdatum` | Document date |
| `buchsymbol` | `buchungssymbol` |
| `buchcode` | `1`, or `2` for credit notes in `buchcode` mode |
| `prozent` | Tax rate |
| `steuercode` | Configured tax code for the rate |
| `betrag` | Gross amount of the line |
| `steuer` | Tax amount of the line |
| `text` | Customer name and invoice number |
| `extbelegnr` | Customer order number or order reference |
| `faelligkeit` | Due date |
| `kost` | Invoice cost centre, else `kostenstelle` |
| `filiale` | `filiale` |

Rules:

- Only documents with `category` 0 (invoices). A credit note is a document with `invoiceTypeCode` `381`, `eInvoiceDocumentType` `CREDIT_NOTE` or a negative total.
- An invoice with a second tax rate becomes two lines. The net of the second rate is derived from its tax amount, the first rate takes the rest, so the gross amounts add up to the total exactly. When a rate is 0 or the amounts do not fit, the invoice is skipped with warning `second-tax-unsplittable`.
- Tax rates other than 20, 10, 13 and 0 have no account and skip the invoice with `tax-rate-unconfigured`.
- A document date outside the requested period aborts the whole run. That is the most common reason a BMD import is rejected, so the file is never produced.

### Lohn import (`BMD_LOHN_<from>_<to>.csv`)

Columns (`LOHN_COLUMNS` in `src/lib/lohn.ts`): `firmennr`, `dienstverhaeltnisnr`, `lohnart`, `datum_von`, `datum_bis`, `stunden`, `tage`, `betrag`, `text`.

| Source | Lohnart from | Line |
| --- | --- | --- |
| Tasks (net of breaks, running tasks skipped) | `surcharge-types`, entry `normalstunden` | one per employee, hours, period dates |
| Overtime balances | `ueberstunden-50` (tier 1), `ueberstunden-100` (tier 2), `nachtarbeit`, `sonntagsarbeit` (weekend), `feiertagsarbeit` | one per employee and type, hours |
| Approved absences | `wage-types` per absence type | one per absence with its own dates, days (hours when not a full day) |
| Expenses matching a keyword | `taggeld`, `naechtigungsgeld` | one per employee and type, amount |

Balances without tier fields put `overtimeMinutes` on Überstunden 50. An absence crossing the period boundary is cut to the period and counted in calendar days, with warning `absence-clamped`. `seg-zulage` is in the mapping list for completeness but has no data source yet.

## Assumptions to confirm before release

- The column sets above follow the BMD NTCS standard import structure. BMD import definitions are configured per installation, so the exact layout, the Steuercode numbers and the credit note convention (Buchcode 2 versus negative amounts) must be confirmed against a real NTCS installation with the customer's BMD consultant.
- Tasks are read with `userIds` of all colleagues so an organization admin exports every member. Expenses are read without a user filter; if the API restricts them to the caller, Taggeld and Nächtigungsgeld cover only the installer.
- Absences are read with status `APPROVED` only.

## Development

```bash
npm run build      # compile TypeScript into dist/
npm run typecheck
```

Do not run `npm install` inside this directory while `@timesheet/integration-sdk@0.6.0` is unpublished; the `integrations/` root links the local SDK. Tests live in `integrations/tests/bmd.test.ts` and run from the `integrations/` root with `npm test`. `src/lib/writer.ts` is kept identical to the DATEV plugin's copy.
