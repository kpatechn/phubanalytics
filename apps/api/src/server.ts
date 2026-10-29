import { LambdaClient } from '@aws-sdk/client-lambda';
import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { createRemoteJWKSet } from 'jose';
import { buildApp } from './app.js';
import { devAuthenticator, jwtAuthenticator } from './auth.js';
import { createCdpRepo } from './cdp.js';
import { loadConfig } from './config.js';
import { createSql } from './db.js';
import { createServingRepo } from './reinvestment.js';
import { createRepo } from './repo.js';

const config = loadConfig();
const sql = createSql(config);
// The Chickasaw CDP lives in another database (GEM); its own read-only pool.
const gemSql = config.GEM_DATABASE_URL ? createSql({ DATABASE_URL: config.GEM_DATABASE_URL, DATABASE_SSL: config.GEM_DATABASE_SSL }) : null;

// Reinvestment screens read the data platform's serving database and may run the optimizer.
const reinvestment =
  config.SERVING_CLUSTER_ARN && config.SERVING_SECRET_ARN
    ? createServingRepo({
        rds: new RDSDataClient({ region: config.AWS_REGION }),
        // A plan takes up to a few minutes; the Lambda's own limit is 10.
        lambda: new LambdaClient({ region: config.AWS_REGION, requestHandler: { requestTimeout: 660_000 } }),
        clusterArn: config.SERVING_CLUSTER_ARN,
        secretArn: config.SERVING_SECRET_ARN,
        database: config.SERVING_DATABASE,
        tenant: config.REINVESTMENT_TENANT,
        optimizerFunction: config.OPTIMIZER_FUNCTION,
      })
    : undefined;

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
  cdp: gemSql ? createCdpRepo(gemSql, config.CDP_CLIENT_NAME) : undefined,
  reinvestment,
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
  await Promise.all([sql.end({ timeout: 5 }), gemSql?.end({ timeout: 5 })]);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: config.HOST });
