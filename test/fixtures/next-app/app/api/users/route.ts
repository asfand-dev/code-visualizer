import { NextResponse } from 'next/server';
import { getUsers, insertUser } from '@/lib/users';
import { createUserSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function GET() {
  const users = await getUsers();
  return NextResponse.json(users);
}

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = createUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ errors: parsed.error.flatten() }, { status: 400 });
  }
  const user = await insertUser(parsed.data);
  return NextResponse.json(user, { status: 201 });
}
