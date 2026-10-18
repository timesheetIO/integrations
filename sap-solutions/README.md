# Timesheet for SAP® solutions

> Export worked time and absences from Timesheet as import files for SAP SuccessFactors® solutions and the Cross-Application Time Sheet (CATS) in SAP S/4HANA® software.

Nothing is sent to SAP. The user downloads CSV files and imports them with standard SAP tools (SuccessFactors) or hands them to their SAP team's load program (CATS). No SAP partnership, certification or API access is involved. Plan and research: `dev/features/sap-solutions-plugin.md` in the monorepo.

- Package: `@timesheet/plugin-sap-solutions`
- Manifest id: `sap-solutions`
- Category: accounting
- Install scope: organization or personal profile (`installScope = BOTH`); the SuccessFactors target needs an organization

## Naming

The product name is **Timesheet for SAP® solutions** in every locale. Follow SAP's trademark guidelines on every surface: ® and a descriptor on the first mention ("SAP S/4HANA® software"), the attribution line at the end, never "SAP" as a bare noun or as part of our own name, no SAP logo, no certification wording. Details in section 3 of the plan.

## Requirements

Data access: `tasks`, `tags`, `absences`, `colleagues`.

- **Organization install**: exports every member (`getColleagues` with `limit: -1`, tasks with all their `userIds`).
- **Profile install**: exports the installing user only, for consultants who book into a client's CATS. The personnel number comes from the `employees` mapping for the user or, usually, from the `personnelNumber` setting. Without either the export stops with a message. `target = successfactors` is refused on a profile.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `target` | `cats` | `cats` or `successfactors`. One installation writes one target. |
| `personnelNumber` | | Profile installs only: the user's personnel number at the client. |
| `companyCode` | | CATS: written into every row. |
| `costObjectType` | `wbs` | CATS: what the project mapping holds: `wbs`, `costCenter` or `order`. Decides the column it lands in. |
| `defaultActivityType` | | CATS: activity type for tasks without a mapped tag. |
| `aggregation` | `day` | CATS: `day` (one row per employee, day, cost object, activity type) or `task` (one row per task and day). |
| `timeMode` | `duration` | SuccessFactors: `duration` (hours per day) or `clock` (start and end plus Break rows). |
| `defaultTimeType` | | SuccessFactors: attendance time type for tasks without a mapped tag. Empty means `category = Attendance` and the time profile's default import type. |
| `clockFormat` | `24h` | SuccessFactors clock mode: `12h` when the uploader is signed in in US English. |
| `includeAbsences` | `false` | SuccessFactors: also write the Employee Time file. |
| `separator`, `decimalMark`, `dateFormat`, `charset`, `headerRow`, `quoteText` | `;`, `,`, `YYYYMMDD`, `utf-8`, `true`, `false` | CATS file format, set to match the customer's load program. SuccessFactors files are always comma separated UTF-8 with MM/DD/YYYY dates. |

`x-ui-condition` is not rendered by the web, so all options show for both targets; titles say which target they belong to.

## Mappings

`IntegrationEntityMapping` stores one external value per installation, entity type and local id, so each local entity type carries one mapping.

| Mapping | Local entity | External value | Fallback |
| --- | --- | --- | --- |
| `employees` | `user` | personnel number (CATS) or SuccessFactors user ID | `Member.employeeId` from the colleague list, then skipped with a warning |
| `cost-objects` | `project` | WBS element, cost center or internal order | empty column with a warning |
| `activity-types` | `tag` (via `list-tags`) | CATS activity type or SuccessFactors time type | `defaultActivityType` / `defaultTimeType`; first mapped tag wins, conflicts are reported |
| `absence-types` | `absence_type` (via `list-absence-types`) | SuccessFactors Time Off time type | absence skipped with a warning |

## Actions and triggers

| Action | Trigger | What it does |
| --- | --- | --- |
| `build-export` | user action on the page, input `from`/`to` | Writes the file(s) for the period and records the run. |
| `build-monthly` | schedule `0 6 1 * *` Europe/Berlin | Same for the previous calendar month. |
| `list-tags`, `list-absence-types` | mapping editor | Left-hand lists of the tag and absence mappings. |
| `list-history` | history table | Last 12 runs (metadata only; download links expire). |

## Time handling

- Task times are local wall clock with an offset. Rows use the employee's calendar day in the offset the task started in.
- Tasks are split at local midnight; breaks (pauses) are removed from the day they fall on. When a task has `durationBreak` but no pause list, the break is spread over the days in proportion.
- Tasks are read from the day before the period, so the morning part of a night shift that started the evening before is counted. Only days inside the period are written.
- Running and deleted tasks are skipped.

## File layouts

### CATS (`CATS_<from>_<to>.csv`)

Column names follow the S/4HANA Cloud API `API_MANAGE_WORKFORCE_TIMESHEET`. The BAPI names are for on-premise load programs calling `BAPI_CATIMESHEETMGR_INSERT` and are to be confirmed against the customer's system.

| Column | Content | BAPI `CATSRECORDS_IN` |
| --- | --- | --- |
| `PersonnelNumber` | employee mapping | `EMPLOYEENUMBER` |
| `CompanyCode` | setting | (data entry profile) |
| `TimeSheetDate` | day, in `dateFormat` | `WORKDATE` |
| `RecordedHours` | net hours, 2 decimals | `CATSHOURS` |
| `WBSElement` | project mapping when `costObjectType = wbs` | `WBS_ELEMENT` |
| `ReceiverCostCenter` | project mapping when `costObjectType = costCenter` | `REC_CCTR` |
| `InternalOrder` | project mapping when `costObjectType = order` | `REC_ORDER` |
| `ActivityType` | tag mapping or default | `ACTTYPE` |
| `TimeSheetNote` | task descriptions, distinct, joined with `; `, cut to 40 characters | `SHORTTEXT` |

Keys are never shortened; SAP rejecting a too-long key is safer than booking onto a cut one.

### SuccessFactors External Time Data (`ExternalTimeData_<from>_<to>.csv`)

`userId,startDate,endDate,startTime,endTime,hours,timeType,category`, from SAP's "Filling In the Template for External Time Data" (2H 2026). Duration mode fills `hours`; clock mode fills `startTime`/`endTime` (`hh:mm:ss`, or `hh:mm:ss am` in 12h) plus one `Break` row per pause. `endDate` is set only for tasks past midnight, which SuccessFactors accepts only with the Time Tracking subscription (reported as a warning). Upload with date format MM/dd/yyyy.

### SuccessFactors Employee Time (`EmployeeTime_<from>_<to>.csv`)

`externalCode,userId,timeType,startDate,endDate,approvalStatus,fractionQuantity`. Approved absences that **start** in the period, so a monthly run never exports an absence twice. `externalCode = timesheet-<absence id>`; `fractionQuantity` (decimal hours) only for a part-day absence on a single day. Dates MM/DD/YYYY as SAP prescribes.

## Assumptions to confirm before release

- SuccessFactors column sets come from SAP's help pages. Compare them with the templates downloaded from a real tenant (Admin Center, Import and Export Data, Download Template for External Time Data and Employee Time), including whether the template carries extra columns.
- The CATS layout is ours. Have a customer's SAP team load one file and report rejected fields; confirm the BAPI field names.
- Tags come from `listTags` with the installer's visibility; tags of other teams may be missing from the mapping list.

## Development

```bash
npm run build      # compile TypeScript into dist/
npm run typecheck
```

Tests live in `integrations/tests/sap-solutions.test.ts` and run from the `integrations/` root with `npm test`. `src/lib/writer.ts` is kept identical to the DATEV and BMD copies.
