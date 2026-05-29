/** @type {import('jest').Config} */
module.exports = {
  preset:              'ts-jest',
  testEnvironment:     'node',
  roots:               ['<rootDir>/tests'],
  testMatch:           ['**/*.test.ts'],
  moduleNameMapper: {
    '^@tracegraph/shared-types$':  '<rootDir>/../shared-types/src/index.ts',
    '^@tracegraph/trace-core$':    '<rootDir>/../trace-core/src/index.ts',
  },
};
