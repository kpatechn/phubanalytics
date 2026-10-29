import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import type { Problem, RxEvent, RxPatron } from '@phub/contracts';
import { fmtDate, fmtInt, fmtMoney, fmtShare } from '../analytics/format';
import { toProblem } from '../core/problem';
import { ErrorPanel } from '../shared/page-state';
import { RxApi } from './api';
import { RxContext } from './context';
import { loadRx } from './load';

const PATRON_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const REASON_LABEL: Record<string, string> = {
  reachable: 'Reachable',
  restricted: 'Restricted: never market',
  no_contact: 'No contact on file',
  channel_restricted: 'Channel restricted',
  opted_out: 'Opted out',
  no_consent: 'No consent recorded',
};

type Kind = 'visits' | 'offers' | 'hospitality' | 'compliance';
const KIND_OF: Record<string, Kind> = {
  visit: 'visits',
  stay: 'hospitality',
  dining: 'hospitality',
  restriction: 'compliance',
  consent: 'compliance',
};
const KIND_LABEL: Record<Kind, string> = { visits: 'Visits', offers: 'Offers', hospitality: 'Hotel and dining', compliance: 'Restrictions and consent' };
const KINDS: Kind[] = ['visits', 'offers', 'hospitality', 'compliance'];
const CHANNEL_LABEL: Record<string, string> = { email: 'Email', sms: 'SMS', push: 'App push', mail: 'Direct mail', host: 'Host' };
const EVENT_LABEL: Record<string, string> = {
  visit: 'Visit',
  sent: 'Offer sent',
  delivered: 'Offer delivered',
  opened: 'Offer opened',
  clicked: 'Offer clicked',
  redeemed: 'Offer redeemed',
  expired: 'Offer expired',
  bounced: 'Offer bounced',
  failed: 'Send failed',
  unsubscribed: 'Unsubscribed',
  issued: 'Free play issued',
  voided: 'Free play voided',
  stay: 'Hotel stay',
  dining: 'Dining',
  restriction: 'Restriction',
  consent: 'Consent change',
};

type Lookup = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; patron: RxPatron } | { status: 'error'; problem: Problem };

/** One patron's last 12 months: value, reach and every observed event. The ID stays in memory, never the URL. */
@Component({
  selector: 'app-rx-player-page',
  imports: [ErrorPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <section class="card" aria-labelledby="rx-find">
        <div class="card-head">
          <div>
            <h2 id="rx-find">Find a patron</h2>
            <div class="card-sub">Platform patron IDs only (no names). The ID stays on this page: it isn't put in the address bar, saved or cached.</div>
          </div>
        </div>
        <form class="search" (submit)="$event.preventDefault(); find(id.value)">
          <label class="field">
            Patron ID
            <input #id type="text" autocomplete="off" spellcheck="false" maxlength="36" [value]="query()" placeholder="0f2b7e1c-…" />
          </label>
          <button type="submit" class="btn">Look up</button>
        </form>
        @if (examples().length > 0) {
          <p class="note">Or pick an example: patrons who redeemed offers, top value across sites, and one who must never be marketed.</p>
          <ul class="samples" aria-label="Example patrons">
            @for (x of examples(); track x.patronId) {
              <li>
                <button type="button" class="btn" (click)="find(x.patronId)">
                  <span class="mono">{{ x.patronId.slice(0, 8) }}</span> · {{ x.tierName ?? 'no tier' }} · {{ x.note }}
                </button>
              </li>
            }
          </ul>
        }
      </section>

      @if (lookup().status === 'loading') {
        <p class="note" role="status">Looking up the patron…</p>
      } @else if (problem(); as p) {
        @if (p.status === 400 || p.status === 404) {
          <p class="card" role="alert"><strong>{{ p.title }}.</strong> {{ p.detail }}</p>
        } @else {
          <app-error-panel [problem]="p" (retry)="find(query())" />
        }
      } @else if (patron(); as pl) {
        <section class="card" aria-labelledby="rx-who">
          <div class="who">
            <h2 id="rx-who">Patron <span class="mono">{{ pl.patronId }}</span></h2>
            @if (pl.tierName) {
              <span class="tag good">{{ pl.tierName }}</span>
            }
            @if (pl.suppressOffers) {
              <span class="tag bad"><span aria-hidden="true">⛔</span> Never market</span>
            }
          </div>
          <p class="facts">
            Home site <strong>{{ propertyName(pl.homePropertyId) }}</strong> · {{ count(pl.sitesVisited12m, 'site') }} visited in 12 months
            @if (pl.recencyDays !== null) {
              · last visit {{ fmt(pl.recencyDays) }} days before {{ date(pl.asOfDate) }}
            }
          </p>
          @if (pl.tierPoints !== null) {
            <p class="facts">
              {{ fmt(pl.tierPoints) }} tier points
              @if (pl.nextTierName && pl.pointsToNextTier !== null) {
                · {{ fmt(pl.pointsToNextTier) }} more for {{ pl.nextTierName }}
              }
            </p>
          }
          <div class="cols">
            <dl class="figures" aria-label="Last 12 months">
              <dt>Visits</dt><dd>{{ fmt(pl.visits12m) }}</dd>
              <dt>Theo</dt><dd>{{ money(pl.theo12m) }}@if (pl.adt12m !== null) {<span class="extra">ADT {{ money(pl.adt12m) }}</span>}</dd>
              <dt>Casino win</dt><dd>{{ money(pl.casinoWin12m) }}</dd>
              <dt>Reinvestment</dt><dd>{{ money(pl.reinvestment12m) }}<span class="extra">{{ share(pl.reinvestmentRate) }} of theo</span></dd>
              <dt>Hospitality paid</dt><dd>{{ money(pl.hospitalityPaid12m) }}</dd>
              <dt>Net contribution</dt><dd><strong>{{ money(pl.netContribution12m) }}</strong></dd>
            </dl>
            <div>
              <h3>Can we reach them?</h3>
              <ul class="reach">
                @for (r of pl.reach; track r.channel) {
                  <li>
                    <span class="channel">{{ channelLabel(r.channel) }}</span>
                    <span [class]="r.reason === 'reachable' ? 'ok' : 'no'">{{ reasonLabel(r.reason) }}</span>
                  </li>
                } @empty {
                  <li class="no">No channels on file.</li>
                }
              </ul>
            </div>
          </div>
        </section>

        <section class="card" aria-labelledby="rx-journey">
          <div class="card-head">
            <div>
              <h2 id="rx-journey">Journey, last 12 months</h2>
              <div class="card-sub">
                What the platform observed, newest first. One timeline can't show what an offer caused; that is measured per campaign
                against its holdout on Offer effectiveness.
              </div>
            </div>
          </div>
          <div class="kinds" role="group" aria-label="Show events">
            @for (k of kinds; track k) {
              <label class="kind">
                <input type="checkbox" [checked]="shownKinds().has(k)" (change)="toggle(k)" />
                {{ kindLabel[k] }} ({{ fmt(kindCounts()[k]) }})
              </label>
            }
          </div>
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Event</th>
                  <th scope="col">Site</th>
                  <th scope="col">Campaign</th>
                  <th scope="col" class="num">Amount</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                @for (e of journey(); track $index) {
                  <tr>
                    <td>{{ date(e.eventAt.slice(0, 10)) }}</td>
                    <td>{{ eventLabel(e.eventType) }}{{ e.channel ? ' · ' + channelLabel(e.channel) : '' }}</td>
                    <td>{{ siteName(e.siteId) }}</td>
                    <td class="mono">{{ e.campaignId ?? '' }}</td>
                    <td class="num">{{ e.amount === null ? '' : money(e.amount) }}</td>
                    <td class="extra">{{ e.detail ?? '' }}</td>
                  </tr>
                } @empty {
                  <tr><td colspan="6" class="note">Nothing observed for the chosen events.</td></tr>
                }
              </tbody>
            </table>
          </div>
          <p class="note">Visit amounts are theo. Hotel and dining amounts are the check before comps.</p>
        </section>
      }
    </div>
  `,
  styles: `
    .search { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 16px; }
    .search .field input { width: 38ch; max-width: 100%; font-family: var(--mono); }
    .samples { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 0; padding: 0; list-style: none; }
    .who { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; }
    .who h2 { margin: 0; overflow-wrap: anywhere; }
    .facts { color: var(--ink2); font-size: 0.85rem; margin: 6px 0; }
    .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-top: 8px; }
    h3 { font-size: 0.9rem; margin: 10px 0 6px; }
    dl.figures { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 10px 0 0; font-size: 0.85rem; }
    dl.figures dt { color: var(--mute); }
    dl.figures dd { margin: 0; font-variant-numeric: tabular-nums; }
    .extra { color: var(--mute); margin-left: 6px; font-size: 0.8rem; }
    td.extra { margin-left: 0; }
    .reach { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: 0.85rem; }
    .reach li { display: flex; gap: 10px; }
    .channel { min-width: 8ch; }
    .ok { color: var(--good); font-weight: 600; }
    .no { color: var(--mute); }
    .kinds { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-bottom: 10px; font-size: 0.85rem; }
    .kind { display: inline-flex; align-items: center; gap: 6px; }
  `,
})
export class RxPlayerPage {
  private readonly api = inject(RxApi);
  private readonly context = inject(RxContext);
  private readonly destroyRef = inject(DestroyRef);

  private readonly exampleList = loadRx(() => this.api.patronExamples());
  protected readonly examples = computed(() => {
    const s = this.exampleList.state();
    return s.status === 'ready' ? s.data : [];
  });

  protected readonly query = signal('');
  protected readonly lookup = signal<Lookup>({ status: 'idle' });
  protected readonly patron = computed(() => {
    const l = this.lookup();
    return l.status === 'ready' ? l.patron : null;
  });
  protected readonly problem = computed(() => {
    const l = this.lookup();
    return l.status === 'error' ? l.problem : null;
  });

  protected readonly kinds = KINDS;
  protected readonly kindLabel = KIND_LABEL;
  protected readonly shownKinds = signal(new Set<Kind>(KINDS));
  protected readonly kindCounts = computed(() => {
    const counts: Record<Kind, number> = { visits: 0, offers: 0, hospitality: 0, compliance: 0 };
    for (const e of this.patron()?.journey ?? []) counts[kindOf(e)]++;
    return counts;
  });
  protected readonly journey = computed(() => {
    const shown = this.shownKinds();
    return (this.patron()?.journey ?? []).filter((e) => shown.has(kindOf(e)));
  });
  protected toggle(k: Kind): void {
    this.shownKinds.update((s) => {
      const next = new Set(s);
      if (!next.delete(k)) next.add(k);
      return next;
    });
  }

  protected readonly fmt = fmtInt;
  protected readonly money = fmtMoney;
  protected readonly share = fmtShare;
  protected readonly date = fmtDate;
  protected readonly count = (n: number, noun: string) => `${fmtInt(n)} ${noun}${n === 1 ? '' : 's'}`;
  protected readonly reasonLabel = (r: string) => REASON_LABEL[r] ?? r;
  protected readonly eventLabel = (t: string) => EVENT_LABEL[t] ?? t;
  protected readonly channelLabel = (c: string) => CHANNEL_LABEL[c] ?? c;
  protected readonly siteName = (id: string | null) => (id ? this.context.siteName(id) : '');
  protected readonly propertyName = (id: string | null) => this.context.propertyName(id);

  constructor() {
    const picked = this.context.pickedPatron();
    if (picked) {
      this.context.pickedPatron.set(null);
      this.find(picked);
    }
  }

  protected find(raw: string): void {
    const patronId = raw.trim().toLowerCase();
    this.query.set(patronId);
    if (!PATRON_ID.test(patronId)) {
      this.lookup.set({ status: 'error', problem: { type: 'about:blank', title: 'Not a patron ID', status: 400, detail: 'Use the 36-character platform ID, like 0f2b7e1c-3a4d-4e5f-8a9b-0c1d2e3f4a5b.' } });
      return;
    }
    this.lookup.set({ status: 'loading' });
    const sub = this.api.patron(patronId).subscribe({
      next: (envelope) => this.lookup.set({ status: 'ready', patron: envelope.data }),
      error: (err: unknown) => this.lookup.set({ status: 'error', problem: toProblem(err) }),
    });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }
}

function kindOf(e: RxEvent): Kind {
  return KIND_OF[e.eventType] ?? 'offers';
}
