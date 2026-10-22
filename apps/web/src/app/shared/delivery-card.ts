import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { Delivery } from '@phub/contracts';
import { fmtDay, fmtInt, fmtPct } from '../analytics/format';
import { BarList, type BarItem } from './bar-list';
import { ChartCard, type TableColumn } from './chart-card';
import { ChartDirective, baseChart, type ChartBuilder } from './chart.directive';

/** Outbound message delivery: by message type, why sends fail, and (optionally) per day. */
@Component({
  selector: 'app-delivery-card',
  imports: [BarList, ChartCard, ChartDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="grid-2">
      <section class="card" aria-labelledby="dl-types">
        <div class="card-head">
          <div>
            <h2 id="dl-types">Message delivery</h2>
            <div class="card-sub">Every send the platform attempted: {{ fmt(total().sent) }} sends, {{ failRate() }} failed</div>
          </div>
        </div>
        @if (delivery().byType.length === 0) {
          <p class="note">No sends in this period.</p>
        } @else {
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr><th scope="col">Message type</th><th scope="col" class="num">Sent</th><th scope="col" class="num">Delivered</th><th scope="col" class="num">Failed</th><th scope="col" class="num">Failed %</th></tr>
              </thead>
              <tbody>
                @for (t of delivery().byType; track t.messageType) {
                  <tr>
                    <td class="mono">{{ t.messageType }}</td>
                    <td class="num">{{ fmt(t.sent) }}</td>
                    <td class="num">{{ fmt(t.delivered) }}</td>
                    <td class="num">{{ fmt(t.failed) }}</td>
                    <td class="num">
                      @if (t.sent > 0 && t.failed / t.sent >= 0.5) {
                        <span class="tag bad"><span aria-hidden="true">✕</span> {{ pct(t.failed, t.sent) }}</span>
                      } @else {
                        {{ pct(t.failed, t.sent) }}
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <section class="card" aria-labelledby="dl-reasons">
        <div class="card-head"><div><h2 id="dl-reasons">Why sends fail</h2><div class="card-sub">Top 10 reasons; tokens, IDs and card numbers removed</div></div></div>
        <app-bar-list [items]="reasons()" empty="No failed sends in this period." />
      </section>
    </div>

    @if (showDaily()) {
      <app-chart-card heading="Sends per day" sub="Delivered, failed and pending" [columns]="dailyColumns" [rows]="dailyRows()">
        <div class="chart" [appChart]="dailyChart()" chartLabel="Stacked bar chart of delivered, failed and pending sends per day"></div>
      </app-chart-card>
    }
  `,
  styles: `:host { display: grid; gap: 16px; }`,
})
export class DeliveryCard {
  readonly delivery = input.required<Delivery>();
  readonly showDaily = input(false);

  protected readonly fmt = fmtInt;
  protected readonly pct = fmtPct;

  protected readonly total = computed(() => ({
    sent: this.delivery().byType.reduce((n, t) => n + t.sent, 0),
    failed: this.delivery().byType.reduce((n, t) => n + t.failed, 0),
  }));
  protected readonly failRate = computed(() => fmtPct(this.total().failed, this.total().sent));
  protected readonly reasons = computed<BarItem[]>(() => this.delivery().reasons.map((r) => ({ label: r.reason, value: r.count })));

  protected readonly dailyChart = computed<ChartBuilder>(() => {
    const days = this.delivery().daily;
    return (t) => {
      const b = baseChart(t);
      return {
        grid: b.grid,
        tooltip: { ...b.tooltip, axisPointer: { type: 'shadow' } },
        legend: b.legend,
        xAxis: { type: 'category', data: days.map((d) => fmtDay(d.day)), ...b.categoryAxis },
        yAxis: { type: 'value', minInterval: 1, ...b.valueAxis },
        series: [
          { name: 'Delivered', type: 'bar', stack: 'sends', data: days.map((d) => d.delivered), color: t.accent, barMaxWidth: 16 },
          { name: 'Failed', type: 'bar', stack: 'sends', data: days.map((d) => d.failed), color: t.bad, barMaxWidth: 16 },
          { name: 'Pending / other', type: 'bar', stack: 'sends', data: days.map((d) => d.other), color: t.ctx, barMaxWidth: 16 },
        ],
      };
    };
  });
  protected readonly dailyColumns: TableColumn[] = [
    { key: 'day', label: 'Day' },
    { key: 'delivered', label: 'Delivered', numeric: true },
    { key: 'failed', label: 'Failed', numeric: true },
    { key: 'other', label: 'Pending / other', numeric: true },
  ];
  protected readonly dailyRows = computed(() =>
    this.delivery().daily.map((d) => ({ day: fmtDay(d.day), delivered: fmtInt(d.delivered), failed: fmtInt(d.failed), other: fmtInt(d.other) })),
  );
}
