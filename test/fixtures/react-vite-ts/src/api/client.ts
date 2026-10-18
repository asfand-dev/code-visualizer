import type { User } from '@/types';

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return (await res.json()) as T;
}

export function fetchUsers(): Promise<User[]> {
  return request<User[]>('/users');
}

export function fetchUser(id: string): Promise<User> {
  return request<User>(`/users/${encodeURIComponent(id)}`);
}
