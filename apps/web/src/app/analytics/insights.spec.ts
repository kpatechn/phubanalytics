import { describe, expect, it } from 'vitest';
import type { EngagementData, EngagementSummary, ExecutiveData, ExecutiveKpis, ItData, MarketingData } from '@phub/contracts';
import { engagementInsights, executiveInsights, itInsights, marketingInsights } from './insights';

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

const noDelivery = { byType: [], reasons: [], daily: [] };
const it_ = (errors: ItData['errors'], biometrics = { passed: 0, failed: 0 }, over: Partial<ItData> = {}): ItData => ({
  errors, topMessages: [], daily: [], hourly: [], screens: [], biometrics, logins: { started: 0, succeeded: 0, authMethods: [] }, pushReceived: 0,
  versions: [], sessionLength: [], platforms: [], deviceModels: [], delivery: noDelivery, jobs: [], jobDaily: [], ...over,
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
  delivery: noDelivery, campaignResults: [],
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

const summary = (over: Partial<EngagementSummary> = {}): EngagementSummary => ({
  dau: 0, wau: 0, mau: 0, dauMau: null, wauMau: null, activeAccounts: 0, newAccounts: 0, returningAccounts: 0, onsiteAccounts: 0, ...over,
});
const engagement = (over: Partial<EngagementSummary> = {}, week = { eligible: 0, returned: 0 }): EngagementData => ({
  summary: summary(over), previous: summary(), daily: [], features: [], cohorts: [], backgroundEvents: [], historyStart: null,
  tiers: [], featureTiers: [], platforms: [],
  returnRates: [{ days: 7, ...week }, { days: 30, eligible: 0, returned: 0 }],
});

describe('engagement insights', () => {
  it('below 20 active accounts: only the small-sample note', () => {
    expect(ids(engagementInsights(engagement({ activeAccounts: 19, newAccounts: 15, mau: 19, wauMau: 0.5 })))).toEqual(['small-sample']);
  });

  it('at 20 accounts: stickiness and on-property share appear', () => {
    const list = ids(engagementInsights(engagement({ activeAccounts: 20, newAccounts: 5, onsiteAccounts: 8, mau: 20, wauMau: 0.4 })));
    expect(list).toEqual(['stickiness', 'onsite-share']);
  });

  it('week return: silent below 20 eligible, good at the 25% target, warn below it', () => {
    const base = { activeAccounts: 40, newAccounts: 10, mau: 40, wauMau: 0.4 };
    expect(ids(engagementInsights(engagement(base, { eligible: 19, returned: 1 })))).not.toContain('week-return');
    expect(find(engagementInsights(engagement(base, { eligible: 20, returned: 5 })), 'week-return')?.severity).toBe('good');
    expect(find(engagementInsights(engagement(base, { eligible: 20, returned: 4 })), 'week-return')?.severity).toBe('warn');
  });

  it('mostly new: above half of active accounts, not at exactly half', () => {
    expect(ids(engagementInsights(engagement({ activeAccounts: 20, newAccounts: 11 })))).toContain('mostly-new');
    expect(ids(engagementInsights(engagement({ activeAccounts: 20, newAccounts: 10 })))).not.toContain('mostly-new');
  });
});

const delivery = (sent: number, failed: number) => ({
  byType: [{ messageType: 'sendApn', sent, delivered: sent - failed, failed, other: 0 }],
  reasons: [{ reason: 'Device token is unavailable', count: failed }],
  daily: [],
});
const job = (jobName: string, runs: number, failed: number, stuck = 0, isTest = false) => ({
  jobName, isTest, runs, completed: runs - failed - stuck, failed, stuck, running: 0, avgSeconds: 1, maxSeconds: 2, lastStartAt: null, lastStatus: 'completed',
});
const version = (appVersion: string, sessions: number, errors: number, accounts = 10, isLatest = false) => ({
  platform: 'ios', appVersion, sessions, accounts, events: sessions * 10, errors, isLatest,
});

describe('platform insights', () => {
  it('send failures: silent below 100 sends or under 20%, bad at 20% of 100', () => {
    expect(ids(itInsights(it_([], undefined, { delivery: delivery(99, 99) })))).not.toContain('send-failures');
    expect(ids(itInsights(it_([], undefined, { delivery: delivery(100, 19) })))).not.toContain('send-failures');
    const hit = find(itInsights(it_([], undefined, { delivery: delivery(100, 20) })), 'send-failures');
    expect(hit?.severity).toBe('bad');
    expect(hit?.detail).toContain('Device token is unavailable');
    expect(ids(marketingInsights(mkt({ delivery: delivery(100, 20) })))).toContain('send-failures');
  });

  it('stuck jobs: any stuck run in a non-test job; test jobs ignored', () => {
    expect(find(itInsights(it_([], undefined, { jobs: [job('checkIn', 50, 0, 1)] })), 'stuck-jobs')?.severity).toBe('bad');
    expect(ids(itInsights(it_([], undefined, { jobs: [job('Dev Test-6', 50, 0, 5, true)] })))).not.toContain('stuck-jobs');
  });

  it('job failures: 5% of 20+ runs', () => {
    expect(ids(itInsights(it_([], undefined, { jobs: [job('checkIn', 19, 19)] })))).not.toContain('job-failures');
    expect(ids(itInsights(it_([], undefined, { jobs: [job('checkIn', 20, 1)] })))).toContain('job-failures');
    expect(ids(itInsights(it_([], undefined, { jobs: [job('checkIn', 100, 4)] })))).not.toContain('job-failures');
  });

  it('version errors: a version at 2x the average with 20+ sessions', () => {
    // Overall 30 errors / 200 sessions = 15 per 100; 1.0.5 has 20 / 40 = 50 per 100 (3.3x).
    const bad = itInsights(it_([], undefined, { versions: [version('1.2.0', 160, 10, 10, true), version('1.0.5', 40, 20)] }));
    expect(find(bad, 'version-errors')?.title).toContain('1.0.5');
    // Same rate but only 19 sessions: silent.
    expect(ids(itInsights(it_([], undefined, { versions: [version('1.2.0', 160, 10, 10, true), version('1.0.5', 19, 10)] })))).not.toContain('version-errors');
  });

  it('old versions: 30% of 20+ accounts not on the latest version', () => {
    expect(ids(itInsights(it_([], undefined, { versions: [version('1.2.0', 50, 0, 14, true), version('1.0.5', 50, 0, 6)] })))).toContain('old-versions');
    expect(ids(itInsights(it_([], undefined, { versions: [version('1.2.0', 50, 0, 15, true), version('1.0.5', 50, 0, 5)] })))).not.toContain('old-versions');
  });

  it('campaign delivery: under half of 100+ non-test messages confirmed delivered', () => {
    const result = (sent: number, delivered: number, isTest = false) => ({
      campaignId: 'c', name: 'Daily schedule', category: 'marketing', status: 'completed', targetType: 'player', isTest, channel: 'apn',
      sent, delivered, opened: 0, clicked: 0, converted: 0, unsubscribed: 0,
    });
    expect(ids(marketingInsights(mkt({ campaignResults: [result(100, 49)] })))).toContain('campaign-delivery');
    expect(ids(marketingInsights(mkt({ campaignResults: [result(100, 50)] })))).not.toContain('campaign-delivery');
    expect(ids(marketingInsights(mkt({ campaignResults: [result(1000, 0, true)] })))).not.toContain('campaign-delivery');
  });
});
