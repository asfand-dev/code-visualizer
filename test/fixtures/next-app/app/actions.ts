'use server';

import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { insertUser } from '@/lib/users';
import { createUserSchema } from '@/lib/validation';

export async function createUser(formData: FormData) {
  const parsed = createUserSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false as const, errors: parsed.error.flatten().fieldErrors };
  await insertUser(parsed.data);
  revalidatePath('/');
  return { ok: true as const };
}

export async function incrementVisits(id: string) {
  const user = await db.user.update({ where: { id }, data: { visits: { increment: 1 } } });
  revalidatePath(`/dashboard/${id}`);
  return user.visits;
}
