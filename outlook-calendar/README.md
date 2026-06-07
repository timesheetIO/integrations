# Outlook Calendar Sync

> Intended integration between Timesheet tasks and Outlook (Microsoft 365) calendar events. Early scaffold, not yet functional.

This package is an early scaffold. The handlers are wired into the plugin runtime and return placeholder results (for example, `testConnection` reports OK and `syncTaskToExternal` echoes the task id), but no calls are made to the Microsoft Graph or Outlook Calendar API yet. The manifest below describes the intended shape of the integration rather than working behavior.

- Package: `@timesheet/plugin-outlook-calendar`
- Manifest id: `outlook-calendar-sync`
- Category: calendar
- Status: scaffold (no Outlook Calendar API integration implemented)

## Authentication

OAuth 2.0. Scopes are placeholders (`read`, `write`) and will be replaced with the real Microsoft Graph scopes when the integration is implemented.

## Configuration

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `syncDirection` | yes | `bidirectional` | One of `bidirectional`, `timesheet-to-external`, `external-to-timesheet`. |

## Mappings

- **Project mapping**: Timesheet project to Outlook calendar (placeholder, not yet wired to real Outlook entities).

## Triggers

- **Task Created** (event): scaffolded handler for new Timesheet tasks.
- **Outlook Calendar Webhook** (webhook): scaffolded inbound endpoint.
- **Scheduled Full Sync** (daily at 02:00 UTC): scaffolded background sync.
- **Manual Sync** (user action): scaffolded sync from the integration settings page.

## Development

```bash
npm install        # or: npm ci
npm run build      # compile TypeScript into dist/
npm run typecheck
```

The package ships `dist/` and `manifest.json`; the sandboxed plugin runtime loads it by package name, version, and integrity. Shared tests live in `integrations/tests/` and run from the `integrations/` root with `npm test`.
