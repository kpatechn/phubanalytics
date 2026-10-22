import type { ExecutiveData, ItData, MarketingData } from '@phub/contracts';
import { fmtInt, fmtPct, fmtRate } from './format';

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
};

export type InsightConfig = typeof INSIGHT_CONFIG;

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

  if (opened >= c.ctaGap.minOpened && ctaCompleted === 0) {
    out.push({ id: 'cta-gap', severity: 'warn', title: 'No CTA completions recorded', detail: `0 of ${fmtInt(opened)} opened messages completed their call to action. Likely a tracking gap: check that the app sets is_cta_completed.` });
  }
  return out;
}
