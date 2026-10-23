import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import type { CdpActivityKind, CdpExample, CdpPlayer, CdpReachReason, Problem } from '@phub/contracts';
import { fmtDate, fmtInt, fmtMoney, fmtShare, fmtTimestamp } from '../analytics/format';
import { toProblem } from '../core/problem';
import { BarList, type BarItem } from '../shared/bar-list';
import { KpiTile } from '../shared/kpi-tile';
import { ErrorPanel } from '../shared/page-state';
import { CdpApi } from './api';
import { CdpContext } from './context';
import { loadCdp } from './load';
import { CHANNEL_LABEL } from './segments';

const KIND_LABEL: Record<CdpActivityKind, string> = { gaming: 'Gaming', hotel: 'Hotel', dining: 'Dining', retail: 'Retail', spa: 'Spa', golf: 'Golf' };
const REASON_LABEL: Record<CdpReachReason, string> = {
  reachable: 'Reachable',
  self_excluded: 'Self-excluded',
  no_contact: 'No contact on file',
  opted_out: 'Opted out',
  no_consent: 'No consent recorded',
};
const IDENTIFIER_LABEL = { email: 'Email', mobile: 'Mobile number', app_user: 'App account' } as const;

type Lookup =
  | { status: 'idle' }
  | { status: 'loading'; accountNumber: string }
  | { status: 'ready'; player: CdpPlayer }
  | { status: 'error'; problem: Problem };

type Samples = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; rows: CdpExample[] } | { status: 'error' };

/** One player across every site. The number is typed or handed over in memory: never in the URL. */
@Component({
  selector: 'app-cdp-player-page',
  imports: [KpiTile, ErrorPanel, BarList],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './player.html',
  styles: `
    .search { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 16px; }
    .search .field input { width: 16ch; font-family: var(--mono); }
    .samples { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 0; padding: 0; list-style: none; }
    .who { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; }
    .who h2 { margin: 0; }
    .facts { color: var(--ink2); font-size: 0.85rem; }
    .tags { display: flex; flex-wrap: wrap; gap: 6px; }
    .rfm { display: flex; gap: 18px; font-size: 0.85rem; }
    .rfm strong { font-size: 1.3rem; font-variant-numeric: tabular-nums; margin-right: 4px; }
    .ok { color: var(--good); font-weight: 600; }
    .no { color: var(--mute); }
    .extra { color: var(--mute); }
  `,
})
export class CdpPlayerPage {
  private readonly api = inject(CdpApi);
  private readonly context = inject(CdpContext);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly query = signal('');
  protected readonly lookup = signal<Lookup>({ status: 'idle' });
  protected readonly player = computed(() => {
    const l = this.lookup();
    return l.status === 'ready' ? l.player : null;
  });
  protected readonly problem = computed(() => {
    const l = this.lookup();
    return l.status === 'error' ? l.problem : null;
  });

  private readonly segmentList = loadCdp(() => this.api.segments());
  protected readonly segments = computed(() => {
    const s = this.segmentList.state();
    return s.status === 'ready' ? s.envelope.data.segments.filter((x) => x.members > 0) : [];
  });
  protected readonly samples = signal<Samples>({ status: 'idle' });
  protected readonly sampleRows = computed(() => {
    const s = this.samples();
    return s.status === 'ready' ? s.rows : null;
  });

  protected readonly fmt = fmtInt;
  protected readonly money = fmtMoney;
  protected readonly share = fmtShare;
  protected readonly date = fmtDate;
  protected readonly kindLabel = KIND_LABEL;
  protected readonly reasonLabel = REASON_LABEL;
  protected readonly channelLabel = CHANNEL_LABEL;
  protected readonly siteName = (code: string | null) => this.context.siteName(code);
  protected readonly when = (iso: string | null) => (iso ? fmtTimestamp(iso, 'America/Chicago') : '–');
  protected readonly count = (n: number, noun: string) => `${fmtInt(n)} ${noun}${n === 1 ? '' : 's'}`;

  protected readonly onFile = computed(() => {
    const ids = this.player()?.identifiers ?? [];
    return ids.length ? ids.map((i) => `${IDENTIFIER_LABEL[i.type]}${i.verified ? ' (verified)' : ''}`).join(', ') : 'nothing';
  });

  protected readonly nonGamingBars = computed<BarItem[]>(() => {
    const p = this.player()?.profile;
    if (!p) return [];
    return (['hotel', 'dining', 'retail', 'spa', 'golf'] as const)
      .filter((k) => p.nonGaming[k] > 0)
      .map((k) => ({ label: KIND_LABEL[k], value: Math.round(p.nonGaming[k]) }));
  });

  constructor() {
    const picked = this.context.pickedAccount();
    if (picked) {
      this.context.pickedAccount.set(null);
      this.find(picked);
    }
  }

  protected find(raw: string): void {
    const accountNumber = raw.trim();
    this.query.set(accountNumber);
    if (!/^\d{1,12}$/.test(accountNumber)) {
      this.lookup.set({ status: 'error', problem: { type: 'about:blank', title: 'Not a Club Passport number', status: 400, detail: 'Use digits only, up to 12.' } });
      return;
    }
    this.lookup.set({ status: 'loading', accountNumber });
    const sub = this.api.lookup(accountNumber).subscribe({
      next: (envelope) => this.lookup.set({ status: 'ready', player: envelope.data }),
      error: (err: unknown) => this.lookup.set({ status: 'error', problem: toProblem(err) }),
    });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }

  protected sample(segment: string): void {
    if (!segment) {
      this.samples.set({ status: 'idle' });
      return;
    }
    this.samples.set({ status: 'loading' });
    const sub = this.api.examples(segment).subscribe({
      next: (envelope) => this.samples.set({ status: 'ready', rows: envelope.data }),
      error: () => this.samples.set({ status: 'error' }),
    });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }
}
