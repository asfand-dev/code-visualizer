// TODO: delete once every client has migrated to the server-side settings API.
const KEY = 'team-directory:settings';

export function loadLegacySettings(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function clearLegacySettings(): void {
  localStorage.removeItem(KEY);
}
