import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { catchError, map, of, startWith, switchMap } from 'rxjs';
import type { Problem, RxCampaign, RxCampaignDetail, RxLift, RxMetric, RxVerdict } from '@phub/contracts';
import { fmtDate, fmtInt, fmtMoney, fmtShare } from '../analytics/format';
import { toProblem } from '../core/problem';
import { ErrorPanel, Skeleton } from '../shared/page-state';
import { RxApi } from './api';
import { loadRx } from './load';

const METRIC_LABEL: Record<RxMetric, string> = {
  net_contribution: 'Net contribution',
  theo: 'Theo',
  visits: 'Visits',
  incentive_cost: 'Incentive cost',
};
const METRICS: RxMetric[] = ['net_contribution', 'theo', 'visits', 'incentive_cost'];
const SEGMENT_LABEL: Record<string, string> = { all: 'Everyone', low: 'Low value', mid: 'Mid value', high: 'High value' };
const VERDICT_TONE: Record<RxVerdict, string> = {
  'pays back': 'good',
  'loses money': 'bad',
  'too small to read': 'warn',
  'no clear effect': '',
  'window open': '',
};

type Detail = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; data: RxCampaignDetail } | { status: 'error'; problem: Problem };

const cents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Per-patron difference: '+$4.12', '−$310', '+0.08 visits'. */
function perPatron(metric: RxMetric, v: number | null): string {
  if (v === null) return '–';
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (metric === 'visits') return `${sign}${a.toFixed(2)}`;
  return sign + (a < 100 ? cents.format(a) : fmtMoney(a));
}

/** Where an interval sits on a track centred on zero (percent of the track). */
export function ciBar(lo: number, hi: number, point: number, scale: number) {
  const pos = (v: number) => 50 + (Math.max(-scale, Math.min(scale, v)) / scale) * 50;
  return { left: pos(lo), width: Math.max(0.6, pos(hi) - pos(lo)), point: pos(point), clipLo: lo < -scale, clipHi: hi > scale };
}

/** Offer effectiveness: what each campaign caused, measured against its randomised holdout. */
@Component({
  selector: 'app-rx-offers-page',
  imports: [ErrorPanel, Skeleton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      @if (problem(); as p) {
        <app-error-panel [problem]="p" (retry)="loader.reload()" />
      } @else if (campaigns(); as list) {
        <section class="card" aria-labelledby="rx-campaigns">
          <div class="card-head">
            <div>
              <h2 id="rx-campaigns">Campaigns</h2>
              <div class="card-sub">
                Net contribution per assigned patron, treatment less holdout, adjusted for the 90 days before. Bars are 95% intervals;
                the line is zero. Everyone assigned counts, whether or not the message reached them.
              </div>
            </div>
          </div>
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th scope="col">Campaign</th>
                  <th scope="col">Sent</th>
                  <th scope="col" class="num">Treated / holdout</th>
                  <th scope="col" class="ci-col">Net lift per patron</th>
                  <th scope="col" class="num">Incremental profit</th>
                  <th scope="col">Verdict</th>
                </tr>
              </thead>
              <tbody>
                @for (c of list; track c.campaignId) {
                  <tr [class.picked]="c.campaignId === shownId()">
                    <th scope="row">
                      <button type="button" class="link" [attr.aria-pressed]="c.campaignId === shownId()" (click)="picked.set(c.campaignId)">{{ c.name }}</button>
                      <div class="extra">{{ c.offerType }}{{ c.faceValue ? ' ' + money(c.faceValue) : '' }} · {{ c.audienceName ?? 'custom audience' }}</div>
                    </th>
                    <td>{{ date(c.assignedDate) }}</td>
                    <td class="num">{{ count(c.nTreatment) }} / {{ count(c.nHoldout) }}</td>
                    <td class="ci-col">
                      @if (c.netLift !== null && c.netCiLow !== null && c.netCiHigh !== null) {
                        @let b = bar(c.netCiLow, c.netCiHigh, c.netLift, netScale());
                        <div class="ci" aria-hidden="true">
                          <span class="zero"></span>
                          <span class="range" [class.sig]="c.netSignificant" [class.neg]="c.netLift < 0" [class.clip-lo]="b.clipLo" [class.clip-hi]="b.clipHi" [style.left.%]="b.left" [style.width.%]="b.width"></span>
                          <span class="point" [style.left.%]="b.point"></span>
                        </div>
                        <div class="extra">{{ lift('net_contribution', c.netLift) }} ({{ lift('net_contribution', c.netCiLow) }} to {{ lift('net_contribution', c.netCiHigh) }})</div>
                      } @else {
                        <span class="extra">not measured yet</span>
                      }
                    </td>
                    <td class="num">{{ c.netIncrementalProfit === null ? '–' : money(c.netIncrementalProfit) }}</td>
                    <td><span [class]="'tag ' + tone[c.verdict]">{{ c.verdict }}</span></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        @if (shown(); as c) {
          <div class="detail">
            <section class="card" aria-labelledby="rx-funnel">
              <div class="card-head">
                <div>
                  <h2 id="rx-funnel">{{ c.name }}</h2>
                  <div class="card-sub">
                    {{ date(c.assignedDate) }} to {{ date(c.windowEnd) }} · {{ share(c.holdoutShare) }} held out ·
                    {{ count(c.excludedPatrons) }} left out by restrictions or consent
                  </div>
                </div>
              </div>
              <p class="rule"><span class="extra">Audience</span> <code>{{ c.audienceRule }}</code></p>
              <p class="rule"><span class="extra">Channels</span> {{ c.channelRule }}</p>
              <p class="extra">Share of treated patrons at each step. Patrons redeem at the casino, so redeeming doesn't need an open.</p>
              <ol class="funnel" aria-label="Share of treated patrons at each step">
                @for (s of funnel(); track s.label) {
                  <li>
                    <span class="label">{{ s.label }}</span>
                    <span class="track" aria-hidden="true"><span class="fill" [style.width.%]="(s.value ?? 0) * 100"></span></span>
                    <span class="value">{{ share(s.value) }}</span>
                  </li>
                }
              </ol>
              <div class="flags">
                @if (c.underpowered) {
                  <span class="tag warn">underpowered: too few patrons to see a realistic effect</span>
                }
                @if (c.imbalanced) {
                  <span class="tag warn">groups differed before the campaign</span>
                }
                @if (c.heavyOverlap) {
                  <span class="tag warn">many patrons were in other campaigns at the same time</span>
                }
                @if (!c.windowClosed) {
                  <span class="tag">response window still open</span>
                }
              </div>
              @if (c.servicingCost !== null) {
                <p class="note">Sending cost {{ money(c.servicingCost) }} is already taken off the incremental profit.</p>
              }
            </section>

            <section class="card" aria-labelledby="rx-lift">
              <div class="card-head">
                <div>
                  <h2 id="rx-lift">Lift by segment</h2>
                  <div class="card-sub">Per assigned patron. Segments are the patron's value before the campaign; intervals are wider for smaller groups.</div>
                </div>
              </div>
              <div class="metric-pick" role="group" aria-label="Measure">
                @for (m of metrics; track m) {
                  <button type="button" class="btn" [attr.aria-pressed]="metric() === m" (click)="metric.set(m)">{{ metricLabel[m] }}</button>
                }
              </div>
              @if (detail().status === 'loading') {
                <p class="note" role="status">Loading the campaign…</p>
              } @else if (detailProblem(); as p) {
                <app-error-panel [problem]="p" (retry)="retry()" />
              } @else {
                <div class="table-wrap">
                  <table class="data">
                    <thead>
                      <tr>
                        <th scope="col">Segment</th>
                        <th scope="col" class="num">Treated / holdout</th>
                        <th scope="col" class="num">Treated mean</th>
                        <th scope="col" class="num">Holdout mean</th>
                        <th scope="col" class="ci-col">Adjusted difference</th>
                        <th scope="col" class="num">Smallest detectable</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (l of liftRows(); track l.segment) {
                        @let b = bar(l.adjustedCiLow, l.adjustedCiHigh, l.adjustedDiff, liftScale());
                        <tr>
                          <th scope="row">
                            {{ segmentLabel(l.segment) }}
                            @if (l.underpowered) {
                              <span class="tag warn">underpowered</span>
                            }
                            @if (l.prePeriodSmd !== null && l.prePeriodSmd > 0.1) {
                              <span class="tag warn">imbalanced</span>
                            }
                          </th>
                          <td class="num">{{ count(l.nTreatment) }} / {{ count(l.nHoldout) }}</td>
                          <td class="num">{{ level(l.meanTreatment) }}</td>
                          <td class="num">{{ level(l.meanHoldout) }}</td>
                          <td class="ci-col">
                            <div class="ci" aria-hidden="true">
                              <span class="zero"></span>
                              <span class="range" [class.sig]="l.significant" [class.neg]="l.adjustedDiff < 0" [class.clip-lo]="b.clipLo" [class.clip-hi]="b.clipHi" [style.left.%]="b.left" [style.width.%]="b.width"></span>
                              <span class="point" [style.left.%]="b.point"></span>
                            </div>
                            <div class="extra">
                              {{ lift(metric(), l.adjustedDiff) }} ({{ lift(metric(), l.adjustedCiLow) }} to {{ lift(metric(), l.adjustedCiHigh) }})
                              @if (l.significant) {
                                <strong>· clear</strong>
                              }
                            </div>
                          </td>
                          <td class="num">±{{ lift(metric(), l.minDetectableEffect).replace('+', '') }}</td>
                        </tr>
                      } @empty {
                        <tr><td colspan="6" class="note">No lift measured for this campaign yet.</td></tr>
                      }
                    </tbody>
                  </table>
                </div>
                <p class="note">
                  "Clear" means the 95% interval excludes zero. Segment rows are four looks at one campaign, so one of them crossing zero
                  by chance is expected now and then; trust the Everyone row first.
                </p>
              }
            </section>
          </div>
        }
      } @else {
        <app-skeleton />
      }
    </div>
  `,
  styles: `
    .link { all: unset; cursor: pointer; font-weight: 600; color: var(--ink); text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; }
    .link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
    tr.picked > * { background: color-mix(in srgb, var(--accent) 7%, transparent); }
    .extra { color: var(--mute); font-size: 0.8rem; font-weight: 400; }
    .ci-col { min-width: 220px; }
    .ci { position: relative; height: 12px; margin: 2px 0 3px; }
    .ci .zero { position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; background: var(--ink2); }
    .ci .range { position: absolute; top: 3px; height: 6px; border-radius: 3px; background: var(--mute); opacity: 0.55; }
    .ci .range.sig { background: var(--accent); opacity: 1; }
    .ci .range.sig.neg { background: var(--bad); }
    .ci .range.clip-lo { border-top-left-radius: 0; border-bottom-left-radius: 0; border-left: 2px dashed var(--ink2); }
    .ci .range.clip-hi { border-top-right-radius: 0; border-bottom-right-radius: 0; border-right: 2px dashed var(--ink2); }
    .ci .point { position: absolute; top: 1px; width: 2px; height: 10px; margin-left: -1px; background: var(--ink); }
    .rule { margin: 4px 0; font-size: 0.85rem; overflow-wrap: anywhere; }
    .rule code { font-family: var(--mono); font-size: 0.8rem; }
    .funnel { list-style: none; margin: 12px 0; padding: 0; display: grid; gap: 6px; }
    .funnel li { display: grid; grid-template-columns: 9ch 1fr 5ch; align-items: center; gap: 10px; font-size: 0.85rem; }
    .funnel .track { height: 10px; background: var(--grid); border-radius: 5px; overflow: hidden; }
    .funnel .fill { display: block; height: 100%; background: var(--ctx); border-radius: 5px; min-width: 2px; }
    .funnel .value { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
    .detail { display: grid; gap: 16px; grid-template-columns: minmax(260px, 1fr) minmax(0, 2fr); align-items: start; }
    @media (max-width: 960px) { .detail { grid-template-columns: minmax(0, 1fr); } }
    .flags { display: flex; flex-wrap: wrap; gap: 6px; }
    .metric-pick { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
    .metric-pick .btn[aria-pressed='true'] { border-color: var(--accent); color: var(--ink); font-weight: 600; }
  `,
})
export class RxOffersPage {
  private readonly api = inject(RxApi);
  protected readonly loader = loadRx(() => this.api.overview());
  protected readonly problem = computed(() => {
    const s = this.loader.state();
    return s.status === 'error' ? s.problem : null;
  });
  /** Newest first. */
  protected readonly campaigns = computed<RxCampaign[] | null>(() => {
    const s = this.loader.state();
    return s.status === 'ready' ? [...s.data.campaigns].sort((a, b) => b.assignedDate.localeCompare(a.assignedDate)) : null;
  });

  protected readonly picked = signal<string | null>(null);
  /** The picked campaign, else the newest one with a closed window. */
  protected readonly shownId = computed(() => {
    const list = this.campaigns() ?? [];
    return this.picked() ?? list.find((c) => c.windowClosed)?.campaignId ?? list[0]?.campaignId ?? null;
  });
  protected readonly shown = computed(() => (this.campaigns() ?? []).find((c) => c.campaignId === this.shownId()) ?? null);

  private readonly retries = signal(0);
  protected readonly detail = toSignal(
    toObservable(computed(() => ({ id: this.shownId(), n: this.retries() }))).pipe(
      switchMap(({ id }) =>
        id === null
          ? of<Detail>({ status: 'idle' })
          : this.api.campaign(id).pipe(
              map((e): Detail => ({ status: 'ready', data: e.data })),
              catchError((err: unknown) => of<Detail>({ status: 'error', problem: toProblem(err) })),
              startWith<Detail>({ status: 'loading' }),
            ),
      ),
    ),
    { initialValue: { status: 'idle' } as Detail },
  );
  protected readonly detailProblem = computed(() => {
    const d = this.detail();
    return d.status === 'error' ? d.problem : null;
  });
  protected retry(): void {
    this.retries.update((n) => n + 1);
  }

  protected readonly metrics = METRICS;
  protected readonly metricLabel = METRIC_LABEL;
  protected readonly metric = signal<RxMetric>('net_contribution');
  protected readonly liftRows = computed<RxLift[]>(() => {
    const d = this.detail();
    return d.status === 'ready' ? d.data.lift.filter((l) => l.metric === this.metric()) : [];
  });

  /** Scaled to the readable rows, so one tiny pilot doesn't flatten the rest; underpowered intervals clip at the edges. */
  protected readonly netScale = computed(() => {
    const list = this.campaigns() ?? [];
    const readable = list.filter((c) => !c.underpowered);
    return scaleOf((readable.length ? readable : list).flatMap((c) => [c.netCiLow ?? 0, c.netCiHigh ?? 0]));
  });
  protected readonly liftScale = computed(() => {
    const rows = this.liftRows();
    const readable = rows.filter((l) => !l.underpowered);
    return scaleOf((readable.length ? readable : rows).flatMap((l) => [l.adjustedCiLow, l.adjustedCiHigh]));
  });

  protected readonly funnel = computed(() => {
    const c = this.shown();
    if (!c) return [];
    return [
      { label: 'Sent', value: c.sentRate },
      { label: 'Delivered', value: c.deliveredRate },
      { label: 'Opened', value: c.openedRate },
      { label: 'Redeemed', value: c.redeemedRate },
    ];
  });

  protected readonly tone = VERDICT_TONE;
  protected readonly money = fmtMoney;
  protected readonly share = fmtShare;
  protected readonly date = fmtDate;
  protected readonly bar = ciBar;
  protected readonly lift = perPatron;
  protected readonly count = (n: number | null) => (n === null ? '–' : fmtInt(n));
  protected readonly segmentLabel = (s: string) => SEGMENT_LABEL[s] ?? s;
  protected level(v: number): string {
    return this.metric() === 'visits' ? v.toFixed(2) : v < 100 ? cents.format(v) : fmtMoney(v);
  }
}

/** Half-width of a zero-centred track that fits every interval. */
function scaleOf(values: number[]): number {
  return Math.max(1e-9, ...values.map((v) => Math.abs(v))) * 1.05;
}
