/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.ts'],
  roots: ['<rootDir>/test'],
  collectCoverageFrom: ['src/**/*.ts'],
};
