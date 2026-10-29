import { inject, signal, type Signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { catchError, map, of, startWith, switchMap, tap, type Observable } from 'rxjs';
import type { Problem, RxEnvelope } from '@phub/contracts';
import { toProblem } from '../core/problem';
import { RxContext } from './context';

export type RxState<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; problem: Problem };

/** Loads one reinvestment endpoint (again on every reload()) and shares its meta. Field initializer only. */
export function loadRx<T>(request: () => Observable<RxEnvelope<T>>): { state: Signal<RxState<T>>; reload: () => void } {
  const context = inject(RxContext);
  const tick = signal(0);
  const states = toObservable(tick).pipe(
    switchMap(() =>
      request().pipe(
        tap((envelope) => context.meta.set(envelope.meta)),
        map((envelope): RxState<T> => ({ status: 'ready', data: envelope.data })),
        catchError((err: unknown) => of<RxState<T>>({ status: 'error', problem: toProblem(err) })),
        startWith<RxState<T>>({ status: 'loading' }),
      ),
    ),
  );
  return { state: toSignal(states, { initialValue: { status: 'loading' } }), reload: () => tick.update((n) => n + 1) };
}
