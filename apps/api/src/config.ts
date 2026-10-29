import { z } from 'zod';

const EnvSchema = z
  .object({
    // Analytics rollups (Graton dev dexl). Optional: without it the executive, engagement,
    // marketing and IT views are hidden and their endpoints answer 404.
    DATABASE_URL: z.url().optional(),
    DATABASE_SSL: z.enum(['require', 'disable']).default('require'),
    // Optional Chickasaw CDP database (GEM, dexiga). Without it the CDP endpoints answer 404.
    GEM_DATABASE_URL: z.url().optional(),
    GEM_DATABASE_SSL: z.enum(['require', 'disable']).default('require'),
    CDP_CLIENT_NAME: z.string().min(1).default('Chickasaw'),
    // Optional reinvestment screens: the data platform's serving database (RDS Data API) and the
    // optimizer Lambda. Credentials come from the AWS default chain. Without them the view is hidden.
    SERVING_CLUSTER_ARN: z.string().startsWith('arn:aws:rds:').optional(),
    SERVING_SECRET_ARN: z.string().startsWith('arn:aws:secretsmanager:').optional(),
    SERVING_DATABASE: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).default('serving'),
    REINVESTMENT_TENANT: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/).default('chickasaw_sim'),
    OPTIMIZER_FUNCTION: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    AWS_REGION: z.string().min(1).default('us-west-2'),
    APP_ENVIRONMENT: z.enum(['prod', 'staging', 'dev']),
    AUTH_MODE: z.enum(['jwt', 'dev']).default('jwt'),
    JWT_JWKS_URL: z.url().optional(),
    JWT_ISSUER: z.string().min(1).optional(),
    JWT_AUDIENCE: z.string().min(1).optional(),
    JWT_ROLES_CLAIM: z.string().min(1).default('roles'),
    // Where the token arrives: 'authorization' (Bearer), or a header a sign-in proxy sets, such as
    // the load balancer's x-amzn-oidc-accesstoken (Cognito access token).
    JWT_TOKEN_HEADER: z.string().regex(/^[a-z0-9-]{1,64}$/, 'must be a lower-case header name').default('authorization'),
    // Cognito access tokens carry client_id instead of aud: when set, it must match.
    JWT_CLIENT_ID: z.string().min(1).optional(),
    // The claim recorded as who asked (e.g. Cognito's 'username' rather than its opaque 'sub').
    JWT_SUBJECT_CLAIM: z.string().min(1).default('sub'),
    // Built web app (apps/web/dist/web/browser) to serve from the same origin; unset in development.
    WEB_ROOT: z.string().min(1).optional(),
    ALLOWED_ORIGIN: z.url().optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().min(1).default('127.0.0.1'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_MODE === 'dev' && env.APP_ENVIRONMENT !== 'dev') {
      ctx.addIssue({ code: 'custom', path: ['AUTH_MODE'], message: 'AUTH_MODE=dev is only allowed when APP_ENVIRONMENT=dev' });
    }
    if (Boolean(env.SERVING_CLUSTER_ARN) !== Boolean(env.SERVING_SECRET_ARN)) {
      ctx.addIssue({ code: 'custom', path: ['SERVING_SECRET_ARN'], message: 'SERVING_CLUSTER_ARN and SERVING_SECRET_ARN go together' });
    }
    if (env.AUTH_MODE === 'jwt' && !env.JWT_JWKS_URL) {
      ctx.addIssue({ code: 'custom', path: ['JWT_JWKS_URL'], message: 'JWT_JWKS_URL is required when AUTH_MODE=jwt' });
    }
  });

export type Config = z.infer<typeof EnvSchema>;

/** Validates the environment and exits on any problem. Never prints values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    console.error(`Invalid configuration:\n${problems}`);
    process.exit(1);
  }
  return parsed.data;
}
