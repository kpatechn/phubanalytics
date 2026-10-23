import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { CdpEnvelope, CdpExample, CdpMeta, CdpPlayer, CdpSegmentsData, CdpSitesData } from '@phub/contracts';

/** Chickasaw CDP endpoints. Account numbers go in request bodies only, never in URLs. */
@Injectable({ providedIn: 'root' })
export class CdpApi {
  private readonly http = inject(HttpClient);

  meta(): Observable<CdpMeta> {
    return this.http.get<CdpMeta>('/api/cdp/meta');
  }

  segments(): Observable<CdpEnvelope<CdpSegmentsData>> {
    return this.http.get<CdpEnvelope<CdpSegmentsData>>('/api/cdp/segments');
  }

  sites(): Observable<CdpEnvelope<CdpSitesData>> {
    return this.http.get<CdpEnvelope<CdpSitesData>>('/api/cdp/sites');
  }

  examples(segment: string): Observable<CdpEnvelope<CdpExample[]>> {
    return this.http.get<CdpEnvelope<CdpExample[]>>('/api/cdp/players/examples', { params: new HttpParams({ fromObject: { segment } }) });
  }

  lookup(accountNumber: string): Observable<CdpEnvelope<CdpPlayer>> {
    return this.http.post<CdpEnvelope<CdpPlayer>>('/api/cdp/players/lookup', { accountNumber });
  }
}
