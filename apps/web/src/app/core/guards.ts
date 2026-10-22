import { inject } from '@angular/core';
import { Router, type CanActivateFn, type CanMatchFn } from '@angular/router';
import type { View } from '@phub/contracts';
import { Session } from './session';

// Convenience only: the API enforces roles on every request.

/** Matches a view route only for users whose roles include that view. */
export const viewGuard: CanMatchFn = async (route) => {
  const me = await inject(Session).load();
  return me?.views.includes(route.data?.['view'] as View) ?? false;
};

/** Sends / to the first view the user may open, or to the access page. */
export const homeRedirect: CanActivateFn = async (_route, state) => {
  const router = inject(Router);
  const me = await inject(Session).load();
  const first = me?.views[0];
  const query = router.parseUrl(state.url).queryParams;
  return router.createUrlTree([first ?? 'access'], { queryParams: query });
};
