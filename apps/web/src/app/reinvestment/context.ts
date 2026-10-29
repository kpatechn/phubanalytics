import { Injectable, computed, signal } from '@angular/core';
import type { RxMeta } from '@phub/contracts';

/** What every reinvestment page shares: the tenant's meta, and the patron handed to Player 360. */
@Injectable({ providedIn: 'root' })
export class RxContext {
  readonly meta = signal<RxMeta | null>(null);
  /** Patron picked on another page. Memory only: never the URL or storage. */
  readonly pickedPatron = signal<string | null>(null);

  private readonly names = computed(() => new Map((this.meta()?.sites ?? []).map((s) => [s.siteId, s.name])));

  siteName(siteId: string | null): string {
    if (!siteId) return '–';
    return this.names().get(siteId) ?? siteId;
  }

  /** Site name for a property code ('1' -> 'Y:1' -> name). */
  propertyName(propertyId: string | null): string {
    if (!propertyId) return '–';
    const site = (this.meta()?.sites ?? []).find((s) => s.siteId.endsWith(`:${propertyId}`));
    return site?.name ?? propertyId;
  }
}
