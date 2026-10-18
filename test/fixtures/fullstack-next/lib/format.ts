import type { User } from './types';

/** The name shown everywhere in the UI. */
export function displayName(user: Pick<User, 'name' | 'email'>): string {
  return user.name.trim() || user.email;
}

/**
 * Upper-cased name for the users table.
 * @deprecated Use displayName() instead.
 */
export function formatUserName(user: Pick<User, 'name'>): string {
  return user.name.toUpperCase();
}
