/** @type {import('jest').Config} */
export default {
  displayName: 'rn-playground-net',
  testEnvironment: 'node',
  transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  testMatch: ['**/*.spec.ts'],
};
