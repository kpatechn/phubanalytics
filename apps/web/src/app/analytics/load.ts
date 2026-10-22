import { inject, type Signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { catchError, distinctUntilChanged, filter, map, of, startWith, switchMap, tap } from 'rxjs';
import type { Envelope, Problem, View } from '@phub/contracts';
import { toProblem } from '../core/problem';
import { AnalyticsApi } from './api';
import { Filters } from './filters';

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'ready'; envelope: Envelope<T> }
  | { status: 'error'; problem: Problem };

/**
 * Loads one view for the current filters. A filter change cancels the request
 * in flight. Call from a field initializer (needs an injection context).
 */
export function loadView<T>(view: View): Signal<LoadState<T>> {
  const api = inject(AnalyticsApi);
  const filters = inject(Filters);
  const states = toObservable(filters.query).pipe(
    filter((q) => q !== null),
    distinctUntilChanged((a, b) => a.property === b.property && a.from === b.from && a.to === b.to && a.tick === b.tick),
    switchMap((q) =>
      api.view<T>(view, q).pipe(
        tap((envelope) => filters.lastMeta.set(envelope.meta)),
        map((envelope): LoadState<T> => ({ status: 'ready', envelope })),
        catchError((err: unknown) => of<LoadState<T>>({ status: 'error', problem: toProblem(err) })),
        startWith<LoadState<T>>({ status: 'loading' }),
      ),
    ),
  );
  return toSignal(states, { initialValue: { status: 'loading' } });
}
