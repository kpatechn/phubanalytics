import { z } from 'zod';

const EnvSchema = z
  .object({
    DATABASE_URL: z.url(),
    DATABASE_SSL: z.enum(['require', 'disable']).default('require'),
    APP_ENVIRONMENT: z.enum(['prod', 'staging', 'dev']),
    AUTH_MODE: z.enum(['jwt', 'dev']).default('jwt'),
    JWT_JWKS_URL: z.url().optional(),
    JWT_ISSUER: z.string().min(1).optional(),
    JWT_AUDIENCE: z.string().min(1).optional(),
    JWT_ROLES_CLAIM: z.string().min(1).default('roles'),
    ALLOWED_ORIGIN: z.url().optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().min(1).default('127.0.0.1'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_MODE === 'dev' && env.APP_ENVIRONMENT !== 'dev') {
      ctx.addIssue({ code: 'custom', path: ['AUTH_MODE'], message: 'AUTH_MODE=dev is only allowed when APP_ENVIRONMENT=dev' });
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
