import { defineHandler } from '@timesheet/integration-sdk';
import { FreshBooksConfig } from '../lib/types';
import { createFreshBooksClient } from '../lib/taskSync';

const SYSTEM = 'freshbooks';

export const testConnection = defineHandler<
  void,
  { system: string; ok: boolean; installationId: string; businessId: string },
  FreshBooksConfig
>(async (_input, context) => {
  const client = createFreshBooksClient(context);

  try {
    const business = await client.resolveBusiness();
    return {
      system: SYSTEM,
      ok: !!business?.id,
      installationId: context.installationId,
      businessId: business?.id ? String(business.id) : ''
    };
  } catch (err) {
    context.logger.warn('FreshBooks test connection failed', { error: String(err) });
    return {
      system: SYSTEM,
      ok: false,
      installationId: context.installationId,
      businessId: ''
    };
  }
});
