// Tests run from COMPILED dist-test/ (tsc -p tsconfig.test.json → jest → node),
// same as the other TypeORM scripts in this project (migrate/seed/report).
//
// Without `reporters` below, Jest 30 picks a reporter on its own based on env
// vars (detectAgent() in @jest/core) and in some environments switches to the
// compact 'agent' reporter, which hides PASS lines, describe/it names and ✓.
// Explicit 'default' keeps output identical everywhere — same reasoning as
// lesson-10's jest.config.js.
export default {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/dist-test/test/**/*.test.js'],
  transform: {},
  reporters: ['default'],
  testTimeout: 120000,
  // Every jest worker multiplies testcontainers. Bump only when you've
  // measured that parallel is actually faster for this suite.
  maxWorkers: 1,
  verbose: true,
};
