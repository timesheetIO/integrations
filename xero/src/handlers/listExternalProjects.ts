import { defineHandler, ExternalEntity } from '@timesheet/integration-sdk';

const SYSTEM = 'xero';

export const listExternalProjects = defineHandler<void, ExternalEntity[]>(async (_input, context) => {
  context.logger.info('Listing external projects', {
    system: SYSTEM,
    installationId: context.installationId
  });

  return [
    { id: 'xero-project-1', name: 'Xero Sync Project 1' },
    { id: 'xero-project-2', name: 'Xero Sync Project 2' }
  ];
});
