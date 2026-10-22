import { DestroyRef, Injectable, inject, signal } from '@angular/core';

export interface ChartTokens {
  ink: string;
  ink2: string;
  mute: string;
  line: string;
  grid: string;
  surface: string;
  accent: string;
  ctx: string;
  bad: string;
  warn: string;
  font: string;
  reducedMotion: boolean;
}

function read(): ChartTokens {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    ink: v('--ink'),
    ink2: v('--ink2'),
    mute: v('--mute'),
    line: v('--line'),
    grid: v('--grid'),
    surface: v('--surface'),
    accent: v('--accent'),
    ctx: v('--ctx'),
    bad: v('--bad'),
    warn: v('--warn'),
    font: v('--font'),
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  };
}

/** Chart colors from the CSS tokens, refreshed when the color scheme or theme changes. */
@Injectable({ providedIn: 'root' })
export class ChartTheme {
  readonly tokens = signal<ChartTokens>(read());

  constructor() {
    const refresh = () => this.tokens.set(read());
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    scheme.addEventListener('change', refresh);
    motion.addEventListener('change', refresh);
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    inject(DestroyRef).onDestroy(() => {
      scheme.removeEventListener('change', refresh);
      motion.removeEventListener('change', refresh);
      observer.disconnect();
    });
  }
}
