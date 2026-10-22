import { describe, expect, it } from 'vitest';
import type { ExecutiveData, ExecutiveKpis, ItData, MarketingData } from '@phub/contracts';
import { executiveInsights, itInsights, marketingInsights } from './insights';

const kpis = (over: Partial<ExecutiveKpis> = {}): ExecutiveKpis => ({
  sessions: 0, appOpens: 0, loginStarted: 0, loginSuccess: 0, playersLoggedIn: 0, activeGuests: 0, onsiteEvents: 0, apiErrors: 0, totalEvents: 0, ...over,
});
const exec = (over: Partial<ExecutiveData> = {}): ExecutiveData => ({ kpis: kpis(), previous: kpis(), daily: [], features: [], ...over });
const ids = (list: { id: string }[]) => list.map((i) => i.id);
const find = <T extends { id: string }>(list: T[], id: string) => list.find((i) => i.id === id);

describe('executive insights', () => {
  it('login rate: silent below 20 attempts', () => {
    expect(ids(executiveInsights(exec({ kpis: kpis({ loginStarted: 19, loginSuccess: 10 }) })))).not.toContain('login-rate');
  });
  it('login rate: good at exactly the 95% target', () => {
    expect(find(executiveInsights(exec({ kpis: kpis({ loginStarted: 20, loginSuccess: 19 }) })), 'login-rate')?.severity).toBe('good');
  });
  it('login rate: bad below target', () => {
    expect(find(executiveInsights(exec({ kpis: kpis({ loginStarted: 58, loginSuccess: 50 }) })), 'login-rate')?.severity).toBe('bad');
  });
  it('login rate: more successes than attempts is a tracking gap, not a rate over 100%', () => {
    const list = executiveInsights(exec({ kpis: kpis({ loginStarted: 108, loginSuccess: 109 }) }));
    expect(ids(list)).toEqual(['login-tracking']);
  });

  const wallet = (onsite: number, offsite: number) => exec({ features: [{ feature: 'Wallet', onsite, offsite, unknown: 0 }] });
  it('wallet off-property: silent below 30 events', () => {
    expect(ids(executiveInsights(wallet(5, 24)))).not.toContain('wallet-offsite');
  });
  it('wallet off-property: flags at exactly 60% of 30', () => {
    expect(ids(executiveInsights(wallet(12, 18)))).toContain('wallet-offsite');
  });
  it('wallet off-property: silent just below 60%', () => {
    expect(ids(executiveInsights(wallet(13, 17)))).not.toContain('wallet-offsite');
  });

  it('errors rising: flags a 25% rise with enough errors', () => {
    expect(ids(executiveInsights(exec({ kpis: kpis({ apiErrors: 25 }), previous: kpis({ apiErrors: 20 }) })))).toContain('errors-rising');
    expect(ids(executiveInsights(exec({ kpis: kpis({ apiErrors: 19 }), previous: kpis({ apiErrors: 5 }) })))).not.toContain('errors-rising');
  });
});

const it_ = (errors: ItData['errors'], biometrics = { passed: 0, failed: 0 }): ItData => ({
  errors, topMessages: [], daily: [], hourly: [], screens: [], biometrics, logins: { started: 0, succeeded: 0, authMethods: [] }, pushReceived: 0,
});
const err = (endpoint: string, statusCode: string, count: number) => ({ endpoint, method: 'POST', statusCode, errorType: 'badResponse', count });

describe('IT insights', () => {
  it('upload failures: silent below 20 errors', () => {
    expect(ids(itInsights(it_([err('account/analyticLogs', '400', 19)])))).not.toContain('upload-failures');
  });
  it('upload failures: flags at exactly 10% of 20+', () => {
    expect(ids(itInsights(it_([err('account/analyticLogs', '400', 2), err('dexy/graton/points', '500', 18)])))).toContain('upload-failures');
  });
  it('upload failures: silent below 10%', () => {
    expect(ids(itInsights(it_([err('account/analyticLogs', '400', 1), err('dexy/graton/points', '500', 19)])))).not.toContain('upload-failures');
  });

  it('fix first: names the worst 5xx endpoint at 10 or more', () => {
    const list = itInsights(it_([err('dexy/graton/points', '500', 10), err('account/analyticLogs', '500', 4), err('account/analyticLogs', '400', 50)]));
    expect(find(list, 'fix-first')?.title).toBe('Fix first: dexy/graton/points');
  });
  it('fix first: silent below 10 server errors', () => {
    expect(ids(itInsights(it_([err('dexy/graton/points', '500', 9)])))).not.toContain('fix-first');
  });

  it('biometric rate: hidden below 20 checks, shown at 20', () => {
    expect(ids(itInsights(it_([], { passed: 18, failed: 1 })))).not.toContain('biometric');
    expect(find(itInsights(it_([], { passed: 18, failed: 2 })), 'biometric')?.severity).toBe('good');
    expect(find(itInsights(it_([], { passed: 15, failed: 5 })), 'biometric')?.severity).toBe('warn');
  });
});

const mkt = (over: Partial<MarketingData> = {}): MarketingData => ({
  funnel: { inboxViewed: 0, opened: 0, markedRead: 0, ctaCompleted: 0, deleted: 0, pushReceived: 0, pushOpened: 0 },
  campaigns: [], topMessages: [], permissions: { granted: 0, denied: 0, denialTypes: [] }, geofences: [], geofenceExits: 0, webContent: [], contentViews: [],
  ...over,
});

describe('marketing insights', () => {
  it('unknown campaign: flags above 20%, silent at exactly 20% or with few opens', () => {
    expect(ids(marketingInsights(mkt({ campaigns: [{ campaignId: 'unknown_campaign', opens: 16 }] })))).toContain('unknown-campaign');
    expect(ids(marketingInsights(mkt({ campaigns: [{ campaignId: 'unknown_campaign', opens: 1 }, { campaignId: 'c1', opens: 4 }] })))).not.toContain('unknown-campaign');
    expect(ids(marketingInsights(mkt({ campaigns: [{ campaignId: 'unknown_campaign', opens: 4 }] })))).not.toContain('unknown-campaign');
  });

  const funnel = (deleted: number, markedRead: number, opened = 0, ctaCompleted = 0) =>
    mkt({ funnel: { inboxViewed: 0, opened, markedRead, ctaCompleted, deleted, pushReceived: 0, pushOpened: 0 } });
  it('deletes over reads: needs more deletes than reads and 10+ events', () => {
    expect(ids(marketingInsights(funnel(76, 38)))).toContain('deletes-over-reads');
    expect(ids(marketingInsights(funnel(5, 5)))).not.toContain('deletes-over-reads');
    expect(ids(marketingInsights(funnel(5, 4)))).not.toContain('deletes-over-reads');
  });

  it('denials mostly skipped: above half of 10+', () => {
    const denials = (skipped: number, permanent: number) =>
      mkt({ permissions: { granted: 0, denied: skipped + permanent, denialTypes: [{ type: 'skipped', count: skipped }, { type: 'permanently_denied', count: permanent }] } });
    expect(ids(marketingInsights(denials(18, 2)))).toContain('denials-skipped');
    expect(ids(marketingInsights(denials(5, 5)))).not.toContain('denials-skipped');
    expect(ids(marketingInsights(denials(8, 1)))).not.toContain('denials-skipped');
  });

  it('CTA gap: zero completions in 20+ opened messages', () => {
    expect(ids(marketingInsights(funnel(0, 0, 38, 0)))).toContain('cta-gap');
    expect(ids(marketingInsights(funnel(0, 0, 19, 0)))).not.toContain('cta-gap');
    expect(ids(marketingInsights(funnel(0, 0, 38, 1)))).not.toContain('cta-gap');
  });
});
