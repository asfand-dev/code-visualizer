import type { User } from './types';

/** Hard cap for list endpoints. */
export const MAX_USERS = 100;

const users = new Map<string, User>([
  ['1', { id: '1', name: 'Ada Lovelace', email: 'ada@example.com' }],
  ['2', { id: '2', name: 'Grace Hopper', email: 'grace@example.com' }],
]);

export function listUsers(): User[] {
  return [...users.values()].slice(0, MAX_USERS);
}

export function findUser(id: string): User | undefined {
  return users.get(id);
}

export function insertUser(input: Omit<User, 'id'>): User {
  const user: User = { ...input, id: String(users.size + 1) };
  users.set(user.id, user);
  return user;
}

export function deleteUser(id: string): boolean {
  return users.delete(id);
}
