# Basecamp Sync

> Synchronize Timesheet todos and time entries with Basecamp.

Bidirectional synchronization between Timesheet and Basecamp. Timesheet todos are mirrored 1:1 with Basecamp to-dos in the mapped project, and Timesheet time entries attached to a todo are logged as Basecamp timesheet entries on the corresponding to-do. Changes made in Basecamp flow back through project webhooks and scheduled syncs.

- Package: `@timesheet/plugin-basecamp`
- Manifest id: `basecamp-sync`
- Category: project-management

## Authentication

OAuth 2.0 against 37signals Launchpad. The app is registered at
[launchpad.37signals.com/integrations](https://launchpad.37signals.com/integrations).

Two things are specific to Basecamp:

- **Account-scoped API host.** There is no fixed base URL. After connecting, the plugin
  calls `GET https://launchpad.37signals.com/authorization.json`, picks the account whose
  `product` is `bc3`, and talks to `https://3.basecampapi.com/{accountId}`. The resolved
  account id is cached in plugin state (`basecamp:account-id`).
- **Mandatory User-Agent.** Basecamp answers `400 Bad Request` to any request without a
  `User-Agent` naming the app and a contact. The client sends
  `Timesheet (https://timesheet.io)` on every call.

Access tokens expire after two weeks and are refreshed through the runtime's
`credentials.refreshToken` path.

## Configuration

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `syncDirection` | yes | `bidirectional` | One of `bidirectional`, `timesheet-to-basecamp`, `basecamp-to-timesheet`. |
| `pushTimeEntries` | no | `auto` | `off` disables writing time into Basecamp entirely. |
| `todoListName` | no | | Name of the Basecamp to-do list new to-dos are created in. Defaults to the project's first list. |

## Mappings

- **Project mapping**: Timesheet project to Basecamp project (bucket).

## Triggers

- **Todo Changed** (event): syncs todo create, update, and delete events to Basecamp to-dos.
- **Time Entry Changed** (event): logs Timesheet time entries as Basecamp timesheet entries.
- **Basecamp Webhook** (webhook): receives inbound to-do changes from Basecamp.
- **Scheduled Full Sync** (daily at 02:00 UTC): runs a complete reconciliation sync and
  re-asserts the per-project webhooks.
- **Manual Sync** (user action): runs a full sync from the integration settings page.
- **Register Webhooks** (user action): creates the per-project webhooks on demand.

## Behavior notes

**Timesheets is a paid Basecamp add-on.** It is included on Basecamp Pro Unlimited and sold
separately on Plus; Free accounts do not have it. The plugin reads the project's
`timesheet_enabled` flag before touching any timesheet endpoint and skips time sync with
reason `timesheet-not-enabled` when it is off. To-do sync is unaffected, so the integration
stays useful on every plan. The flag is cached in state for 24 hours so enabling the add-on
takes effect without reconnecting.

**Time entries need a linked todo.** A Basecamp timesheet entry hangs off a recording, and
the only recording this plugin owns is the to-do mirrored from a Timesheet todo. Time
entries with no todo are skipped with reason `missing-todo-on-task`. Basecamp also supports
project-level entries, but their recording id is only discoverable from entries that already
exist, so that path is not wired up.

**Webhooks are unsigned and per project.** Basecamp sends no HMAC signature, so the payload
is treated as an untrusted hint: `handleWebhook` refetches the to-do with the installation's
own token and drops anything outside a mapped bucket. Hooks are created one per mapped
project with `types: ["Todo"]`. Basecamp deactivates a hook after 10 failed deliveries, so
the scheduled sync replaces inactive hooks on each run. Client-role Basecamp users get
`403 Forbidden` on webhook endpoints; those installations fall back to scheduled sync only.

**No webhook type exists for timesheet entries.** Inbound time changes are picked up by the
scheduled full sync reading `GET /projects/{id}/timesheet.json`, not in real time.

**Rate limits are per IP.** Basecamp allows roughly 50 requests per 10 seconds per IP, and
the shared plugin runtime pool consumes that budget collectively. The client honors
`Retry-After` on `429` with up to 3 retries, and the full sync uses the
`/projects/recordings.json` feed so one paginated call covers every mapped project.

**Basecamp update semantics.** A to-do `PUT` clears any field left out of the payload, so
updates refetch the to-do and carry over its assignees and completion subscribers.
Completion is a separate subresource (`POST`/`DELETE .../completion.json`) and cannot be set
through the update payload. Basecamp has no hard delete for to-dos, so deletes trash the
recording instead.

## Development

```bash
npm install        # or: npm ci
npm run build      # compile TypeScript into dist/
npm run typecheck
```

The package ships `dist/` and `manifest.json`; the sandboxed plugin runtime loads it by package name, version, and integrity. Shared tests live in `integrations/tests/` and run from the `integrations/` root with `npm test`.
