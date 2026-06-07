# Google Health

> Import Google Health exercise sessions as Timesheet time entries.

Reads workout sessions from Google Health and creates a Timesheet task on the project mapped to the corresponding exercise type. This integration is read-only: no data is written back to Google Health.

- Package: `@timesheet/plugin-google-health`
- Manifest id: `google-health-sync`
- Category: wellness

## Authentication

OAuth 2.0 against Google, scope `health`.

## Configuration

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `fallbackProjectId` | no | | Project used when an exercise type has no explicit mapping. Leave blank to skip unmapped types. |
| `lookbackDays` | no | `7` | On the first sync, how far back to import workouts (1 to 90 days). |
| `syncTagId` | no | | Optional. Tags imported tasks so you can filter them in reports. |

## Mappings

- **Exercise type mapping**: Google Health exercise type to Timesheet project. Unmapped types fall back to the configured fallback project, or are skipped when none is set.

## Triggers

- **Cleanup on Task Delete** (event): removes workout mappings when imported tasks are deleted in Timesheet, so a later sync can re-import them.
- **Hourly Workout Sync** (hourly): pulls new Google Health exercises and creates Timesheet tasks.
- **Manual Sync** (user action): triggers an inbound sync from the integration settings page.

## Development

```bash
npm install        # or: npm ci
npm run build      # compile TypeScript into dist/
npm run typecheck
```

The package ships `dist/` and `manifest.json`; the sandboxed plugin runtime loads it by package name, version, and integrity. Shared tests live in `integrations/tests/` and run from the `integrations/` root with `npm test`.
