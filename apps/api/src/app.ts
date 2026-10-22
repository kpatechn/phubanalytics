import cors from '@fastify/cors';
import etag from '@fastify/etag';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import type { Envelope, Me, Problem, Property, View } from '@phub/contracts';
import { canView, viewsFor, type Authenticator, type Principal } from './auth.js';
import { TtlCache } from './cache.js';
import type { Config } from './config.js';
import { DateRangeError, isIsoDate, resolveRange, todayIn } from './dates.js';
import type { AnalyticsRepo, Scope } from './repo.js';

export interface AppDeps {
  config: Pick<Config, 'AUTH_MODE' | 'ALLOWED_ORIGIN'>;
  repo: AnalyticsRepo;
  authenticate: Authenticator;
  now?: () => Date;
  logger?: FastifyServerOptions['logger'];
}

const VIEWS = ['executive', 'engagement', 'marketing', 'it'] as const satisfies readonly View[];

const SummaryQuery = z.object({
  from: z.string().refine(isIsoDate, 'must be a date as YYYY-MM-DD').optional(),
  to: z.string().refine(isIsoDate, 'must be a date as YYYY-MM-DD').optional(),
  property: z.coerce.number().int().positive().optional(),
});

/** Readiness fails when the rollups have not refreshed for this long. */
const MAX_REFRESH_AGE_MS = 30 * 60_000;

class ProblemError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.title);
  }
}

function problem(status: number, title: string, detail?: string, errors?: Problem['errors']): ProblemError {
  return new ProblemError({
    type: 'about:blank',
    title,
    status,
    ...(detail ? { detail } : {}),
    ...(errors ? { errors } : {}),
  });
}

function sendProblem(reply: FastifyReply, p: Problem): FastifyReply {
  return reply.code(p.status).header('content-type', 'application/problem+json; charset=utf-8').send(p);
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const now = deps.now ?? (() => new Date());
  const app = Fastify({ logger: deps.logger ?? false });

  await app.register(etag);
  if (deps.config.ALLOWED_ORIGIN) {
    await app.register(cors, { origin: deps.config.ALLOWED_ORIGIN, credentials: true, methods: ['GET'] });
  }

  const responses = new TtlCache<Envelope<unknown>>(60_000);
  const propertyList = new TtlCache<Property[]>(60_000, 1);

  app.decorateRequest('principal', null);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ProblemError) return sendProblem(reply, error.problem);
    request.log.error({ err: error }, 'request failed');
    return sendProblem(reply, { type: 'about:blank', title: 'Internal Server Error', status: 500 });
  });
  app.setNotFoundHandler((_request, reply) => sendProblem(reply, { type: 'about:blank', title: 'Not Found', status: 404 }));

  async function requirePrincipal(request: FastifyRequest): Promise<Principal> {
    request.principal ??= await deps.authenticate({ authorization: request.headers.authorization });
    if (!request.principal) throw problem(401, 'Unauthorized', 'A valid bearer token is required.');
    return request.principal;
  }

  async function requireAnyView(request: FastifyRequest): Promise<Principal> {
    const principal = await requirePrincipal(request);
    if (viewsFor(principal).length === 0) throw problem(403, 'Forbidden', 'No analytics role.');
    return principal;
  }

  async function resolveProperty(id: number | undefined): Promise<Property> {
    const properties = await propertyList.getOrSet('all', () => deps.repo.properties());
    const property = id === undefined ? properties[0] : properties.find((p) => p.propertyId === id);
    if (!property) throw problem(404, 'Not Found', id === undefined ? 'No properties are configured.' : `Unknown property ${id}.`);
    return property;
  }

  // Health ---------------------------------------------------------------------

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    try {
      await deps.repo.ping();
      const properties = await deps.repo.properties();
      const checks = await Promise.all(
        properties.map(async (p) => {
          const f = await deps.repo.freshness(p);
          const fresh = f.lastSuccessAt !== null && now().getTime() - f.lastSuccessAt.getTime() <= MAX_REFRESH_AGE_MS;
          return { propertyId: p.propertyId, fresh, lastRefreshAt: f.lastSuccessAt, queuedHours: f.queuedHours };
        }),
      );
      const ready = checks.every((c) => c.fresh);
      return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'stale', properties: checks });
    } catch (err) {
      reply.log.warn({ err }, 'readiness check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  // Analytics ------------------------------------------------------------------

  app.get('/api/analytics/me', async (request, reply) => {
    const principal = await requirePrincipal(request);
    reply.header('cache-control', 'private, no-store');
    const me: Me = { subject: principal.subject, roles: principal.roles, views: viewsFor(principal), authMode: deps.config.AUTH_MODE };
    return me;
  });

  app.get('/api/analytics/properties', async (request, reply) => {
    await requireAnyView(request);
    reply.header('cache-control', 'private, max-age=60');
    return propertyList.getOrSet('all', () => deps.repo.properties());
  });

  for (const view of VIEWS) {
    app.get(`/api/analytics/${view}`, async (request, reply) => {
      const principal = await requirePrincipal(request);
      if (!canView(principal, view)) throw problem(403, 'Forbidden', `The ${view} view needs another role.`);

      const parsed = SummaryQuery.safeParse(request.query);
      if (!parsed.success) {
        throw problem(
          400,
          'Bad Request',
          'Invalid query parameters.',
          parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        );
      }
      const property = await resolveProperty(parsed.data.property);
      let range;
      try {
        range = resolveRange(parsed.data, property.timeZone, now());
      } catch (err) {
        if (err instanceof DateRangeError) throw problem(400, 'Bad Request', err.message);
        throw err;
      }

      const key = [view, property.tenantId, property.propertyId, range.from, range.to].join('|');
      const envelope = await responses.getOrSet(key, async () => {
        const scope: Scope = { tenantId: property.tenantId, propertyId: property.propertyId, from: range.from, to: range.to };
        const [data, freshness] = await Promise.all([
          view === 'executive'
            ? deps.repo.executive(scope, { ...scope, from: range.previousFrom, to: range.previousTo })
            : view === 'engagement'
              ? deps.repo.engagement(scope, { ...scope, from: range.previousFrom, to: range.previousTo }, todayIn(property.timeZone, now()))
              : view === 'marketing'
                ? deps.repo.marketing(scope)
                : deps.repo.it(scope),
          deps.repo.freshness(property),
        ]);
        return {
          meta: {
            from: range.from,
            to: range.to,
            previousFrom: range.previousFrom,
            previousTo: range.previousTo,
            property,
            generatedAt: now().toISOString(),
            source: 'rollup',
            dataAsOf: freshness.latestEventAt?.toISOString() ?? null,
            lastRefreshAt: freshness.lastSuccessAt?.toISOString() ?? null,
          },
          data,
        } satisfies Envelope<unknown>;
      });

      // Closed ranges no longer change; today's data refreshes every few minutes.
      const closed = range.to < todayIn(property.timeZone, now());
      reply.header('cache-control', `private, max-age=${closed ? 300 : 60}`);
      return envelope;
    });
  }

  return app;
}
