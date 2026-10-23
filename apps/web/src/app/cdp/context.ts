import { Injectable, computed, signal } from '@angular/core';
import type { CdpMeta, Problem } from '@phub/contracts';

/** What every CDP page shares: the meta (window, feeds, sites) and the player picked for Player 360. */
@Injectable({ providedIn: 'root' })
export class CdpContext {
  readonly meta = signal<CdpMeta | null>(null);
  readonly problem = signal<Problem | null>(null);
  /** Club Passport number handed to Player 360 from another page. Memory only: never the URL or storage. */
  readonly pickedAccount = signal<string | null>(null);

  private readonly siteNames = computed(() => new Map((this.meta()?.sites ?? []).map((s) => [s.code, s.name])));

  siteName(code: string | null): string {
    if (!code) return '–';
    return this.siteNames().get(code) ?? code;
  }
}
