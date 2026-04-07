export { syncTaskToExternal } from './handlers/syncTaskToExternal';
export { syncTaskFromExternal } from './handlers/syncTaskFromExternal';
export { handleSyncBatch } from './handlers/handleSyncBatch';
export { handleWebhook } from './handlers/handleWebhook';
export { runFullSync } from './handlers/runFullSync';
export { testConnection } from './handlers/testConnection';
export { listExternalProjects } from './handlers/listExternalProjects';

export const PLUGIN_SYSTEM = 'google-calendar';
export const PLUGIN_NAME = 'Google Calendar Sync';
