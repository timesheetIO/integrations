# Outlook Calendar Sync

> Synchronize Timesheet tasks with Outlook Calendar.

Bidirectional synchronization between Timesheet tasks and Outlook calendar events through Microsoft Graph. Each mapped Timesheet project corresponds to an Outlook calendar, so time entries appear as calendar events and calendar changes flow back into Timesheet. Works with Microsoft 365 work or school accounts in any tenant and with personal Outlook.com accounts.

- Package: `@timesheet/plugin-outlook-calendar`
- Manifest id: `outlook-calendar-sync`
- Category: calendar

## Authentication

OAuth 2.0 against the Microsoft identity platform `common` endpoints (any tenant plus personal accounts), with PKCE. Delegated scopes `offline_access` and `Calendars.ReadWrite`. The refresh grant sends the same scopes (`refreshParams`). The client id and secret of the multi-tenant Entra app live on the Integration row; setup is in `backend/doc/integration/outlook.md`.

## Configuration

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `syncDirection` | yes | `bidirectional` | One of `bidirectional`, `timesheet-to-outlook`, `outlook-to-timesheet`. |

## Mappings

- **Calendar mapping**: Timesheet project to Outlook calendar.

## How it syncs

- **Timesheet to Outlook**: task changes create, update or delete events. Events carry a hidden `timesheetId` extended property, so a lost mapping (for example after a reinstall) relinks instead of duplicating.
- **Outlook to Timesheet**: one change feed (`calendarView/delta`) per mapped calendar, covering a year back and a year ahead and restarted monthly. New events become tasks in the user's Timesheet time zone; events cancelled or deleted in Outlook delete their task.
- **Notifications**: one Microsoft Graph subscription on the user's mailbox events (`me/events`). A notification only triggers a pass over the change feeds. The worker answers Graph's `validationToken` handshake on the webhook URL.
- **Titles**: events created in Timesheet show the project title with the task description in the body. Events created in Outlook keep their subject, which stays in sync with the task description.

## Triggers

- **Task Changed** (event, sync mode): syncs task create, update, and delete events to Outlook.
- **Outlook Calendar Notifications** (webhook): Microsoft Graph change notifications. `coalesce: true` makes a burst of notifications join a run that is still queued, so a busy mailbox stays under the installation's execution rate limit.
- **Scheduled Full Sync** (daily at 02:00 UTC): catches up on task changes.
- **Subscription Renewal** (daily at 03:00 UTC): renews the subscription inside 48 hours of its expiry (Graph allows at most 10,080 minutes) and reads the change feeds once, which picks up missed notifications and calendars shared with the user.
- **Manual Sync** (user action): reads the change feeds and sets up the subscription. `{ "fullResync": true }` starts the feeds over.

## Development

```bash
npm install        # or: npm ci
npm run build      # compile TypeScript into dist/
npm run typecheck
```

The package ships `dist/` and `manifest.json`; the sandboxed plugin runtime loads it by package name, version, and integrity. Shared tests live in `integrations/tests/` and run from the `integrations/` root with `npm test`.
