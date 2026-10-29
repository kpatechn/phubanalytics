import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { RxSiteMonth } from '@phub/contracts';
import { fmtInt, fmtMoney, fmtShare } from '../analytics/format';
import { ChartCard, type TableColumn, type TableRow } from '../shared/chart-card';
import { ChartDirective, baseChart, type ChartBuilder } from '../shared/chart.directive';
import { KpiTile } from '../shared/kpi-tile';
import { ErrorPanel, Skeleton } from '../shared/page-state';
import { RxApi } from './api';
import { loadRx } from './load';

interface SiteRow {
  siteId: string;
  name: string;
  patrons: number;
  theo: number;
  reinvestment: number;
  netContribution: number;
  hospitalityPaid: number;
}

/** Command center: what the enterprise reinvests, by site and month, and what it measurably returns. */
@Component({
  selector: 'app-rx-overview-page',
  imports: [KpiTile, ChartCard, ChartDirective, ErrorPanel, Skeleton, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      @if (problem(); as p) {
        <app-error-panel [problem]="p" (retry)="loader.reload()" />
      } @else if (data(); as d) {
        <div class="kpi-grid">
          <app-kpi-tile metric="rxReinvestment" [value]="money(totals().reinvestment)" sub="last 12 months, at face" />
          <app-kpi-tile metric="rxReinvestmentRate" [value]="share(totals().rate)" sub="of theo" />
          <app-kpi-tile metric="rxNetContribution" [value]="money(totals().netContribution)" sub="last 12 months" />
          <app-kpi-tile metric="rxIncrementalProfit" [value]="money(measured().profit)" [sub]="measured().closed + ' closed campaigns'" />
          <app-kpi-tile metric="rxCampaignsPaying" [value]="measured().paying + ' of ' + measured().closed"
            [sub]="measured().losing + ' lose money, ' + measured().unclear + ' unclear'" />
        </div>

        <div class="grid-2">
          <app-chart-card heading="Reinvestment and net contribution by site" sub="Last 12 months" [columns]="siteColumns" [rows]="siteTable()">
            <div class="chart" [appChart]="siteChart()" chartLabel="Reinvestment and net contribution for each site over the last 12 months"></div>
          </app-chart-card>
          <app-chart-card heading="Every site, month by month" sub="Reinvestment against net contribution" [columns]="monthColumns" [rows]="monthTable()">
            <div class="chart" [appChart]="monthChart()" chartLabel="Monthly reinvestment and net contribution across all sites"></div>
          </app-chart-card>
        </div>

        <section class="card" aria-labelledby="rx-sites">
          <div class="card-head">
            <div>
              <h2 id="rx-sites">Sites, last 12 months</h2>
              <div class="card-sub">Known patrons only. Return = net contribution per reinvested dollar; it is not incremental (see Offer effectiveness).</div>
            </div>
          </div>
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th scope="col">Site</th>
                  <th scope="col" class="num">Patrons, busiest month</th>
                  <th scope="col" class="num">Theo</th>
                  <th scope="col" class="num">Reinvestment</th>
                  <th scope="col" class="num">Rate</th>
                  <th scope="col" class="num">Hospitality paid</th>
                  <th scope="col" class="num">Net contribution</th>
                  <th scope="col" class="num">Return</th>
                </tr>
              </thead>
              <tbody>
                @for (s of sites(); track s.siteId) {
                  <tr>
                    <th scope="row">{{ s.name }}</th>
                    <td class="num">{{ int(s.patrons) }}</td>
                    <td class="num">{{ money(s.theo) }}</td>
                    <td class="num">{{ money(s.reinvestment) }}</td>
                    <td class="num">{{ share(s.theo > 0 ? s.reinvestment / s.theo : null) }}</td>
                    <td class="num">{{ money(s.hospitalityPaid) }}</td>
                    <td class="num">{{ money(s.netContribution) }}</td>
                    <td class="num">{{ s.reinvestment > 0 ? (s.netContribution / s.reinvestment).toFixed(1) + '×' : '–' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="note">
            A high return here does not mean offers caused it: well-played patrons earn more comps. What offers cause is measured
            against holdouts on <a routerLink="../offers">Offer effectiveness</a>.
          </p>
        </section>
      } @else {
        <app-skeleton />
      }
    </div>
  `,
})
export class RxOverviewPage {
  private readonly api = inject(RxApi);
  protected readonly loader = loadRx(() => this.api.overview());
  protected readonly data = computed(() => {
    const s = this.loader.state();
    return s.status === 'ready' ? s.data : null;
  });
  protected readonly problem = computed(() => {
    const s = this.loader.state();
    return s.status === 'error' ? s.problem : null;
  });

  protected readonly money = fmtMoney;
  protected readonly int = fmtInt;
  protected readonly share = fmtShare;

  private readonly months = computed<RxSiteMonth[]>(() => this.data()?.months ?? []);

  protected readonly sites = computed<SiteRow[]>(() => {
    const by = new Map<string, SiteRow>();
    const patronsMax = new Map<string, number>();
    for (const m of this.months()) {
      const r = by.get(m.siteId) ?? { siteId: m.siteId, name: m.siteName, patrons: 0, theo: 0, reinvestment: 0, netContribution: 0, hospitalityPaid: 0 };
      r.theo += m.theo;
      r.reinvestment += m.reinvestment;
      r.netContribution += m.netContribution;
      r.hospitalityPaid += m.hospitalityPaid;
      // Monthly patron counts can't be summed (the same patron comes back), so the table shows the busiest month.
      patronsMax.set(m.siteId, Math.max(patronsMax.get(m.siteId) ?? 0, m.patrons));
      by.set(m.siteId, r);
    }
    for (const [id, r] of by) r.patrons = patronsMax.get(id) ?? 0;
    return [...by.values()].sort((a, b) => b.reinvestment - a.reinvestment);
  });

  protected readonly totals = computed(() => {
    const s = this.sites();
    const theo = s.reduce((a, r) => a + r.theo, 0);
    const reinvestment = s.reduce((a, r) => a + r.reinvestment, 0);
    return { reinvestment, netContribution: s.reduce((a, r) => a + r.netContribution, 0), rate: theo > 0 ? reinvestment / theo : null };
  });

  protected readonly measured = computed(() => {
    const closed = (this.data()?.campaigns ?? []).filter((c) => c.windowClosed);
    return {
      closed: closed.length,
      profit: closed.reduce((a, c) => a + (c.netIncrementalProfit ?? 0), 0),
      paying: closed.filter((c) => c.verdict === 'pays back').length,
      losing: closed.filter((c) => c.verdict === 'loses money').length,
      unclear: closed.filter((c) => c.verdict === 'no clear effect' || c.verdict === 'too small to read').length,
    };
  });

  protected readonly siteColumns: TableColumn[] = [
    { key: 'site', label: 'Site' },
    { key: 'reinvestment', label: 'Reinvestment', numeric: true },
    { key: 'net', label: 'Net contribution', numeric: true },
  ];
  protected readonly siteTable = computed<TableRow[]>(() =>
    this.sites().map((s) => ({ site: s.name, reinvestment: fmtMoney(s.reinvestment), net: fmtMoney(s.netContribution) })),
  );
  protected readonly siteChart = computed<ChartBuilder>(() => {
    const s = this.sites();
    return (t) => {
      const b = baseChart(t);
      return {
        grid: b.grid,
        tooltip: { ...b.tooltip, trigger: 'axis', valueFormatter: (v: unknown) => fmtMoney(Number(v)) },
        legend: b.legend,
        yAxis: { type: 'category', data: s.map((r) => r.name), inverse: true, ...b.categoryAxis },
        xAxis: { type: 'value', splitNumber: 3, ...b.valueAxis, axisLabel: { ...b.valueAxis.axisLabel, hideOverlap: true, formatter: (v: number) => fmtMoney(v) } },
        series: [
          { name: 'Reinvestment', type: 'bar', data: s.map((r) => Math.round(r.reinvestment)), color: t.ctx },
          { name: 'Net contribution', type: 'bar', data: s.map((r) => Math.round(r.netContribution)), color: t.accent },
        ],
      };
    };
  });

  private readonly monthly = computed(() => {
    const by = new Map<string, { reinvestment: number; net: number }>();
    for (const m of this.months()) {
      const r = by.get(m.month) ?? { reinvestment: 0, net: 0 };
      r.reinvestment += m.reinvestment;
      r.net += m.netContribution;
      by.set(m.month, r);
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
  });
  protected readonly monthColumns: TableColumn[] = [
    { key: 'month', label: 'Month' },
    { key: 'reinvestment', label: 'Reinvestment', numeric: true },
    { key: 'net', label: 'Net contribution', numeric: true },
  ];
  protected readonly monthTable = computed<TableRow[]>(() =>
    this.monthly().map(([month, v]) => ({ month: month.slice(0, 7), reinvestment: fmtMoney(v.reinvestment), net: fmtMoney(v.net) })),
  );
  protected readonly monthChart = computed<ChartBuilder>(() => {
    const rows = this.monthly();
    return (t) => {
      const b = baseChart(t);
      return {
        grid: b.grid,
        tooltip: { ...b.tooltip, trigger: 'axis', valueFormatter: (v: unknown) => fmtMoney(Number(v)) },
        legend: b.legend,
        xAxis: { type: 'category', data: rows.map(([m]) => m.slice(0, 7)), ...b.categoryAxis },
        yAxis: { type: 'value', ...b.valueAxis, axisLabel: { ...b.valueAxis.axisLabel, formatter: (v: number) => fmtMoney(v) } },
        series: [
          { name: 'Reinvestment', type: 'line', data: rows.map(([, v]) => Math.round(v.reinvestment)), color: t.ctx, symbol: 'none', lineStyle: { width: 2 } },
          { name: 'Net contribution', type: 'line', data: rows.map(([, v]) => Math.round(v.net)), color: t.accent, symbol: 'none', lineStyle: { width: 2 } },
        ],
      };
    };
  });
}
