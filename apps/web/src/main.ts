import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { applySavedTheme } from './app/core/theme';

// Before bootstrap, so the first paint uses the saved theme (no inline script: strict CSP).
applySavedTheme();

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
