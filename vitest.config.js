import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.js'],
    // The JSON report is evidence for rubric A4, so every run writes it.
    reporters: ['default', ['json', { outputFile: 'artifacts/logs/unit-tests.json' }]],
    coverage: { provider: 'v8', include: ['src/**/*.js'] },
  },
});
