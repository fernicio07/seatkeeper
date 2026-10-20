/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  // Resolve the shared package straight from TS source — no build step in dev/test.
  moduleNameMapper: { '^@seatkeeper/shared$': '<rootDir>/../../packages/shared/src/index.ts' },
};
