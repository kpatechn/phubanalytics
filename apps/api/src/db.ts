import postgres from 'postgres';
import type { Config } from './config.js';

/**
 * Read-only pool. Every session starts read-only with a 10 s statement
 * timeout, whatever role DATABASE_URL uses.
 */
export function createSql(config: Pick<Config, 'DATABASE_URL' | 'DATABASE_SSL'>) {
  return postgres(config.DATABASE_URL, {
    ssl: config.DATABASE_SSL === 'require' ? 'require' : false,
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    connection: {
      application_name: 'phub-analytics-api',
      default_transaction_read_only: true,
      statement_timeout: 10_000,
    },
    types: {
      // count(*) is int8 and sum(bigint) is numeric; both arrive as strings.
      // Every such value here is a count or an average, so a JS number is exact enough.
      count: {
        to: 20,
        from: [20, 1700],
        serialize: (value: number) => String(value),
        parse: (value: string) => Number(value),
      },
    },
  });
}

export type Sql = ReturnType<typeof createSql>;
