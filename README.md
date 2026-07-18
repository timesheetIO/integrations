# Timesheet Plugin Integrations

This folder contains first-party plugin packages for the sandboxed plugin runtime migration.

## Packages

| Plugin | Package | Category | Description |
| --- | --- | --- | --- |
| [Asana](asana/README.md) | `@timesheet/plugin-asana` | project-management | Sync todos and time entries with Asana. |
| [ClickUp](clickup/README.md) | `@timesheet/plugin-clickup` | project-management | Sync tasks and todos with ClickUp. |
| [FreshBooks](freshbooks/README.md) | `@timesheet/plugin-freshbooks` | accounting | Sync tasks with FreshBooks time entries. |
| [Google Calendar](google-calendar/README.md) | `@timesheet/plugin-google-calendar` | calendar | Sync tasks with Google Calendar events. |
| [Google Health](google-health/README.md) | `@timesheet/plugin-google-health` | wellness | Import Google Health workouts as time entries (read-only). |
| [monday.com](monday/README.md) | `@timesheet/plugin-monday` | project-management | Sync tasks and todos with monday.com. |
| [Notion](notion/README.md) | `@timesheet/plugin-notion` | project-management | Sync todos and time entries with Notion databases. |
| [Outlook Calendar](outlook-calendar/README.md) | `@timesheet/plugin-outlook-calendar` | calendar | Sync with Outlook calendar (scaffold, not yet functional). |
| [QuickBooks](quickbooks/README.md) | `@timesheet/plugin-quickbooks` | accounting | Sync tasks with QuickBooks Online TimeActivity. |
| [Xero](xero/README.md) | `@timesheet/plugin-xero` | accounting | Sync with Xero (scaffold, not yet functional). |

Each plugin folder has a `README.md` with its authentication, configuration, mappings, and triggers.

## Validation

A shared test suite in `integrations/tests/plugins.test.ts` verifies:

- Manifest structure and required sections
- Manifest action handler names match real exported handlers
- Baseline behavior for key actions (`testConnection`, `runFullSync`)
