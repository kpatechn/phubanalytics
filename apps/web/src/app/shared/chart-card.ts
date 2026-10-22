import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';

export interface TableColumn {
  key: string;
  label: string;
  numeric?: boolean;
}

export type TableRow = Record<string, string | number>;

/** Card with a title, a chart (projected) and a "View as table" toggle showing the same numbers. */
@Component({
  selector: 'app-chart-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" [attr.aria-label]="heading()">
      <div class="card-head">
        <div>
          <h2>{{ heading() }}</h2>
          @if (sub()) {
            <div class="card-sub">{{ sub() }}</div>
          }
        </div>
        @if (rows().length > 0) {
          <button type="button" class="btn" [attr.aria-pressed]="asTable()" (click)="asTable.set(!asTable())">
            {{ asTable() ? 'View as chart' : 'View as table' }}
          </button>
        }
      </div>
      @if (asTable()) {
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>@for (c of columns(); track c.key) {<th [class.num]="c.numeric" scope="col">{{ c.label }}</th>}</tr>
            </thead>
            <tbody>
              @for (r of rows(); track $index) {
                <tr>@for (c of columns(); track c.key) {<td [class.num]="c.numeric">{{ r[c.key] }}</td>}</tr>
              }
            </tbody>
          </table>
        </div>
      } @else {
        <ng-content />
      }
      <ng-content select="[card-foot]" />
    </section>
  `,
})
export class ChartCard {
  readonly heading = input.required<string>();
  readonly sub = input<string>('');
  readonly columns = input<TableColumn[]>([]);
  readonly rows = input<TableRow[]>([]);
  protected readonly asTable = signal(false);
}
