import { signal, type Signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { catchError, map, of, startWith, switchMap, type Observable } from 'rxjs';
import type { CdpEnvelope, Problem } from '@phub/contracts';
import { toProblem } from '../core/problem';

export type CdpState<T> =
  | { status: 'loading' }
  | { status: 'ready'; envelope: CdpEnvelope<T> }
  | { status: 'error'; problem: Problem };

/**
 * Loads one CDP endpoint, again on every reload(). Call from a field initializer
 * (needs an injection context).
 */
export function loadCdp<T>(request: () => Observable<CdpEnvelope<T>>): { state: Signal<CdpState<T>>; reload: () => void } {
  const tick = signal(0);
  const states = toObservable(tick).pipe(
    switchMap(() =>
      request().pipe(
        map((envelope): CdpState<T> => ({ status: 'ready', envelope })),
        catchError((err: unknown) => of<CdpState<T>>({ status: 'error', problem: toProblem(err) })),
        startWith<CdpState<T>>({ status: 'loading' }),
      ),
    ),
  );
  return { state: toSignal(states, { initialValue: { status: 'loading' } }), reload: () => tick.update((n) => n + 1) };
}
