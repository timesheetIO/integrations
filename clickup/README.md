# ClickUp Sync

> Synchronize Timesheet tasks and todos with ClickUp.

Bidirectional synchronization between Timesheet and ClickUp. Timesheet todos are mirrored as ClickUp tasks inside the mapped ClickUp list, and Timesheet time entries are pushed as ClickUp time entries attached to the corresponding task (or at workspace level when no todo is linked).

- Package: `@timesheet/plugin-clickup`
- Manifest id: `clickup-sync`
- Category: project-management

## Authentication

OAuth 2.0 against ClickUp.

## Configuration

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `syncDirection` | yes | `bidirectional` | One of `bidirectional`, `timesheet-to-clickup`, `clickup-to-timesheet`. |
| `webhookSecret` | no | | Shared secret returned by ClickUp when registering the webhook. Required to verify inbound webhooks. |

## Mappings

- **Project mapping**: Timesheet project to ClickUp list.
- **User mapping**: Timesheet user to ClickUp workspace member. Optional, and only useful in multi-user workspaces on ClickUp paid plans, where it lets each user's time entries appear under their own ClickUp account instead of the OAuth owner, and carries ClickUp task assignees onto the matching Timesheet todos.

## Triggers

- **Timesheet Changes** (event): syncs task and todo create, update, and delete events to ClickUp.
- **ClickUp Webhook** (webhook): receives inbound task changes from ClickUp.
- **Scheduled Full Sync** (daily at 02:00 UTC): runs incremental synchronization for all mapped lists.
- **Manual Sync** (user action): triggers a sync from the integration settings page.

## Organization installs

ClickUp time is never imported into Timesheet, only written out, so unlike the other sync
plugins there is no inbound time to misattribute on an organization install. Outbound entries
carry the mapped member as their `assignee`, which ClickUp honours on paid plans and ignores
on Free.

What the user mapping adds inbound is assignment: an imported ClickUp task carries its
assignees onto the local todo. An unassigned ClickUp task clears the local assignment, while
a task assigned only to people this installation has not mapped leaves it untouched, since
guessing there would either drop a real assignee or invent one.

Assignees are read inbound but not written outbound: ClickUp needs an add/remove diff on task
update, so Timesheet does not currently push assignment changes back.

## Development

```bash
npm install        # or: npm ci
npm run build      # compile TypeScript into dist/
npm run typecheck
```

The package ships `dist/` and `manifest.json`; the sandboxed plugin runtime loads it by package name, version, and integrity. Shared tests live in `integrations/tests/` and run from the `integrations/` root with `npm test`.
