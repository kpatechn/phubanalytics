import type { Delivery, EngagementData, ExecutiveData, ItData, MarketingData } from '@phub/contracts';
import { fmtInt, fmtPct, fmtPlatform, fmtRate } from './format';

// Insight rules: pure functions of one view's data. Thresholds and minimum
// sample sizes live in INSIGHT_CONFIG so their owners can change them in one place.

export type Severity = 'good' | 'info' | 'warn' | 'bad';

export interface Insight {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
}

export const INSIGHT_CONFIG = {
  loginRate: { minAttempts: 20, target: 0.95 },
  walletOffsite: { minEvents: 30, share: 0.6 },
  errorsRising: { minErrors: 20, increase: 0.25 },
  uploadFailures: { minErrors: 20, share: 0.1, endpoint: 'analyticLogs' },
  fixFirst: { minServerErrors: 10 },
  biometric: { minChecks: 20, target: 0.9 },
  unknownCampaign: { minOpens: 5, share: 0.2 },
  deletesOverReads: { minEvents: 10 },
  denialsSkipped: { minDenials: 10, share: 0.5 },
  ctaGap: { minOpened: 20 },
  engagement: { minAccounts: 20, weekReturnTarget: 0.25, newShare: 0.5 },
  delivery: { minSends: 100, failShare: 0.2 },
  campaignDelivery: { minSent: 100, deliveredShare: 0.5 },
  jobs: { minRuns: 20, failShare: 0.05 },
  versionErrors: { minSessions: 20, multiple: 2 },
  oldVersions: { minAccounts: 20, share: 0.3 },
};

export type InsightConfig = typeof INSIGHT_CONFIG;

function deliveryInsight(d: Delivery, c: InsightConfig): Insight | null {
  const sent = d.byType.reduce((n, t) => n + t.sent, 0);
  const failed = d.byType.reduce((n, t) => n + t.failed, 0);
  if (sent < c.delivery.minSends || failed / sent < c.delivery.failShare) return null;
  const top = d.reasons[0];
  return {
    id: 'send-failures',
    severity: 'bad',
    title: `${fmtPct(failed, sent)} of message sends failed`,
    detail: `${fmtInt(failed)} of ${fmtInt(sent)} sends failed.` + (top ? ` Top reason: "${top.reason}" (${fmtInt(top.count)}).` : ''),
  };
}

export function executiveInsights(d: ExecutiveData, c: InsightConfig = INSIGHT_CONFIG): Insight[] {
  const out: Insight[] = [];
  const { loginStarted, loginSuccess, apiErrors } = d.kpis;

  if (loginSuccess > loginStarted) {
    out.push({ id: 'login-tracking', severity: 'warn', title: 'Login tracking gap: more successes than attempts', detail: `${fmtInt(loginSuccess)} successful logins but ${fmtInt(loginStarted)} attempts. Some login paths don't send login_initiated, so no success rate is shown.` });
  } else if (loginStarted >= c.loginRate.minAttempts) {
    const rate = loginSuccess / loginStarted;
    out.push(
      rate >= c.loginRate.target
        ? { id: 'login-rate', severity: 'good', title: `Login success ${fmtRate(loginSuccess, loginStarted)}`, detail: `${fmtInt(loginSuccess)} of ${fmtInt(loginStarted)} attempts succeeded, at or above the ${fmtPct(c.loginRate.target, 1)} target.` }
        : { id: 'login-rate', severity: 'bad', title: `Login success ${fmtRate(loginSuccess, loginStarted)}, below target`, detail: `${fmtInt(loginStarted - loginSuccess)} of ${fmtInt(loginStarted)} attempts failed. Target is ${fmtPct(c.loginRate.target, 1)}.` },
    );
  }

  const wallet = d.features.find((f) => f.feature === 'Wallet');
  if (wallet) {
    const total = wallet.onsite + wallet.offsite + wallet.unknown;
    if (total >= c.walletOffsite.minEvents && wallet.offsite / total >= c.walletOffsite.share) {
      out.push({ id: 'wallet-offsite', severity: 'info', title: `Wallet is used mostly off property (${fmtPct(wallet.offsite, total)})`, detail: `${fmtInt(wallet.offsite)} of ${fmtInt(total)} wallet events came from guests away from the property.` });
    }
  }

  const prior = d.previous.apiErrors;
  if (apiErrors >= c.errorsRising.minErrors && prior > 0 && (apiErrors - prior) / prior >= c.errorsRising.increase) {
    out.push({ id: 'errors-rising', severity: 'warn', title: `API errors up ${fmtPct(apiErrors - prior, prior)}`, detail: `${fmtInt(apiErrors)} errors this period vs ${fmtInt(prior)} in the prior period.` });
  }
  return out;
}

export function itInsights(d: ItData, c: InsightConfig = INSIGHT_CONFIG): Insight[] {
  const out: Insight[] = [];
  const totalErrors = d.errors.reduce((n, e) => n + e.count, 0);

  const uploads = d.errors.filter((e) => e.endpoint.includes(c.uploadFailures.endpoint)).reduce((n, e) => n + e.count, 0);
  if (totalErrors >= c.uploadFailures.minErrors && uploads / totalErrors >= c.uploadFailures.share) {
    out.push({ id: 'upload-failures', severity: 'bad', title: `Analytics uploads failing: ${fmtPct(uploads, totalErrors)} of API errors`, detail: `${fmtInt(uploads)} of ${fmtInt(totalErrors)} errors are on the analytics upload. Each one loses events, so every metric here undercounts.` });
  }

  const serverErrors = new Map<string, number>();
  for (const e of d.errors) {
    if (/^5\d\d$/.test(e.statusCode)) serverErrors.set(e.endpoint, (serverErrors.get(e.endpoint) ?? 0) + e.count);
  }
  const worst = [...serverErrors].sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[1] >= c.fixFirst.minServerErrors) {
    out.push({ id: 'fix-first', severity: 'warn', title: `Fix first: ${worst[0]}`, detail: `${fmtInt(worst[1])} server errors (5xx), the most of any endpoint.` });
  }

  const sendFailures = deliveryInsight(d.delivery, c);
  if (sendFailures) out.push(sendFailures);

  const realJobs = d.jobs.filter((j) => !j.isTest);
  const stuck = realJobs.reduce((n, j) => n + j.stuck, 0);
  if (stuck > 0) {
    const worst = [...realJobs].sort((a, b) => b.stuck - a.stuck)[0]!;
    out.push({ id: 'stuck-jobs', severity: 'bad', title: `${fmtInt(stuck)} scheduled job runs never finished`, detail: `Started over an hour ago with no end. Most: ${worst.jobName} (${fmtInt(worst.stuck)}).` });
  }
  const failing = realJobs.filter((j) => j.runs >= c.jobs.minRuns && j.failed / j.runs >= c.jobs.failShare);
  if (failing.length > 0) {
    const worst = [...failing].sort((a, b) => b.failed / b.runs - a.failed / a.runs)[0]!;
    out.push({ id: 'job-failures', severity: 'warn', title: `${fmtInt(failing.length)} scheduled job${failing.length === 1 ? '' : 's'} failing ${fmtPct(c.jobs.failShare, 1)} or more of runs`, detail: `Worst: ${worst.jobName}, ${fmtInt(worst.failed)} of ${fmtInt(worst.runs)} runs failed.` });
  }

  const sessions = d.versions.reduce((n, v) => n + v.sessions, 0);
  const errors = d.versions.reduce((n, v) => n + v.errors, 0);
  if (sessions > 0) {
    const overall = errors / sessions;
    const bad = d.versions
      .filter((v) => v.appVersion !== 'unknown' && v.sessions >= c.versionErrors.minSessions && overall > 0 && v.errors / v.sessions >= overall * c.versionErrors.multiple)
      .sort((a, b) => b.errors / b.sessions - a.errors / a.sessions)[0];
    if (bad) {
      out.push({ id: 'version-errors', severity: 'warn', title: `${fmtPlatform(bad.platform)} ${bad.appVersion} has ${(bad.errors / bad.sessions / overall).toFixed(1)}× the average API error rate`, detail: `${fmtInt(bad.errors)} API errors in ${fmtInt(bad.sessions)} sessions, against ${(overall * 100).toFixed(1)} per 100 sessions overall.` });
    }
  }

  const accounts = d.versions.reduce((n, v) => n + v.accounts, 0);
  const behind = d.versions.filter((v) => !v.isLatest && v.appVersion !== 'unknown').reduce((n, v) => n + v.accounts, 0);
  if (accounts >= c.oldVersions.minAccounts && behind / accounts >= c.oldVersions.share) {
    out.push({ id: 'old-versions', severity: 'info', title: `${fmtPct(behind, accounts)} of accounts used an older app version`, detail: `Counted per account and version; an account that updated during the period appears on both.` });
  }

  const checks = d.biometrics.passed + d.biometrics.failed;
  if (checks >= c.biometric.minChecks) {
    const rate = d.biometrics.passed / checks;
    out.push({ id: 'biometric', severity: rate >= c.biometric.target ? 'good' : 'warn', title: `Biometric pass rate ${fmtRate(d.biometrics.passed, checks)}`, detail: `${fmtInt(d.biometrics.passed)} of ${fmtInt(checks)} Face ID / Touch ID checks passed.` });
  }
  return out;
}

export function marketingInsights(d: MarketingData, c: InsightConfig = INSIGHT_CONFIG): Insight[] {
  const out: Insight[] = [];

  const opens = d.campaigns.reduce((n, x) => n + x.opens, 0);
  const unknown = d.campaigns.find((x) => x.campaignId === 'unknown_campaign' || x.campaignId === '(none)')?.opens ?? 0;
  if (opens >= c.unknownCampaign.minOpens && unknown / opens > c.unknownCampaign.share) {
    out.push({ id: 'unknown-campaign', severity: 'warn', title: `${fmtPct(unknown, opens)} of push opens have no campaign`, detail: `${fmtInt(unknown)} of ${fmtInt(opens)} opens arrive without a campaign ID, so results can't be credited to campaigns.` });
  }

  const { deleted, markedRead, opened, ctaCompleted } = d.funnel;
  if (deleted + markedRead >= c.deletesOverReads.minEvents && deleted > markedRead) {
    out.push({ id: 'deletes-over-reads', severity: 'warn', title: 'Guests delete more messages than they read', detail: `${fmtInt(deleted)} deleted vs ${fmtInt(markedRead)} marked read.` });
  }

  const denials = d.permissions.denialTypes.reduce((n, x) => n + x.count, 0);
  const skipped = d.permissions.denialTypes.find((x) => x.type === 'skipped')?.count ?? 0;
  if (denials >= c.denialsSkipped.minDenials && skipped / denials > c.denialsSkipped.share) {
    out.push({ id: 'denials-skipped', severity: 'info', title: `Most notification denials were skipped (${fmtPct(skipped, denials)})`, detail: `${fmtInt(skipped)} of ${fmtInt(denials)} denials were "skipped", not permanent: those guests can be asked again.` });
  }

  const sendFailures = deliveryInsight(d.delivery, c);
  if (sendFailures) out.push(sendFailures);

  const real = d.campaignResults.filter((r) => !r.isTest);
  const sent = real.reduce((n, r) => n + r.sent, 0);
  const delivered = real.reduce((n, r) => n + r.delivered, 0);
  if (sent >= c.campaignDelivery.minSent && delivered / sent < c.campaignDelivery.deliveredShare) {
    out.push({ id: 'campaign-delivery', severity: 'warn', title: `Only ${fmtPct(delivered, sent)} of campaign messages were confirmed delivered`, detail: `${fmtInt(delivered)} of ${fmtInt(sent)} messages from non-test campaigns. Delivery tracking may be incomplete as well as sends failing.` });
  }

  if (opened >= c.ctaGap.minOpened && ctaCompleted === 0) {
    out.push({ id: 'cta-gap', severity: 'warn', title: 'No CTA completions recorded', detail: `0 of ${fmtInt(opened)} opened messages completed their call to action. Likely a tracking gap: check that the app sets is_cta_completed.` });
  }
  return out;
}

export function engagementInsights(d: EngagementData, c: InsightConfig = INSIGHT_CONFIG): Insight[] {
  const out: Insight[] = [];
  const { activeAccounts, newAccounts, onsiteAccounts, mau, wauMau } = d.summary;
  const min = c.engagement.minAccounts;

  if (activeAccounts < min) {
    out.push({ id: 'small-sample', severity: 'info', title: `Only ${fmtInt(activeAccounts)} active accounts`, detail: `Ratios and retention need at least ${fmtInt(min)} accounts to mean much, so most insights are held back.` });
    return out;
  }

  if (mau >= min && wauMau !== null) {
    out.push({ id: 'stickiness', severity: 'info', title: `WAU/MAU ${fmtPct(wauMau, 1)}`, detail: `In a typical week, ${fmtPct(wauMau, 1)} of the month's active accounts used the app.` });
  }

  const week = d.returnRates.find((r) => r.days === 7);
  if (week && week.eligible >= min) {
    const rate = week.returned / week.eligible;
    out.push(
      rate >= c.engagement.weekReturnTarget
        ? { id: 'week-return', severity: 'good', title: `${fmtPct(week.returned, week.eligible)} of new accounts came back within a week`, detail: `${fmtInt(week.returned)} of ${fmtInt(week.eligible)} new accounts were active again within 7 days.` }
        : { id: 'week-return', severity: 'warn', title: `Only ${fmtPct(week.returned, week.eligible)} of new accounts came back within a week`, detail: `${fmtInt(week.returned)} of ${fmtInt(week.eligible)} new accounts were active again within 7 days (target ${fmtPct(c.engagement.weekReturnTarget, 1)}).` },
    );
  }

  if (newAccounts / activeAccounts > c.engagement.newShare) {
    out.push({ id: 'mostly-new', severity: 'info', title: `Most active accounts are new (${fmtPct(newAccounts, activeAccounts)})`, detail: `${fmtInt(newAccounts)} of ${fmtInt(activeAccounts)} active accounts were first seen in this period.` });
  }

  out.push({ id: 'onsite-share', severity: 'info', title: `${fmtPct(onsiteAccounts, activeAccounts)} of active accounts used the app on property`, detail: `${fmtInt(onsiteAccounts)} of ${fmtInt(activeAccounts)} accounts had at least one foreground event on property.` });
  return out;
}
