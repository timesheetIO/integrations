import { defineHandler, ExternalEntity } from '@timesheet/integration-sdk';

const SYSTEM = 'outlook-calendar';

export const listExternalProjects = defineHandler<void, ExternalEntity[]>(async (_input, context) => {
  context.logger.info('Listing external projects', {
    system: SYSTEM,
    installationId: context.installationId
  });

  return [
    { id: 'outlook-calendar-project-1', name: 'Outlook Calendar Sync Project 1' },
    { id: 'outlook-calendar-project-2', name: 'Outlook Calendar Sync Project 2' }
  ];
});
