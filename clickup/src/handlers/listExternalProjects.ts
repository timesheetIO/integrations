import { defineHandler, ExternalEntity } from '@timesheet/integration-sdk';

const SYSTEM = 'clickup';

export const listExternalProjects = defineHandler<void, ExternalEntity[]>(async (_input, context) => {
  context.logger.info('Listing external projects', {
    system: SYSTEM,
    installationId: context.installationId
  });

  return [
    { id: 'clickup-project-1', name: 'ClickUp Sync Project 1' },
    { id: 'clickup-project-2', name: 'ClickUp Sync Project 2' }
  ];
});
