# DATEV Export

> DATEV import files from Timesheet: a Buchungsstapel (EXTF) from outgoing invoices and payroll movements for LODAS or Lohn und Gehalt.

The plugin reads the organization's invoices, absences, overtime balances and tracked time and writes files the tax advisor imports into DATEV. Nothing is sent to DATEV directly; every run produces downloads. Organization installations only, Business plan.

- Package: `@timesheet/plugin-datev`
- Manifest id: `datev`
- Category: accounting
- Data access: `documents`, `absences`, `overtime`, `tasks`, `expenses`, `colleagues` (all read only)

## Surfaces

| Surface | Source | Output |
| --- | --- | --- |
| Buchungsstapel | Invoices (`Document`, category 0) of the organization in the period | `EXTF_Buchungsstapel_<from>-<to>.csv`, one per fiscal year touched |
| Payroll, LODAS | Tracked time, approved absences, overtime balances | `LODAS_Stammdaten_<from>.txt` and `LODAS_Bewegungsdaten_<from>.txt` |
| Payroll, Lohn und Gehalt | same | `LuG_Bewegungsdaten_<from>.txt` |

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `beraternummer` | required | DATEV Beraternummer, 1 to 7 digits |
| `mandantennummer` | required | Mandantennummer, 1 to 5 digits |
| `skr` | `SKR03` | Chart of accounts; sets the default revenue accounts |
| `sachkontenlaenge` | `4` | Length of general ledger accounts, 4 to 8 |
| `wirtschaftsjahrBeginn` | `01.01.` | Fiscal year start as `TT.MM.` |
| `formatVersion` | `700` | DATEV-Format version written to the header |
| `charset` | `windows-1252` | File charset; `utf-8` only on request of the Kanzlei |
| `festschreibung` | `false` | Header and per-row Festschreibung flag |
| `steuersatzStandard`, `steuersatzErmaessigt` | `19`, `7` | Rates that map to the two taxed revenue accounts |
| `erloeskontoStandard` | `8400` / `4400` | Revenue account, standard rate |
| `erloeskontoErmaessigt` | `8300` / `4300` | Revenue account, reduced rate |
| `erloeskontoSteuerfrei` | `8100` / `4100` | Revenue account for exempt and zero rated invoices |
| `erloeskontoReverseCharge` | `8336` / `4336` | Revenue account for reverse charge invoices (services to businesses in other EU countries); use `8337` / `4337` for domestic § 13b UStG cases |
| `debitorStandard` | `10000` | Debtor account for customers without a mapping |
| `payrollTarget` | `LODAS` | `LODAS` or `LUG` |
| `mandantLohn` | `mandantennummer` | Mandantennummer for payroll when it differs |
| `lohnartArbeitsstunden` | empty | Wage type for tracked hours; empty means hours are not exported |
| `lohnartUeberstunden`, `lohnartMinderstunden` | empty | Wage types for overtime and undertime from the overtime balances |
| `verpflegungKeyword`, `uebernachtungKeyword` | `Verpflegung`, `Übernachtung` | Expenses whose description contains the keyword are summed as Verpflegungsmehraufwand or Übernachtungskosten; empty disables it |
| `lohnartVerpflegung`, `lohnartUebernachtung` | empty | Wage types for the two allowances; empty means the amounts are not exported |
| `customerWindowMonths` | `24` | Window for the customer list of the debtor mapping |
| `monthlyBuchungsstapel`, `monthlyLohn` | `true` | Surfaces the monthly schedule produces |

## Mappings (system `datev`)

| Mapping | Local entity | External value |
| --- | --- | --- |
| `wage-types` | absence type (`list-absence-types`) | Lohnart |
| `employees` | user | Personalnummer (falls back to `Member.employeeId`) |
| `debtors` | customer from invoices (`list-customers`, id = `customerId` or the customer name) | Debitorenkonto (falls back to `debitorStandard`) |

Unmapped items never fail a run. They are reported in `warnings` and skipped (wage types, employees) or replaced by the default account (debtors).

## Actions

- `build-buchungsstapel` `{ from, to }`: period as `JJJJ-MM-TT` or `TT.MM.JJJJ`; no period means the previous month.
- `build-payroll` `{ from, to }`: same input; the period must lie within one calendar month.
- `build-monthly` (internal, schedule `0 6 1 * *` Europe/Berlin): previous month for every enabled surface.
- `list-customers`, `list-absence-types` (internal): left sides of the mappings.
- `list-history` (internal): the last 12 runs from state, for the history table.

Every export returns `{ surface, period, files, count, warnings }`. `files` are `WrittenFile`s with a short-lived signed URL.

## File layouts

### Buchungsstapel (EXTF)

DATEV-Format version 700, format category 21, Buchungsstapel format version 12, 125 data columns (`EXTF_COLUMNS` in `src/lib/extf.ts`). Semicolon separated, text quoted, comma decimals, CRLF. One line per invoice:

| Column | Value |
| --- | --- |
| Umsatz | gross total, positive |
| Soll/Haben | `S` for invoices, `H` for credit notes (`invoiceTypeCode` 381, `eInvoiceDocumentType` CREDIT_NOTE, or a negative total) |
| WKZ Umsatz | `EUR`; other currencies are skipped with a warning |
| Konto | debtor account |
| Gegenkonto | revenue account by tax category |
| BU-Schlüssel | empty: the default revenue accounts are automatic accounts |
| Belegdatum | `TTMM` |
| Belegfeld 1 | invoice number, restricted to the allowed characters, 36 max |
| Buchungstext | customer plus invoice number, 60 max |
| KOST1 | `costCenter` |
| EU-Land u. UStID | customer VAT id on reverse charge invoices |
| Festschreibung | from config |
| Leistungsdatum, Fälligkeit | `deliveryDate`, `dueDate` as `TTMMJJJJ` |

Tax category mirrors `ZugferdInvoiceBuilder`: reverse charge, else standard or reduced by rate, else exempt when a `taxExemptionReason` is set, else zero rated. Invoices with a second tax rate or a rate matching neither configured rate are skipped with a warning. Belegdatum outside the period is a hard error. A period across two fiscal years produces two files, each with its own WJ-Beginn and date range in the header.

### LODAS

Two ASCII files, Windows-1252, CRLF, each with `[Allgemein]` and `[Satzbeschreibung]` sections:

- Stammdaten, record `100` `u_lod_psd_mitarbeiter`: `pnr_betriebliche#psd; duevo_familienname#psd; duevo_vorname#psd`
- Bewegungsdaten, record `200` `u_lod_bwd_buchung_standard`: `pnr#bwd; abrechnung_zeitraum#bwd; la_eigene#bwd; bs_wert_butab#bwd; bs_nr#bwd; kostenstelle#bwd`

`abrechnung_zeitraum` is the first day of the payroll month. Both payroll targets book every line on one Abrechnungsmonat, so `build-payroll` rejects a period that spans more than one calendar month. `bs_nr` is `1` for hours, `2` for days and `3` for amounts (`LODAS_BS_NR`).

Assumptions to confirm against the Kanzlei's LODAS Schnittstellenbeschreibung before the first import: the field names and the `bs_nr` values.

### Lohn und Gehalt

One ASCII file, Windows-1252, CRLF, header row, columns `Mandant; Personalnummer; Abrechnungsmonat (MM/JJJJ); Lohnart; Anzahl; Betrag; Kostenstelle; Bemerkung` (`LUG_COLUMNS`). Confirm the column order against the import definition configured in Lohn und Gehalt.

### Payroll values

- Hours: `Task.duration` (seconds, net of breaks) summed per employee and converted to hours with two decimals; running tasks are ignored.
- Absences: approved absences only. Fully inside the period they use the backend's `totalDays` / `totalHours`; absences crossing the period boundary are prorated by calendar days and reported (`absence_prorated`). Full day absences are exported in days, others in hours, one line per wage type.
- Overtime and undertime: `overtimeMinutes` / `undertimeMinutes` of the balances whose period start lies in the period.
- Travel allowances: expenses in the period whose description contains `verpflegungKeyword` or `uebernachtungKeyword` (case-insensitive) are summed per employee and written as one amount line per wage type (`lohnartVerpflegung`, `lohnartUebernachtung`; LODAS `bs_nr` 3, Lohn und Gehalt `Betrag` column). A keyword that matches expenses without a configured wage type is reported once as `expense_lohnart_missing`.

## Development

```bash
npm run build      # compile TypeScript into dist/
npm run typecheck
```

Shared tests live in `integrations/tests/datev.test.ts` and run from the `integrations/` root with `npx jest tests/datev.test.ts`. The writer helpers in `src/lib/writer.ts` are kept identical to the BMD plugin's copy.
