# Google Calendar Sync

> Synchronize Timesheet tasks with Google Calendar.

Bidirectional synchronization between Timesheet tasks and Google Calendar events. Each mapped Timesheet project corresponds to a Google Calendar, so time entries appear as calendar events and calendar changes flow back into Timesheet.

- Package: `@timesheet/plugin-google-calendar`
- Manifest id: `google-calendar-sync`
- Category: calendar

## Authentication

OAuth 2.0 against Google, scopes `calendar.readonly` and `calendar.events`.

## Configuration

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `syncDirection` | yes | `bidirectional` | One of `bidirectional`, `timesheet-to-google`, `google-to-timesheet`. |

## Mappings

- **Calendar mapping**: Timesheet project to Google Calendar.

## Triggers

- **Task Changed** (event): syncs task create, update, and delete events to Google Calendar.
- **Google Calendar Webhook** (webhook): receives inbound changes from Google Calendar.
- **Scheduled Full Sync** (daily at 02:00 UTC): runs incremental synchronization for all mapped calendars.
- **Manual Sync** (user action): triggers a sync from the integration settings page.

## Development

```bash
npm install        # or: npm ci
npm run build      # compile TypeScript into dist/
npm run typecheck
```

The package ships `dist/` and `manifest.json`; the sandboxed plugin runtime loads it by package name, version, and integrity. Shared tests live in `integrations/tests/` and run from the `integrations/` root with `npm test`.
