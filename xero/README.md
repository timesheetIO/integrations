# Xero Sync

> Intended integration between Timesheet and Xero. Early scaffold, not yet functional.

This package is an early scaffold. The handlers are wired into the plugin runtime and return placeholder results (for example, `testConnection` reports OK and `syncTaskToExternal` echoes the task id), but no calls are made to the Xero API yet. The manifest below describes the intended shape of the integration rather than working behavior.

- Package: `@timesheet/plugin-xero`
- Manifest id: `xero-sync`
- Category: accounting
- Status: scaffold (no Xero API integration implemented)

## Authentication

OAuth 2.0. Scopes are placeholders (`read`, `write`) and will be replaced with the real Xero scopes when the integration is implemented.

## Configuration

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `syncDirection` | yes | `bidirectional` | One of `bidirectional`, `timesheet-to-external`, `external-to-timesheet`. |

## Mappings

- **Project mapping**: Timesheet project to Xero (placeholder, not yet wired to real Xero entities).

## Triggers

- **Task Created** (event): scaffolded handler for new Timesheet tasks.
- **Xero Webhook** (webhook): scaffolded inbound endpoint.
- **Scheduled Full Sync** (daily at 02:00 UTC): scaffolded background sync.
- **Manual Sync** (user action): scaffolded sync from the integration settings page.

## Development

```bash
npm install        # or: npm ci
npm run build      # compile TypeScript into dist/
npm run typecheck
```

The package ships `dist/` and `manifest.json`; the sandboxed plugin runtime loads it by package name, version, and integrity. Shared tests live in `integrations/tests/` and run from the `integrations/` root with `npm test`.
