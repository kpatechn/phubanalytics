import type { Routes } from '@angular/router';
import { homeRedirect, viewGuard } from './core/guards';
import { Shell } from './analytics/shell';
import { AccessPage, NotFoundPage } from './core/pages';

export const routes: Routes = [
  {
    path: '',
    component: Shell,
    children: [
      { path: '', pathMatch: 'full', canActivate: [homeRedirect], children: [] },
      {
        path: 'executive',
        title: 'Executive · PlayerHub Analytics',
        data: { view: 'executive' },
        canMatch: [viewGuard],
        loadComponent: () => import('./analytics/executive/executive').then((m) => m.ExecutivePage),
      },
      {
        path: 'marketing',
        title: 'Marketing · PlayerHub Analytics',
        data: { view: 'marketing' },
        canMatch: [viewGuard],
        loadComponent: () => import('./analytics/marketing/marketing').then((m) => m.MarketingPage),
      },
      {
        path: 'it',
        title: 'IT & Operations · PlayerHub Analytics',
        data: { view: 'it' },
        canMatch: [viewGuard],
        loadComponent: () => import('./analytics/it-ops/it-ops').then((m) => m.ItOpsPage),
      },
      { path: 'access', title: 'No access · PlayerHub Analytics', component: AccessPage },
      { path: '**', title: 'Not found · PlayerHub Analytics', component: NotFoundPage },
    ],
  },
];
