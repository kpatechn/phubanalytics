import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { Me, Problem } from '@phub/contracts';
import { toProblem } from './problem';

/** Who is signed in and which views they may open. Loaded once. */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly http = inject(HttpClient);
  private pending: Promise<Me | null> | null = null;

  readonly me = signal<Me | null>(null);
  readonly problem = signal<Problem | null>(null);

  load(): Promise<Me | null> {
    this.pending ??= firstValueFrom(this.http.get<Me>('/api/analytics/me')).then(
      (me) => {
        this.me.set(me);
        return me;
      },
      (err: unknown) => {
        this.problem.set(toProblem(err));
        this.pending = null;
        return null;
      },
    );
    return this.pending;
  }
}
