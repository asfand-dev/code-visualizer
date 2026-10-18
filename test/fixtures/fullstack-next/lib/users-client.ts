import { api } from './api';
import type { User } from './types';

export async function fetchUsers(): Promise<User[]> {
  const res = await api.get<User[]>('/users');
  return res.data;
}

export async function fetchUser(id: string): Promise<User> {
  const res = await api.get<User>(`/users/${id}`);
  return res.data;
}

export async function createUser(input: Omit<User, 'id'>): Promise<User> {
  const res = await api.post<User>('/users', input);
  return res.data;
}
