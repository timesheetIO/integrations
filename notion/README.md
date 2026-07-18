# Notion Sync

> Synchronize Timesheet todos and time entries with Notion databases.

Bidirectional synchronization between Timesheet and Notion. Timesheet todos are mirrored 1:1 with pages in the mapped Notion database; Timesheet time entries (tasks) optionally sync as rows of a time-log database, related to the todo's page. Changes made in Notion flow back through webhooks and scheduled syncs.

- Package: `@timesheet/plugin-notion`
- Manifest id: `notion-sync`
- Category: project-management

## Authentication

OAuth 2.0 against Notion (`api.notion.com/v1/oauth`). Three Notion-specific deviations:

- The token endpoint expects HTTP Basic auth (`client_id:client_secret`), like Intuit.
- There are no OAuth scopes; capabilities are configured on the integration in Notion's developer dashboard, and the user selects which pages/databases to share during the OAuth flow. Only shared databases are visible to the plugin.
- Access tokens do not expire and there is no refresh token; the client tolerates a failing `refreshToken` and surfaces the original 401 (which means the share was revoked).

All requests are pinned to `Notion-Version: 2022-06-28`. Notion rate-limits at roughly 3 requests/second; the client retries 429s honoring `Retry-After`.

## Configuration

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `syncDirection` | yes | `bidirectional` | One of `bidirectional`, `timesheet-to-notion`, `notion-to-timesheet`. |
| `timeLogDatabaseId` | no | (unset) | Notion database id for time entries. When set, Timesheet tasks sync as rows of this database. |
| `statusProperty` | no | auto | Property name for todo status; auto-detected otherwise. |
| `dueDateProperty` | no | auto | Date property name for todo due dates; auto-detected otherwise. |

## Mappings

- **Project mapping** (required): Timesheet project to Notion database. Each page (row) of the database is a Timesheet todo.

## Property discovery

Notion databases are schemaless, so the plugin discovers the relevant properties from each database's schema and caches them in plugin state (the monday board-columns pattern):

- **Title**: the `title` property (always exists) carries the todo name / time-entry description.
- **Status**: first `status` property (else first `checkbox`). For status properties the done/open options come from the schema's Complete and To-do groups.
- **Due date**: first `date` property.
- **Time-log databases** additionally resolve the first `number` property (hours) and first `relation` property (link to the todo's page).

Config overrides (`statusProperty`, `dueDateProperty`) win when they name an existing property.

## Time entries (time-log database)

With `timeLogDatabaseId` set, each Timesheet task becomes a row: title = description, date property = start/end datetime range, number property = net worked hours (`duration - durationBreak`), relation = the todo's page. Inbound edits to time-log rows flow back to the local task; rows without a relation to a synced todo page are skipped (no local project context).

## Triggers

- **Timesheet Changed** (event): pushes todo and task create/update/delete events to Notion.
- **Notion Webhook** (webhook): receives inbound page changes.
- **Scheduled Full Sync** (daily at 02:00 UTC): reconciles both directions.
- **Manual Sync** (user action): pulls pages edited since the last run.

### Webhook

Notion webhook subscriptions are app-level: one URL per integration, configured in Notion's developer dashboard (not per-user via API). Deliveries carry `workspace_id`, so the backend routes each event to the installation whose credential holds that workspace (captured from the OAuth token response), the same model as the QuickBooks app-level webhook. The one-time handshake delivery carries a `verification_token`, which the handler stores as the HMAC secret; subsequent deliveries are verified against `X-Notion-Signature` (`sha256=<hex>` over the raw body).

### Deletes and archiving

Notion has no hard delete via API: outbound deletes archive the page (move to trash). Inbound deletes only arrive via the `page.deleted` webhook event or as an archived page on fetch, because database queries exclude archived pages; the scheduled full sync therefore does not detect deletions on its own.

### Echo suppression caveat

Notion truncates `last_edited_time` to the minute. The standard SDK guards apply (`isAlreadySyncedLocalChange` outbound, `isStaleExternalChange` on `lastEditedTime` inbound), but a genuine Notion edit within the same minute as the plugin's own write compares stale and is picked up by the next edit or scheduled full sync.

## Development

```bash
npm install        # or: npm ci
npm run build      # compile TypeScript into dist/
npm run typecheck
```

The package ships `dist/` and `manifest.json`; the sandboxed plugin runtime loads it by package name, version, and integrity (`sha512-...`). Shared tests live in `integrations/tests/` and run from the `integrations/` root with `npm test`.
