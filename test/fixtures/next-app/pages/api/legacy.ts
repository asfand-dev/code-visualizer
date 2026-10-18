import type { NextApiRequest, NextApiResponse } from 'next';
import { getUsers } from '@/lib/users';

// Kept for the mobile app until it moves to /api/users.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  res.status(200).json({ users: await getUsers() });
}
