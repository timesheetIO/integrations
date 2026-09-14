module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/jest.setup.js'],
  // Every plugin resolves the workspace SDK, not a stale per-plugin node_modules copy.
  moduleNameMapper: { '^@timesheet/integration-sdk$': '<rootDir>/../packages/integrations-sdk' },
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts']
};
