/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  testMatch: ['**/test/integration/**/*.test.ts'],
  roots: ['<rootDir>/test/integration'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: ['src/**/*.ts'],
  // Containers can take time to start; allow generous timeout per test
  testTimeout: 60000,
  // One worker avoids parallel GenericContainer starts against Docker on CI
  maxWorkers: 1,
  forceExit: true,
};
