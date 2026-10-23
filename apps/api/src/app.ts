import cors from '@fastify/cors';
import etag from '@fastify/etag';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import type { CdpEnvelope, CdpMeta, Envelope, Me, Problem, Property, View } from '@phub/contracts';
import { canView, viewsFor, type Authenticator, type Principal } from './auth.js';
import { TtlCache } from './cache.js';
import type { CdpRepo } from './cdp.js';
import type { Config } from './config.js';
import { DateRangeError, isIsoDate, resolveRange, todayIn } from './dates.js';
import type { AnalyticsRepo, Scope } from './repo.js';

export interface AppDeps {
  config: Pick<Config, 'AUTH_MODE' | 'ALLOWED_ORIGIN'>;
  repo: AnalyticsRepo;
  /** Chickasaw CDP (GEM database). Absent: the cdp view is hidden and its endpoints answer 404. */
  cdp?: CdpRepo | undefined;
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

const SegmentQuery = z.object({
  segment: z.string().regex(/^[a-z0-9_]{1,40}$/, 'must be a segment code'),
});

const LookupBody = z.object({
  accountNumber: z.string().trim().regex(/^\d{1,12}$/, 'must be a Club Passport number (digits only)'),
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
    await app.register(cors, { origin: deps.config.ALLOWED_ORIGIN, credentials: true, methods: ['GET', 'POST'] });
  }

  const responses = new TtlCache<Envelope<unknown>>(60_000);
  const propertyList = new TtlCache<Property[]>(60_000, 1);
  // CDP tables change only when cdp.refresh() runs, so aggregates keep for 5 minutes.
  // Player lookups are never cached.
  const cdpResponses = new TtlCache<unknown>(5 * 60_000, 50);
  const visibleViews = (principal: Principal): View[] => viewsFor(principal).filter((v) => v !== 'cdp' || deps.cdp !== undefined);

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
    if (visibleViews(principal).length === 0) throw problem(403, 'Forbidden', 'No analytics role.');
    return principal;
  }

  /** The CDP repo, after checking it is configured and the caller may see it. */
  async function requireCdp(request: FastifyRequest): Promise<CdpRepo> {
    const principal = await requirePrincipal(request);
    if (!deps.cdp) throw problem(404, 'Not Found', 'The CDP is not configured on this server.');
    if (!canView(principal, 'cdp')) throw problem(403, 'Forbidden', 'The CDP needs the analytics:cdp role.');
    return deps.cdp;
  }

  async function cdpMeta(cdp: CdpRepo): Promise<CdpMeta> {
    const base = await cdpResponses.getOrSet('meta', async () => {
      const meta = await cdp.meta();
      if (!meta) throw problem(503, 'Service Unavailable', 'The CDP has not been built yet (run scripts/build-cdp.sh).');
      return meta;
    });
    return { ...(base as Omit<CdpMeta, 'generatedAt'>), generatedAt: now().toISOString() };
  }

  function invalid(issues: readonly { path: PropertyKey[]; message: string }[]): ProblemError {
    return problem(400, 'Bad Request', 'Invalid request.', issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
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
    const me: Me = { subject: principal.subject, roles: principal.roles, views: visibleViews(principal), authMode: deps.config.AUTH_MODE };
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
            dextransAsOf: freshness.dextransRefreshedAt?.toISOString() ?? null,
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

  // Chickasaw CDP ----------------------------------------------------------------

  app.get('/api/cdp/meta', async (request, reply) => {
    const cdp = await requireCdp(request);
    reply.header('cache-control', 'private, max-age=300');
    return cdpMeta(cdp);
  });

  app.get('/api/cdp/segments', async (request, reply) => {
    const cdp = await requireCdp(request);
    const [meta, data] = await Promise.all([cdpMeta(cdp), cdpResponses.getOrSet('segments', () => cdp.segments())]);
    reply.header('cache-control', 'private, max-age=300');
    return { meta, data } as CdpEnvelope<unknown>;
  });

  app.get('/api/cdp/sites', async (request, reply) => {
    const cdp = await requireCdp(request);
    const [meta, data] = await Promise.all([cdpMeta(cdp), cdpResponses.getOrSet('sites', () => cdp.sites())]);
    reply.header('cache-control', 'private, max-age=300');
    return { meta, data } as CdpEnvelope<unknown>;
  });

  // Account numbers are personal data: they come back in bodies only, never in URLs, and
  // nothing that carries them is cached.
  app.get('/api/cdp/players/examples', async (request, reply) => {
    const cdp = await requireCdp(request);
    const parsed = SegmentQuery.safeParse(request.query);
    if (!parsed.success) throw invalid(parsed.error.issues);
    const [meta, data] = await Promise.all([cdpMeta(cdp), cdp.examples(parsed.data.segment)]);
    if (!data) throw problem(404, 'Not Found', `Unknown segment ${parsed.data.segment}.`);
    reply.header('cache-control', 'private, no-store');
    return { meta, data } as CdpEnvelope<unknown>;
  });

  app.post('/api/cdp/players/lookup', async (request, reply) => {
    const cdp = await requireCdp(request);
    const parsed = LookupBody.safeParse(request.body);
    if (!parsed.success) throw invalid(parsed.error.issues);
    const [meta, data] = await Promise.all([cdpMeta(cdp), cdp.player(parsed.data.accountNumber)]);
    reply.header('cache-control', 'private, no-store');
    if (!data) throw problem(404, 'Not Found', 'No player with that Club Passport number.');
    return { meta, data } as CdpEnvelope<unknown>;
  });

  return app;
}
