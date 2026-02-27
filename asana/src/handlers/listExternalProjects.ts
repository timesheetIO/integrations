import { defineHandler, ExternalEntity } from '@timesheet/integration-sdk';

const SYSTEM = 'asana';

export const listExternalProjects = defineHandler<void, ExternalEntity[]>(async (_input, context) => {
  context.logger.info('Listing external projects', {
    system: SYSTEM,
    installationId: context.installationId
  });

  return [
    { id: 'asana-project-1', name: 'Asana Sync Project 1' },
    { id: 'asana-project-2', name: 'Asana Sync Project 2' }
  ];
});
