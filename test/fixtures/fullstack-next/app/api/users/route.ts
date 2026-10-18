import { NextResponse } from 'next/server';
import { insertUser, listUsers } from '@/lib/db';

export async function GET() {
  return NextResponse.json(listUsers());
}

export async function POST(request: Request) {
  const body = (await request.json()) as { name?: string; email?: string };
  if (!body.name || !body.email) {
    return NextResponse.json({ error: 'name and email are required' }, { status: 400 });
  }
  return NextResponse.json(insertUser({ name: body.name, email: body.email }), { status: 201 });
}
