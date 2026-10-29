import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import type { Problem, RxConstraint, RxRunDetail, RxRunRequest } from '@phub/contracts';
import { fmtInt, fmtMoney, fmtShare } from '../analytics/format';
import { toProblem } from '../core/problem';
import { KpiTile } from '../shared/kpi-tile';
import { ErrorPanel } from '../shared/page-state';
import { RxApi } from './api';
import { RxContext } from './context';
import { loadRx } from './load';

type Run =
  | { status: 'idle' }
  | { status: 'running'; started: number }
  | { status: 'ready'; detail: RxRunDetail; fresh: boolean }
  | { status: 'error'; problem: Problem };

const UNIT_LABEL: Record<RxConstraint['kind'], string> = {
  budget: 'per extra dollar of budget',
  max_offers: 'per extra offer allowed',
  site_cap: 'per extra dollar at this site',
  site_floor: 'per dollar less required here',
  patrons: 'per extra patron',
  room_nights: 'per extra room night',
};


/** Parses a typed dollar amount ('60,000', '$60k'); null when blank, NaN when unreadable. */
export function amount(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/[$,\s]/g, '');
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(s);
  if (!m) return Number.NaN;
  return Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1);
}

/** Optimizer: plan next period's offers for a budget, from what past campaigns measurably caused. */
@Component({
  selector: 'app-rx-optimizer-page',
  imports: [KpiTile, ErrorPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      @if (enabled() === false) {
        <p class="card" role="note"><strong>The optimizer isn't configured on this server.</strong> Past runs still show below.</p>
      }
      <section class="card" aria-labelledby="rx-plan">
        <div class="card-head">
          <div>
            <h2 id="rx-plan">Plan a period</h2>
            <div class="card-sub">
              Picks one offer per patron (or none) to maximise expected profit within your limits. Only offers with a measured effect are
              funded; a holdout is kept back so the plan itself gets measured.
            </div>
          </div>
        </div>
        <form class="plan" (submit)="$event.preventDefault(); plan()">
          <div class="row">
            <label class="field">
              Budget
              <input type="text" inputmode="decimal" autocomplete="off" [value]="budget()" (input)="budget.set(value($event))" required />
            </label>
            <label class="field">
              Holdout
              <select (change)="holdout.set(value($event))">
                @for (h of holdouts; track h) {
                  <option [value]="h" [selected]="h === holdout()">{{ share(+h) }}</option>
                }
              </select>
            </label>
            <label class="field">
              Risk
              <select (change)="risk.set($any(value($event)))">
                <option value="conservative" [selected]="risk() === 'conservative'">Conservative (lift less one standard error)</option>
                <option value="expected" [selected]="risk() === 'expected'">Expected (measured lift)</option>
              </select>
            </label>
            <label class="field">
              Most offers
              <input type="text" inputmode="numeric" autocomplete="off" placeholder="no limit" [value]="maxOffers()" (input)="maxOffers.set(value($event))" />
            </label>
          </div>
          @if (sites().length > 0) {
            <details>
              <summary>Site limits (optional)</summary>
              <div class="table-wrap">
                <table class="data sites">
                  <thead>
                    <tr><th scope="col">Site</th><th scope="col">Spend at most</th><th scope="col">Spend at least</th></tr>
                  </thead>
                  <tbody>
                    @for (s of sites(); track s.siteId) {
                      <tr>
                        <th scope="row">{{ s.name }}</th>
                        <td><input type="text" inputmode="decimal" autocomplete="off" placeholder="no cap" [attr.aria-label]="'Spend at most at ' + s.name"
                          [value]="caps()[s.siteId] ?? ''" (input)="setLimit(caps, s.siteId, value($event))" /></td>
                        <td><input type="text" inputmode="decimal" autocomplete="off" placeholder="no floor" [attr.aria-label]="'Spend at least at ' + s.name"
                          [value]="floors()[s.siteId] ?? ''" (input)="setLimit(floors, s.siteId, value($event))" /></td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </details>
          }
          <div class="row actions">
            <button type="submit" class="btn primary" [disabled]="running() || enabled() === false || formError() !== null">
              {{ running() ? 'Planning…' : 'Plan offers' }}
            </button>
            @if (formError(); as e) {
              <span class="bad" role="alert">{{ e }}</span>
            } @else if (running()) {
              <span class="note" role="status">Solving; this usually takes under a minute.</span>
            }
          </div>
        </form>
      </section>

      @if (runProblem(); as p) {
        @if (p.status === 400) {
          <p class="card" role="alert"><strong>The optimizer refused the plan.</strong> {{ p.detail }}</p>
        } @else {
          <app-error-panel [problem]="p" (retry)="plan()" />
        }
      }

      @if (result(); as d) {
        @let r = d.run;
        <section aria-labelledby="rx-result">
          <h2 id="rx-result" class="section-title">
            Plan {{ r.runId.slice(5) }} · {{ r.status }}
            <span class="note">budget {{ money(r.params.budget) }}, {{ share(r.params.holdout) }} holdout, {{ r.params.risk }}</span>
          </h2>
          <div class="kpi-grid">
            <app-kpi-tile metric="rxPlanProfit" [value]="money(r.profit)" [sub]="'vs ' + money(r.baseline.profit) + ' for last period\\'s mix'" />
            <app-kpi-tile metric="rxPlanSpend" [value]="money(r.spend)" [sub]="share(r.params.budget > 0 ? r.spend / r.params.budget : null) + ' of budget'" />
            <app-kpi-tile metric="rxPlanOffers" [value]="fmt(r.offers)" [sub]="fmt(r.holdoutPatrons) + ' held out to measure it'" />
            <app-kpi-tile metric="rxBaseline" [value]="money(r.baseline.profit)" [sub]="fmt(r.baseline.offers) + ' offers, ' + money(r.baseline.spend)" />
          </div>
        </section>

        <div class="grid-2">
          <section class="card" aria-labelledby="rx-limits">
            <div class="card-head">
              <div>
                <h2 id="rx-limits">What limits the plan</h2>
                <div class="card-sub">
                  A binding limit is used up; its value is the expected profit one more unit would add. Comp room nights are a quarter
                  of each hotel's unsold rooms over the last 28 nights, for a 30-day period.
                </div>
              </div>
            </div>
            <div class="table-wrap">
              <table class="data">
                <thead>
                  <tr><th scope="col">Limit</th><th scope="col" class="num">Allowed</th><th scope="col" class="num">Used</th><th scope="col">Value of one more</th></tr>
                </thead>
                <tbody>
                  @for (c of constraints(); track c.kind + c.name) {
                    <tr>
                      <th scope="row">{{ limitName(c) }} @if (c.binding) {<span class="tag warn">binding</span>}</th>
                      <td class="num">{{ unit(c, c.limit) }}</td>
                      <td class="num">{{ c.used === null ? '–' : unit(c, c.used) }}</td>
                      <td>
                        @if (c.binding && c.shadowPrice !== null) {
                          {{ cents(c.shadowPrice) }} <span class="extra">{{ unitLabel[c.kind] }}</span>
                        } @else {
                          <span class="extra">not limiting</span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>

          <section class="card" aria-labelledby="rx-skipped">
            <div class="card-head">
              <div>
                <h2 id="rx-skipped">Not funded</h2>
                <div class="card-sub">Offers left out and why. Funding an effect too small to measure tends to overstate it.</div>
              </div>
            </div>
            <ul class="skipped">
              @for (g of skipped(); track g.templateId + g.reason) {
                <li>
                  <strong>{{ g.templateId }}</strong>
                  @if (g.segments.length) { · {{ g.segments.join(', ') }} }
                  @if (g.sites) { · {{ g.sites === 1 ? '1 site' : g.sites + ' sites' }} }
                  @if (g.eligible) { <span class="extra">{{ fmt(g.eligible) }} eligible</span> }
                  <div class="extra">{{ g.reason }}</div>
                </li>
              } @empty {
                <li class="extra">Every offer with eligible patrons was considered.</li>
              }
            </ul>
          </section>
        </div>

        <section class="card" aria-labelledby="rx-alloc">
          <div class="card-head">
            <div>
              <h2 id="rx-alloc">Planned offers</h2>
              <div class="card-sub">Offer × patron segment × home site. Value per offer is the expected change in net contribution.</div>
            </div>
          </div>
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th scope="col">Offer</th><th scope="col">Segment</th><th scope="col">Site</th>
                  <th scope="col" class="num">Eligible</th><th scope="col" class="num">Offers</th>
                  <th scope="col" class="num">Cost each</th><th scope="col" class="num">Value each</th>
                  <th scope="col" class="num">Spend</th><th scope="col" class="num">Profit</th><th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                @for (a of allocation(); track a.templateId + a.segment + a.siteId) {
                  <tr>
                    <th scope="row">{{ a.templateId }}</th>
                    <td>{{ a.segment }}</td>
                    <td>{{ siteName(a.siteId) }}</td>
                    <td class="num">{{ fmt(a.eligible) }}</td>
                    <td class="num">{{ fmt(a.offers) }}</td>
                    <td class="num">{{ cents(a.costPerOffer) }}</td>
                    <td class="num">{{ cents(a.valuePerOffer) }}</td>
                    <td class="num">{{ money(a.spend) }}</td>
                    <td class="num">{{ money(a.profit) }}</td>
                    <td class="extra">{{ a.reason }} · {{ sourceLabel(a.responseSource) }}</td>
                  </tr>
                } @empty {
                  <tr><td colspan="10" class="note">Nothing worth funding within these limits.</td></tr>
                }
              </tbody>
            </table>
          </div>
          @if (d.allocation.length > allocation().length) {
            <button type="button" class="btn" (click)="showAll.set(true)">Show all {{ fmt(d.allocation.length) }} rows</button>
          }
        </section>
      }

      <section class="card" aria-labelledby="rx-runs">
        <div class="card-head">
          <div>
            <h2 id="rx-runs">Past plans</h2>
            <div class="card-sub">Every run is kept, with who asked and the limits used.</div>
          </div>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th scope="col">Run</th><th scope="col">Asked by</th><th scope="col" class="num">Budget</th>
                <th scope="col" class="num">Spend</th><th scope="col" class="num">Expected profit</th><th scope="col" class="num">Offers</th>
              </tr>
            </thead>
            <tbody>
              @for (r of runs(); track r.runId) {
                <tr [class.picked]="r.runId === result()?.run?.runId">
                  <th scope="row"><button type="button" class="link" (click)="open(r.runId)">{{ when(r.createdAt) }}</button></th>
                  <td class="mono">{{ r.requestedBy ?? '–' }}</td>
                  <td class="num">{{ money(r.params.budget) }}</td>
                  <td class="num">{{ money(r.spend) }}</td>
                  <td class="num">{{ money(r.profit) }}</td>
                  <td class="num">{{ fmt(r.offers) }}</td>
                </tr>
              } @empty {
                <tr><td colspan="6" class="note">No plans yet.</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `,
  styles: `
    .plan { display: grid; gap: 12px; }
    .row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 16px; }
    .row .field input { width: 14ch; font-variant-numeric: tabular-nums; }
    .actions { align-items: center; }
    .sites input { width: 12ch; font-variant-numeric: tabular-nums; }
    summary { cursor: pointer; font-size: 0.88rem; color: var(--ink2); }
    .bad { color: var(--bad); font-size: 0.85rem; }
    .section-title { font-size: 1rem; margin: 4px 0 10px; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
    .extra { color: var(--mute); font-size: 0.8rem; }
    .skipped { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; font-size: 0.85rem; }
    .link { all: unset; cursor: pointer; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; }
    .link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
    tr.picked > * { background: color-mix(in srgb, var(--accent) 7%, transparent); }
  `,
})
export class RxOptimizerPage {
  private readonly api = inject(RxApi);
  private readonly context = inject(RxContext);
  private readonly destroyRef = inject(DestroyRef);

  private readonly runList = loadRx(() => this.api.runs());
  protected readonly runs = computed(() => {
    const s = this.runList.state();
    return s.status === 'ready' ? s.data : [];
  });
  protected readonly enabled = computed(() => this.context.meta()?.optimizerEnabled ?? null);
  protected readonly sites = computed(() => this.context.meta()?.sites ?? []);

  protected readonly holdouts = ['0', '0.05', '0.1', '0.15', '0.2'];
  protected readonly budget = signal('250,000');
  protected readonly holdout = signal('0.1');
  protected readonly risk = signal<'conservative' | 'expected'>('conservative');
  protected readonly maxOffers = signal('');
  protected readonly caps = signal<Record<string, string>>({});
  protected readonly floors = signal<Record<string, string>>({});

  /** The request, or what's wrong with the form. */
  private readonly request = computed<RxRunRequest | string>(() => {
    const budget = amount(this.budget());
    if (budget === null || !(budget > 0) || budget > 50_000_000) return 'Enter a budget above $0 and at most $50M.';
    const max = this.maxOffers().trim().replace(/,/g, '');
    if (max && !/^[1-9]\d{0,6}$/.test(max)) return 'Most offers must be a whole number.';
    const limits = (typed: Record<string, string>, what: string): Record<string, number> | string => {
      const out: Record<string, number> = {};
      for (const [site, raw] of Object.entries(typed)) {
        const v = amount(raw);
        if (v === null) continue;
        if (Number.isNaN(v)) return `${what} for ${this.context.siteName(site)} isn't a dollar amount.`;
        out[site] = v;
      }
      return out;
    };
    const caps = limits(this.caps(), 'Spend at most');
    if (typeof caps === 'string') return caps;
    const floors = limits(this.floors(), 'Spend at least');
    if (typeof floors === 'string') return floors;
    for (const [site, floor] of Object.entries(floors)) {
      if (caps[site] !== undefined && caps[site]! < floor) return `${this.context.siteName(site)}: the floor is above the cap.`;
    }
    if (Object.values(floors).reduce((a, v) => a + v, 0) > budget) return 'Site floors add up to more than the budget.';
    return { budget, holdout: Number(this.holdout()), risk: this.risk(), caps, floors, maxOffers: max ? Number(max) : null };
  });
  protected readonly formError = computed(() => {
    const r = this.request();
    return typeof r === 'string' ? r : null;
  });

  protected readonly run = signal<Run>({ status: 'idle' });
  protected readonly running = computed(() => this.run().status === 'running');
  protected readonly result = computed(() => {
    const r = this.run();
    return r.status === 'ready' ? r.detail : null;
  });
  protected readonly runProblem = computed(() => {
    const r = this.run();
    return r.status === 'error' ? r.problem : null;
  });

  /** Binding limits first, then by kind. */
  protected readonly constraints = computed(() =>
    [...(this.result()?.run.constraints ?? [])].sort((a, b) => Number(b.binding ?? false) - Number(a.binding ?? false)),
  );
  /** One line per offer and reason, not per segment x site cell. */
  protected readonly skipped = computed(() => {
    const groups = new Map<string, { templateId: string; reason: string; segments: string[]; siteIds: Set<string>; eligible: number }>();
    for (const s of this.result()?.run.skipped ?? []) {
      const key = `${s.templateId}|${s.reason}`;
      const g = groups.get(key) ?? { templateId: s.templateId, reason: s.reason, segments: [], siteIds: new Set<string>(), eligible: 0 };
      if (s.segment && !g.segments.includes(s.segment)) g.segments.push(s.segment);
      if (s.siteId) g.siteIds.add(s.siteId);
      g.eligible += s.eligible ?? 0;
      groups.set(key, g);
    }
    return [...groups.values()].map(({ siteIds, ...g }) => ({ ...g, sites: siteIds.size }));
  });
  protected readonly showAll = signal(false);
  protected readonly allocation = computed(() => {
    const rows = this.result()?.allocation ?? [];
    return this.showAll() ? rows : rows.slice(0, 25);
  });

  protected readonly fmt = fmtInt;
  protected readonly money = fmtMoney;
  protected readonly share = fmtShare;
  protected readonly unitLabel = UNIT_LABEL;
  protected readonly siteName = (id: string) => this.context.siteName(id);
  /** Which measured lift the value rests on: the segment's own, or the whole campaign's. */
  protected readonly sourceLabel = (s: string) => (s === 'all' ? 'campaign-wide lift' : `${s} segment lift`);
  protected readonly value = (e: Event) => (e.target as HTMLInputElement | HTMLSelectElement).value;
  protected cents(v: number): string {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
  }
  protected unit(c: RxConstraint, v: number): string {
    return c.unit === 'USD' ? fmtMoney(v) : fmtInt(Math.round(v));
  }
  protected limitName(c: RxConstraint): string {
    const site = this.context.siteName(c.name);
    switch (c.kind) {
      case 'budget': return 'Enterprise budget';
      case 'max_offers': return 'Offers in the plan';
      case 'site_cap': return `Spend at ${site}, at most`;
      case 'site_floor': return `Spend at ${site}, at least`;
      case 'patrons': return `Patrons homed at ${site}`;
      case 'room_nights': return `Comp room nights at ${site}`;
    }
  }
  protected when(iso: string): string {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  protected setLimit(target: typeof this.caps, siteId: string, raw: string): void {
    target.update((m) => ({ ...m, [siteId]: raw }));
  }

  protected plan(): void {
    const request = this.request();
    if (typeof request === 'string' || this.running()) return;
    this.run.set({ status: 'running', started: Date.now() });
    this.showAll.set(false);
    const sub = this.api.plan(request).subscribe({
      next: (envelope) => {
        this.run.set({ status: 'ready', detail: envelope.data, fresh: true });
        this.runList.reload();
      },
      error: (err: unknown) => this.run.set({ status: 'error', problem: toProblem(err) }),
    });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }

  protected open(runId: string): void {
    this.showAll.set(false);
    const sub = this.api.run(runId).subscribe({
      next: (envelope) => this.run.set({ status: 'ready', detail: envelope.data, fresh: false }),
      error: (err: unknown) => this.run.set({ status: 'error', problem: toProblem(err) }),
    });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }
}
