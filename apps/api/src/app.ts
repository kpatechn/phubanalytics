import cors from '@fastify/cors';
import etag from '@fastify/etag';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import type { CdpEnvelope, CdpMeta, Envelope, Me, Problem, Property, RxMeta, View } from '@phub/contracts';
import { canView, viewsFor, type Authenticator, type Principal } from './auth.js';
import { TtlCache } from './cache.js';
import type { CdpRepo } from './cdp.js';
import { PlanRefused, type RxRepo } from './reinvestment.js';
import type { Config } from './config.js';
import { DateRangeError, isIsoDate, resolveRange, todayIn } from './dates.js';
import type { AnalyticsRepo, Scope } from './repo.js';
import { unavailable } from './unavailable.js';

export interface AppDeps {
  config: Pick<Config, 'AUTH_MODE' | 'ALLOWED_ORIGIN'>;
  /** Analytics rollups. Absent: the executive, engagement, marketing and IT views are hidden and answer 404. */
  repo?: AnalyticsRepo | undefined;
  /** Chickasaw CDP (GEM database). Absent: the cdp view is hidden and its endpoints answer 404. */
  cdp?: CdpRepo | undefined;
  /** Reinvestment screens (serving database, optimizer). Absent: the view is hidden and its endpoints answer 404. */
  reinvestment?: RxRepo | undefined;
  authenticate: Authenticator;
  /** Built web app served from the same origin, with index.html for client-side routes. */
  webRoot?: string | undefined;
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

const CampaignParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'must be a campaign ID') });
const RunParams = z.object({ id: z.string().regex(/^opt__\d{8}T\d{6}$/, 'must be an optimizer run ID') });
const PatronBody = z.object({ patronId: z.uuid('must be a patron ID') });
const SiteAmounts = z.record(z.string().regex(/^[A-Za-z0-9]{1,8}:[A-Za-z0-9]{1,8}$/), z.number().min(0).max(50_000_000));
const PlanBody = z.object({
  budget: z.number().positive().max(50_000_000),
  holdout: z.number().min(0).max(0.5).optional(),
  risk: z.enum(['conservative', 'expected']).optional(),
  caps: SiteAmounts.optional(),
  floors: SiteAmounts.optional(),
  maxOffers: z.number().int().positive().max(5_000_000).nullable().optional(),
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
  // Serving tables refresh hourly (reverse ETL); runs and patrons are never cached.
  const rxResponses = new TtlCache<unknown>(5 * 60_000, 50);
  const configured = (v: View): boolean =>
    v === 'cdp' ? deps.cdp !== undefined : v === 'reinvestment' ? deps.reinvestment !== undefined : deps.repo !== undefined;
  const visibleViews = (principal: Principal): View[] => viewsFor(principal).filter(configured);

  app.decorateRequest('principal', null);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ProblemError) return sendProblem(reply, error.problem);
    const down = unavailable(error, request.url.split('?')[0] ?? '');
    if (down) {
      request.log.warn({ err: error }, 'data source unavailable');
      if (down.retryAfter) reply.header('retry-after', String(down.retryAfter));
      return sendProblem(reply, down.problem);
    }
    request.log.error({ err: error }, 'request failed');
    return sendProblem(reply, { type: 'about:blank', title: 'Internal Server Error', status: 500 });
  });
  // Everything the server sends: no sniffing, no framing, no referrer leaving the site.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
  });

  if (deps.webRoot) {
    await app.register(fastifyStatic, {
      root: deps.webRoot,
      wildcard: false,
      // Our own cache headers: Angular's file names carry a content hash; index.html is always revalidated.
      cacheControl: false,
      setHeaders: (res, path) =>
        res.setHeader('cache-control', path.endsWith('.html') ? 'no-cache' : /-[A-Z0-9]{8}\.(js|css)$/.test(path) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'),
    });
  }
  const webRoot = deps.webRoot;
  app.setNotFoundHandler((request, reply) => {
    // Client-side routes (/reinvestment/offers) get the app; unknown API paths get a problem.
    const path = request.url.split('?')[0] ?? '';
    if (webRoot && (request.method === 'GET' || request.method === 'HEAD') && !path.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(path)) {
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return sendProblem(reply, { type: 'about:blank', title: 'Not Found', status: 404 });
  });

  async function requirePrincipal(request: FastifyRequest): Promise<Principal> {
    request.principal ??= await deps.authenticate(request.headers);
    if (!request.principal) throw problem(401, 'Unauthorized', 'A valid bearer token is required.');
    return request.principal;
  }

  async function requireAnyView(request: FastifyRequest): Promise<Principal> {
    const principal = await requirePrincipal(request);
    if (visibleViews(principal).length === 0) throw problem(403, 'Forbidden', 'No analytics role.');
    return principal;
  }

  function requireRepo(): AnalyticsRepo {
    if (!deps.repo) throw problem(404, 'Not Found', 'The analytics database is not configured on this server.');
    return deps.repo;
  }

  /** The CDP repo, after checking it is configured and the caller may see it. */
  async function requireCdp(request: FastifyRequest): Promise<CdpRepo> {
    const principal = await requirePrincipal(request);
    if (!deps.cdp) throw problem(404, 'Not Found', 'The CDP is not configured on this server.');
    if (!canView(principal, 'cdp')) throw problem(403, 'Forbidden', 'The CDP needs the analytics:cdp role.');
    return deps.cdp;
  }

  /** The reinvestment repo, after checking it is configured and the caller may see it. */
  async function requireRx(request: FastifyRequest): Promise<{ rx: RxRepo; principal: Principal }> {
    const principal = await requirePrincipal(request);
    if (!deps.reinvestment) throw problem(404, 'Not Found', 'The reinvestment screens are not configured on this server.');
    if (!canView(principal, 'reinvestment')) throw problem(403, 'Forbidden', 'Reinvestment needs the analytics:marketing role.');
    return { rx: deps.reinvestment, principal };
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

  async function resolveProperty(repo: AnalyticsRepo, id: number | undefined): Promise<Property> {
    const properties = await propertyList.getOrSet('all', () => repo.properties());
    const property = id === undefined ? properties[0] : properties.find((p) => p.propertyId === id);
    if (!property) throw problem(404, 'Not Found', id === undefined ? 'No properties are configured.' : `Unknown property ${id}.`);
    return property;
  }

  // Health ---------------------------------------------------------------------

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    const repo = deps.repo;
    // Without the rollups there is nothing here that can go stale.
    if (!repo) return { status: 'ready', properties: [] };
    try {
      await repo.ping();
      const properties = await repo.properties();
      const checks = await Promise.all(
        properties.map(async (p) => {
          const f = await repo.freshness(p);
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
    const repo = requireRepo();
    reply.header('cache-control', 'private, max-age=60');
    return propertyList.getOrSet('all', () => repo.properties());
  });

  for (const view of VIEWS) {
    app.get(`/api/analytics/${view}`, async (request, reply) => {
      const principal = await requirePrincipal(request);
      const repo = requireRepo();
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
      const property = await resolveProperty(repo, parsed.data.property);
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
            ? repo.executive(scope, { ...scope, from: range.previousFrom, to: range.previousTo })
            : view === 'engagement'
              ? repo.engagement(scope, { ...scope, from: range.previousFrom, to: range.previousTo }, todayIn(property.timeZone, now()))
              : view === 'marketing'
                ? repo.marketing(scope)
                : repo.it(scope),
          repo.freshness(property),
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

  // Reinvestment -----------------------------------------------------------------

  const rxMeta = (rx: RxRepo): Promise<RxMeta> => rxResponses.getOrSet('meta', () => rx.meta()) as Promise<RxMeta>;

  app.get('/api/reinvestment/overview', async (request, reply) => {
    const { rx } = await requireRx(request);
    const [meta, data] = await Promise.all([rxMeta(rx), rxResponses.getOrSet('overview', () => rx.overview())]);
    reply.header('cache-control', 'private, max-age=300');
    return { meta, data };
  });

  app.get('/api/reinvestment/campaigns/:id', async (request, reply) => {
    const { rx } = await requireRx(request);
    const parsed = CampaignParams.safeParse(request.params);
    if (!parsed.success) throw invalid(parsed.error.issues);
    const [meta, data] = await Promise.all([rxMeta(rx), rxResponses.getOrSet(`campaign:${parsed.data.id}`, () => rx.campaign(parsed.data.id))]);
    if (!data) throw problem(404, 'Not Found', `Unknown campaign ${parsed.data.id}.`);
    reply.header('cache-control', 'private, max-age=300');
    return { meta, data };
  });

  // Patron IDs are pseudonymous but still about a person: bodies only, never URLs, never cached.
  app.get('/api/reinvestment/patrons/examples', async (request, reply) => {
    const { rx } = await requireRx(request);
    const [meta, data] = await Promise.all([rxMeta(rx), rx.patronExamples()]);
    reply.header('cache-control', 'private, no-store');
    return { meta, data };
  });

  app.post('/api/reinvestment/patrons/lookup', async (request, reply) => {
    const { rx } = await requireRx(request);
    const parsed = PatronBody.safeParse(request.body);
    if (!parsed.success) throw invalid(parsed.error.issues);
    const [meta, data] = await Promise.all([rxMeta(rx), rx.patron(parsed.data.patronId)]);
    reply.header('cache-control', 'private, no-store');
    if (!data) throw problem(404, 'Not Found', 'No patron with that ID.');
    return { meta, data };
  });

  app.get('/api/reinvestment/optimizer/runs', async (request, reply) => {
    const { rx } = await requireRx(request);
    const [meta, data] = await Promise.all([rxMeta(rx), rx.runs()]);
    reply.header('cache-control', 'private, no-store');
    return { meta, data };
  });

  app.get('/api/reinvestment/optimizer/runs/:id', async (request, reply) => {
    const { rx } = await requireRx(request);
    const parsed = RunParams.safeParse(request.params);
    if (!parsed.success) throw invalid(parsed.error.issues);
    const [meta, data] = await Promise.all([rxMeta(rx), rx.run(parsed.data.id)]);
    if (!data) throw problem(404, 'Not Found', `Unknown run ${parsed.data.id} (a new run reaches this list within a minute).`);
    reply.header('cache-control', 'private, no-store');
    return { meta, data };
  });

  // Plans a period: writes the plan to the lake and returns it. Nothing is sent to anyone.
  app.post('/api/reinvestment/optimizer/runs', async (request, reply) => {
    const { rx, principal } = await requireRx(request);
    const parsed = PlanBody.safeParse(request.body);
    if (!parsed.success) throw invalid(parsed.error.issues);
    const meta = await rxMeta(rx);
    if (!meta.optimizerEnabled) throw problem(404, 'Not Found', 'The optimizer is not configured on this server.');
    try {
      const data = await rx.plan(parsed.data, principal.subject);
      reply.header('cache-control', 'private, no-store');
      return { meta, data };
    } catch (e) {
      if (e instanceof PlanRefused) throw problem(400, 'Bad Request', e.message);
      throw e;
    }
  });

  return app;
}
