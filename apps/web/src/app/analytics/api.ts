import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { Envelope, Property, View } from '@phub/contracts';

export interface SummaryQuery {
  property: number;
  from: string;
  to: string;
}

@Injectable({ providedIn: 'root' })
export class AnalyticsApi {
  private readonly http = inject(HttpClient);

  properties(): Observable<Property[]> {
    return this.http.get<Property[]>('/api/analytics/properties');
  }

  view<T>(view: View, query: SummaryQuery): Observable<Envelope<T>> {
    const params = new HttpParams({ fromObject: { property: query.property, from: query.from, to: query.to } });
    return this.http.get<Envelope<T>>(`/api/analytics/${view}`, { params });
  }
}
