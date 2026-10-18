import { json, type RequestHandler } from '@sveltejs/kit';
import type { Item } from '$lib/types';

const items: Item[] = [{ id: 1, name: 'Notebook' }];

export async function GET({ url }) {
  const limit = Number(url.searchParams.get('limit') ?? 10);
  return json(items.slice(0, limit));
}

export const POST: RequestHandler = async ({ request }) => {
  const { name } = await request.json();
  const item: Item = { id: items.length + 1, name };
  items.push(item);
  return json(item, { status: 201 });
};
