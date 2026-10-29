export { syncTaskToExternal } from './handlers/syncTaskToExternal';
export { syncTaskFromExternal } from './handlers/syncTaskFromExternal';
export { handleSyncBatch } from './handlers/handleSyncBatch';
export { handleWebhook } from './handlers/handleWebhook';
export { runFullSync } from './handlers/runFullSync';
export { renewSubscriptions } from './handlers/renewSubscriptions';
export { testConnection } from './handlers/testConnection';
export { listExternalProjects } from './handlers/listExternalProjects';

export const PLUGIN_SYSTEM = 'outlook-calendar';
export const PLUGIN_NAME = 'Outlook Calendar Sync';
