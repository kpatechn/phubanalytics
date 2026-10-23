import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import type { CdpChannel, CdpExample, Problem } from '@phub/contracts';
import { fmtInt, fmtMoney, fmtPct } from '../analytics/format';
import { toProblem } from '../core/problem';
import { KpiTile } from '../shared/kpi-tile';
import { ErrorPanel, Skeleton } from '../shared/page-state';
import { CdpApi } from './api';
import { CdpContext } from './context';
import { loadCdp } from './load';

export const CHANNEL_LABEL: Record<CdpChannel, string> = { email: 'Email', sms: 'SMS', push: 'Push', mail: 'Mail' };

type Examples =
  | { status: 'idle' }
  | { status: 'loading'; segment: string }
  | { status: 'ready'; segment: string; rows: CdpExample[] }
  | { status: 'error'; segment: string; problem: Problem };

@Component({
  selector: 'app-cdp-segments-page',
  imports: [KpiTile, ErrorPanel, Skeleton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './segments.html',
  styles: `
    .desc { color: var(--mute); font-size: 0.8rem; margin-top: 2px; max-width: 34ch; }
    .extra { color: var(--mute); font-weight: 400; }
    tr.examples > td { background: var(--grid); }
    .rule { font-size: 0.8rem; color: var(--ink2); margin-bottom: 8px; }
    .rule span { color: var(--mute); margin-right: 4px; }
    table.inner { width: auto; min-width: 420px; }
  `,
})
export class CdpSegmentsPage {
  private readonly api = inject(CdpApi);
  private readonly context = inject(CdpContext);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  private readonly loader = loadCdp(() => this.api.segments());
  protected readonly data = computed(() => {
    const s = this.loader.state();
    return s.status === 'ready' ? s.envelope.data : null;
  });
  protected readonly problem = computed(() => {
    const s = this.loader.state();
    return s.status === 'error' ? s.problem : null;
  });

  protected readonly channelLabel = CHANNEL_LABEL;
  protected readonly fmt = fmtInt;
  protected readonly money = fmtMoney;
  protected readonly pct = fmtPct;
  protected readonly siteName = (code: string | null) => this.context.siteName(code);

  protected readonly examples = signal<Examples>({ status: 'idle' });
  protected readonly openSegment = computed(() => {
    const e = this.examples();
    return e.status === 'idle' ? null : e.segment;
  });
  protected readonly exampleRows = computed(() => {
    const e = this.examples();
    return e.status === 'ready' ? e.rows : null;
  });

  protected reload(): void {
    this.loader.reload();
  }

  protected toggle(segment: string): void {
    if (this.openSegment() === segment) this.examples.set({ status: 'idle' });
    else this.loadExamples(segment);
  }

  protected loadExamples(segment: string): void {
    this.examples.set({ status: 'loading', segment });
    const sub = this.api.examples(segment).subscribe({
      next: (envelope) => {
        if (this.openSegment() === segment) this.examples.set({ status: 'ready', segment, rows: envelope.data });
      },
      error: (err: unknown) => {
        if (this.openSegment() === segment) this.examples.set({ status: 'error', segment, problem: toProblem(err) });
      },
    });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }

  /** Hands the number to Player 360 in memory, so it never lands in the URL. */
  protected openPlayer(accountNumber: string): void {
    this.context.pickedAccount.set(accountNumber);
    void this.router.navigate(['../player'], { relativeTo: this.route });
  }
}
