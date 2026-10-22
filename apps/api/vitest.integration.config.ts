import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Uses DATABASE_URL from apps/api/.env when present.
if (!process.env['DATABASE_URL'] && existsSync('.env')) loadEnvFile('.env');

export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    testTimeout: 30_000,
  },
});
