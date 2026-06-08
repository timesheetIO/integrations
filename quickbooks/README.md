# QuickBooks Time Sync

> Synchronize Timesheet tasks with QuickBooks Online TimeActivity entries.

Bidirectional synchronization between Timesheet tasks and QuickBooks Online `TimeActivity` entries. Timesheet projects map to QuickBooks customers and Timesheet users map to QuickBooks employees, so logged time lands on the right customer and employee in QuickBooks.

- Package: `@timesheet/plugin-quickbooks`
- Manifest id: `quickbooks-sync`
- Category: accounting

## Authentication

OAuth 2.0 against Intuit, scope `com.intuit.quickbooks.accounting`. Each connected company is identified by its QuickBooks `realmId`, captured during the OAuth callback.

The QuickBooks API host (production vs sandbox) is not a per-integration option. It follows the plugin-runtime deployment environment: the plugin reads `context.environment` and uses the sandbox host (`sandbox-quickbooks.api.intuit.com`) when it is `sandbox`, otherwise the production host. Set `PLUGIN_ENVIRONMENT=sandbox` on the non-production runtime.

## Configuration

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `syncDirection` | yes | `bidirectional` | One of `bidirectional`, `timesheet-to-qb`, `qb-to-timesheet`. |

## Mappings

- **Project mapping**: Timesheet project to QuickBooks customer.
- **User mapping**: Timesheet user to QuickBooks employee.

## Triggers

- **Task Changed** (event): pushes Timesheet task create, update, and delete events to QuickBooks.
- **QuickBooks Webhook** (webhook): receives inbound `TimeActivity` changes from QuickBooks.
- **Scheduled Full Sync** (daily at 02:00 UTC): runs a complete reconciliation sync.
- **Manual Sync** (user action): runs a full sync from the integration settings page.

### Webhook

QuickBooks allows only one app-wide webhook URL, so this plugin uses an app-level endpoint registered under Webhooks in the Intuit developer dashboard. The backend verifies the Intuit signature against the app verifier token, extracts the account id from the payload, and routes each event to the installation that owns that company. The verifier token is configured as a server-side secret, not per user.

## Development

```bash
npm install        # or: npm ci
npm run build      # compile TypeScript into dist/
npm run typecheck
```

The package ships `dist/` and `manifest.json`; the sandboxed plugin runtime loads it by package name, version, and integrity (`sha512-...`). Shared tests live in `integrations/tests/` and run from the `integrations/` root with `npm test`.
