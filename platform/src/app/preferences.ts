import { useEffect, useState } from 'react';
import { api } from './api';

export type Preferences = { mapBase?: 'scheme' | 'satellite' | 'hybrid' | 'topo'; mapTheme?: 'light' | 'dark'; theme?: 'light' | 'dark'; mapRelief?: boolean };
let account: string | null = null;
let current: Preferences = {};
let queue = Promise.resolve();
const event = 'itles-preferences';

export async function loadPreferences(id: string) {
  account = id;
  current = {};
  const result = await api<{ preferences: Preferences }>('GET', '/api/me/preferences');
  if (account === id) current = result.preferences;
  return result.preferences;
}

export function clearPreferences() {
  account = null;
  current = {};
}

export function savePreferences(patch: Preferences) {
  if (!account) return;
  const id = account;
  current = { ...current, ...patch };
  window.dispatchEvent(new Event(event));
  queue = queue.catch(() => {}).then(async () => {
    if (account !== id) return;
    try {
      await api('PATCH', '/api/me/preferences', patch);
      window.dispatchEvent(new CustomEvent('itles-preferences-error', { detail: '' }));
    } catch {
      window.dispatchEvent(new CustomEvent('itles-preferences-error', { detail: 'Настройки не сохранены на сервере. Проверьте связь и повторите выбор.' }));
    }
  });
}

export function usePreferences(): [Preferences, typeof savePreferences] {
  const [value, setValue] = useState(current);
  useEffect(() => {
    const update = () => setValue({ ...current });
    window.addEventListener(event, update);
    return () => window.removeEventListener(event, update);
  }, []);
  return [value, savePreferences];
}
