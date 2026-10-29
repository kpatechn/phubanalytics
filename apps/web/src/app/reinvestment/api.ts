import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  RxCampaignDetail,
  RxEnvelope,
  RxOverview,
  RxPatron,
  RxPatronExample,
  RxRun,
  RxRunDetail,
  RxRunRequest,
} from '@phub/contracts';

/** Reinvestment endpoints. Patron IDs go in request bodies only, never in URLs. */
@Injectable({ providedIn: 'root' })
export class RxApi {
  private readonly http = inject(HttpClient);

  overview(): Observable<RxEnvelope<RxOverview>> {
    return this.http.get<RxEnvelope<RxOverview>>('/api/reinvestment/overview');
  }

  campaign(id: string): Observable<RxEnvelope<RxCampaignDetail>> {
    return this.http.get<RxEnvelope<RxCampaignDetail>>(`/api/reinvestment/campaigns/${encodeURIComponent(id)}`);
  }

  patronExamples(): Observable<RxEnvelope<RxPatronExample[]>> {
    return this.http.get<RxEnvelope<RxPatronExample[]>>('/api/reinvestment/patrons/examples');
  }

  patron(patronId: string): Observable<RxEnvelope<RxPatron>> {
    return this.http.post<RxEnvelope<RxPatron>>('/api/reinvestment/patrons/lookup', { patronId });
  }

  runs(): Observable<RxEnvelope<RxRun[]>> {
    return this.http.get<RxEnvelope<RxRun[]>>('/api/reinvestment/optimizer/runs');
  }

  run(runId: string): Observable<RxEnvelope<RxRunDetail>> {
    return this.http.get<RxEnvelope<RxRunDetail>>(`/api/reinvestment/optimizer/runs/${encodeURIComponent(runId)}`);
  }

  plan(request: RxRunRequest): Observable<RxEnvelope<RxRunDetail>> {
    return this.http.post<RxEnvelope<RxRunDetail>>('/api/reinvestment/optimizer/runs', request);
  }
}
