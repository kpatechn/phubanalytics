export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'phub-theme';

/** Per-viewer preference. Storage can be unavailable (private mode); fall back to system. */
export function savedTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function setTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Preference just won't persist.
  }
}

export function applySavedTheme(): void {
  const choice = savedTheme();
  if (choice !== 'system') document.documentElement.setAttribute('data-theme', choice);
}
