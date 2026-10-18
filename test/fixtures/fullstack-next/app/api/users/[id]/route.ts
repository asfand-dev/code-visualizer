import { NextResponse } from 'next/server';
import { chargeClosingBalance } from '@/lib/billing';
import { deleteUser, findUser } from '@/lib/db';

type Context = { params: { id: string } };

export async function GET(_request: Request, { params }: Context) {
  const user = findUser(params.id);
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(user);
}

export async function DELETE(_request: Request, { params }: Context) {
  if (!deleteUser(params.id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await chargeClosingBalance(params.id);
  return new NextResponse(null, { status: 204 });
}
