# Timesheet Plugin Integrations

This folder contains first-party plugin packages for the sandboxed plugin runtime migration.

## Packages

- `@timesheet/plugin-clickup`
- `@timesheet/plugin-asana`
- `@timesheet/plugin-xero`
- `@timesheet/plugin-google-calendar`
- `@timesheet/plugin-outlook-calendar`
- `@timesheet/plugin-quickbooks`

## Validation

A shared test suite in `integrations/tests/plugins.test.ts` verifies:

- Manifest structure and required sections
- Manifest action handler names match real exported handlers
- Baseline behavior for key actions (`testConnection`, `runFullSync`)
