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

- **Project mapping** (required): Timesheet project to Basecamp project (bucket).
- **User mapping** (optional): Timesheet user to Basecamp person. Only teams need it. The
  candidates are the non-client people on the mapped projects, because a Basecamp timesheet
  entry's person must be a member of the project it is filed under.

## Triggers

- **Todo Changed** (event): syncs todo create, update, and delete events to Basecamp to-dos.
- **Time Entry Changed** (event): logs Timesheet time entries as Basecamp timesheet entries.
- **Basecamp Webhook** (webhook): receives inbound to-do changes from Basecamp.
- **Scheduled Full Sync** (daily at 02:00 UTC): drains the outbound change stream. On an
  organization install the runtime fans this out to one run per member.
- **Scheduled Inbound Sync** (every 6 hours): pulls Basecamp changes into Timesheet and
  re-asserts the per-project webhooks.
- **Manual Sync** (user action): runs the same inbound sync from the integration settings page.
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
the scheduled inbound sync replaces inactive hooks on each run. Client-role Basecamp users get
`403 Forbidden` on webhook endpoints; those installations fall back to scheduled sync only.

**No webhook type exists for timesheet entries.** Inbound time changes are picked up by the
scheduled inbound sync reading `GET /projects/{id}/timesheet.json`, not in real time. That
trigger exists because the outbound `full-sync` trigger runs in sync mode, once per member
on an organization install, and inbound reconciliation must run once per installation.
`pushTimeEntries` does not gate this: it says whether to write time *into* Basecamp, while
reading Basecamp's own time back is governed by `syncDirection` like every other inbound path.

**Removals are read, never inferred.** `/projects/recordings.json` lists active records
only, so a to-do trashed or archived while the webhook was inactive would never reach
Timesheet. The inbound sync therefore also reads the `trashed` and `archived` feeds and
deletes the mapped local todos, rather than treating an absence from the active feed as a
deletion. Timesheet entries have no equivalent: Basecamp exposes no removed-entries feed, so
an entry deleted in Basecamp leaves its Timesheet task in place.

**One entity never fails the run.** Inbound loops isolate each to-do and each entry: a record
the acting user may not write is logged, counted in `details.failures`, and the run reports
`partial` with its watermark advanced. Without that, a single un-permissioned project would
abort every inbound run at the same record forever.

**Attribution on team installs.** Without the user mapping every write lands under the
connected Basecamp account, which is right for one person and wrong for a team. With it:

- Outbound entries carry `person_id`, so each member's time shows up under their own
  Basecamp person. A member with no mapping still syncs, under the connected account, with a
  warning. Basecamp requires the person to be a non-client member of the project, and the
  connected account may not be allowed to log time for others at all, so a `403`/`422` on
  the attributed write is retried once without `person_id`: losing the attribution beats
  losing the entry.
- Inbound entries are created for the mapped member through `TaskCreateInput.userId`. Once
  the installation maps anyone, entries from unmapped Basecamp people are skipped rather
  than booked on whoever the inbound sync runs as. Attribution is create-only, since
  `TaskUpdateInput` carries no `userId`, so an entry imported before its person was mapped
  keeps the owner it was created with.
- To-do assignees sync both ways. Basecamp people with no Timesheet counterpart stay
  assigned: a to-do `PUT` drops everyone it does not name, so the plugin re-sends them.
  Local assignment is only ever set from at least one mapped assignee, never cleared from a
  half-mapped Basecamp side.

Inbound writes run as the installing admin (webhooks and the inbound schedule are background
triggers), so that account needs project-manager or admin rights on the mapped projects.
Outbound runs as the member whose change stream is being drained.

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
