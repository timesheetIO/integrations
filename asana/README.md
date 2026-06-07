# Asana Sync

> Synchronize Timesheet todos and time entries with Asana.

Bidirectional synchronization between Timesheet and Asana. Timesheet todos are mirrored 1:1 with Asana tasks in the mapped project, and Timesheet time entries attached to a todo are logged as Asana time-tracking entries on the corresponding task. Changes made in Asana flow back through webhooks and scheduled syncs.

- Package: `@timesheet/plugin-asana`
- Manifest id: `asana-sync`
- Category: project-management

## Authentication

OAuth 2.0 against Asana.

## Configuration

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `syncDirection` | yes | `bidirectional` | One of `bidirectional`, `timesheet-to-asana`, `asana-to-timesheet`. |
| `workspaceId` | no | | Optional. When set, project lookups are scoped to this Asana workspace gid. |

## Mappings

- **Project mapping**: Timesheet project to Asana project.

## Triggers

- **Todo Changed** (event): syncs todo create, update, and delete events to Asana tasks.
- **Time Entry Changed** (event): logs Timesheet time entries as Asana time-tracking entries.
- **Asana Webhook** (webhook): receives inbound task changes from Asana.
- **Scheduled Full Sync** (daily at 02:00 UTC): runs a complete reconciliation sync.
- **Manual Sync** (user action): runs a full sync from the integration settings page.

## Development

```bash
npm install        # or: npm ci
npm run build      # compile TypeScript into dist/
npm run typecheck
```

The package ships `dist/` and `manifest.json`; the sandboxed plugin runtime loads it by package name, version, and integrity. Shared tests live in `integrations/tests/` and run from the `integrations/` root with `npm test`.
