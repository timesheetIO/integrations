# FreshBooks Sync

> Synchronize Timesheet tasks with FreshBooks time entries.

Bidirectional synchronization between Timesheet tasks and FreshBooks `time_entries`. Timesheet projects map to FreshBooks projects and Timesheet users map to FreshBooks team members, so logged time lands on the right project and teammate in FreshBooks for billing.

- Package: `@timesheet/plugin-freshbooks`
- Manifest id: `freshbooks-sync`
- Category: accounting

## Authentication

OAuth 2.0 against FreshBooks. The access token is not scoped to a single business, so the plugin resolves the target business from `GET /auth/api/v1/users/me`:

- `business.id` keys the Time Tracking, Projects, Services and Team Members endpoints.
- `business.account_id` keys the Events (webhook callback) endpoints.

When the connected identity belongs to more than one business, set the `businessId` config option to pick one; otherwise the first membership is used.

Requested scopes: `user:profile:read`, `user:time_entries:read`, `user:time_entries:write`, `user:projects:read`, `user:clients:read`, `user:billable_items:read`, `user:teams:read`.

## Configuration

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `syncDirection` | yes | `bidirectional` | One of `bidirectional`, `timesheet-to-freshbooks`, `freshbooks-to-timesheet`. |
| `businessId` | no | (first) | FreshBooks `business.id` to sync when the account has multiple businesses. |

## Mappings

- **Project mapping** (required): Timesheet project to FreshBooks project. The FreshBooks project supplies the client the time entry is billed to.
- **User mapping** (required): Timesheet user to FreshBooks team member (`identity_id`).
- **Rate mapping** (optional): Timesheet rate to FreshBooks service (`service_id`).

## Triggers

- **Task Changed** (event): pushes Timesheet task create, update, and delete events to FreshBooks.
- **FreshBooks Webhook** (webhook): receives inbound `time_entry` changes.
- **Scheduled Full Sync** (daily at 02:00 UTC): reconciles task changes to FreshBooks.
- **Manual Sync** (user action): pulls FreshBooks time entries updated since the last run.
- **Register Webhooks** (user action): registers the FreshBooks callback for real-time inbound sync.

### Webhook

FreshBooks callbacks are registered per account. **Register Webhooks** creates a single `time_entry` callback pointing at the plugin's webhook endpoint. FreshBooks then delivers a verification `verifier` to that endpoint; the handler stores it (it becomes the HMAC secret) and confirms the callback. Subsequent deliveries are authenticated with the `X-FreshBooks-Hmac-SHA256` signature over the raw body. The Scheduled Full Sync and Manual Sync remain the reliable inbound path if callbacks are not registered.

### Echo suppression

FreshBooks time entries expose no `updated_at`, only a `created_at` and an `updated_since` list filter. Outbound echoes are skipped with the SDK's `isAlreadySyncedLocalChange` guard; inbound echoes are detected by comparing the incoming entry's content to the local task (`taskDiffersFromDesired`) and re-stamping `timesheetUpdatedAt` after each inbound write.

## Development

```bash
npm install        # or: npm ci
npm run build      # compile TypeScript into dist/
npm run typecheck
```

The package ships `dist/` and `manifest.json`; the sandboxed plugin runtime loads it by package name, version, and integrity (`sha512-...`). Shared tests live in `integrations/tests/` and run from the `integrations/` root with `npm test`.
