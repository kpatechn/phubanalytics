import { createRemoteJWKSet } from 'jose';
import { buildApp } from './app.js';
import { devAuthenticator, jwtAuthenticator } from './auth.js';
import { loadConfig } from './config.js';
import { createSql } from './db.js';
import { createRepo } from './repo.js';

const config = loadConfig();
const sql = createSql(config);

const authenticate =
  config.AUTH_MODE === 'dev'
    ? devAuthenticator()
    : jwtAuthenticator({
        keys: createRemoteJWKSet(new URL(config.JWT_JWKS_URL!)),
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
        rolesClaim: config.JWT_ROLES_CLAIM,
      });

const app = await buildApp({
  config,
  repo: createRepo(sql),
  authenticate,
  logger: {
    level: config.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  },
});

if (config.AUTH_MODE === 'dev') {
  app.log.warn('AUTH_MODE=dev: every request is treated as analytics:admin');
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: config.HOST });
