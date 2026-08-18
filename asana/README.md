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
- **User mapping**: Timesheet user to Asana user. Optional, and only needed for teams. The
  candidates are the members of the configured workspace, or of every workspace the token can
  see when none is configured.

## Triggers

- **Todo Changed** (event): syncs todo create, update, and delete events to Asana tasks.
- **Time Entry Changed** (event): logs Timesheet time entries as Asana time-tracking entries.
- **Asana Webhook** (webhook): receives inbound task changes from Asana.
- **Scheduled Full Sync** (daily at 02:00 UTC): runs a complete reconciliation sync.
- **Manual Sync** (user action): runs a full sync from the integration settings page.

## Organization installs

Inbound work runs as the installing admin, so without a user mapping every member's imported
time is booked on that admin. With the mapping in place, an imported time entry is booked on the member behind its `created_by`. Once any user is mapped,
records belonging to someone this installation has not mapped are skipped rather than booked
on the admin: attribution is create-only, because `TaskUpdateInput` carries no userId, so a
wrong owner can never be corrected afterwards.

Outbound attribution is not possible: Asana marks `created_by` on a time tracking entry as
read-only, so entries Timesheet writes always appear under the connected Asana account. Only
the inbound direction can be attributed per member.

## Development

```bash
npm install        # or: npm ci
npm run build      # compile TypeScript into dist/
npm run typecheck
```

The package ships `dist/` and `manifest.json`; the sandboxed plugin runtime loads it by package name, version, and integrity. Shared tests live in `integrations/tests/` and run from the `integrations/` root with `npm test`.
