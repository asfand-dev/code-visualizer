import { db } from './db';
import type { CreateUserInput } from './validation';

export interface UserSummary {
  id: string;
  name: string;
  email: string;
  visits: number;
}

export async function getUsers(): Promise<UserSummary[]> {
  return db.user.findMany({ orderBy: { name: 'asc' }, take: 50 });
}

export async function getUserById(id: string): Promise<UserSummary | null> {
  return db.user.findUnique({ where: { id } });
}

export async function insertUser(input: CreateUserInput): Promise<UserSummary> {
  return db.user.create({ data: { ...input, visits: 0 } });
}
