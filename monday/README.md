# monday.com Sync

> Synchronize Timesheet tasks and todos with monday.com.

Bidirectional synchronization between Timesheet and monday.com. Timesheet todos are mirrored as monday.com items inside the mapped board, and Timesheet time entries are pushed as subitems of the corresponding item (or as a standalone item on the board when no todo is linked).

- Package: `@timesheet/plugin-monday`
- Manifest id: `monday-sync`
- Category: project-management

## Authentication

OAuth 2.0 against monday.com, scopes `boards:read`, `boards:write`, `me:read`, `workspaces:read`, `users:read`.

## Configuration

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `syncDirection` | yes | `bidirectional` | One of `bidirectional`, `timesheet-to-monday`, `monday-to-timesheet`. |
| `webhookSecret` | no | | Shared secret used to verify inbound monday.com webhooks. Required for inbound sync. |
| `itemNameTemplate` | no | `Timesheet entry {startDate} {startTime}-{endTime}` | Item or subitem name used when a time entry has no description. Placeholders: `{description}`, `{projectTitle}`, `{startDate}`, `{endDate}`, `{startTime}`, `{endTime}`, `{startDateTime}`, `{endDateTime}`, `{taskId}`. |

## Mappings

- **Project mapping**: Timesheet project to monday.com board.
- **User mapping**: Timesheet user to monday.com workspace member. Optional. When configured, each user's time entries are assigned to their own monday.com account via the item's person column instead of the OAuth owner.

## Triggers

- **Timesheet Changes** (event): syncs task and todo create, update, and delete events to monday.com.
- **monday.com Webhook** (webhook): receives inbound item changes from monday.com.
- **Scheduled Full Sync** (daily at 02:00 UTC): runs incremental synchronization for all mapped boards.
- **Manual Sync** (user action): triggers a sync from the integration settings page.

## Development

```bash
npm install        # or: npm ci
npm run build      # compile TypeScript into dist/
npm run typecheck
```

The package ships `dist/` and `manifest.json`; the sandboxed plugin runtime loads it by package name, version, and integrity. Shared tests live in `integrations/tests/` and run from the `integrations/` root with `npm test`.
