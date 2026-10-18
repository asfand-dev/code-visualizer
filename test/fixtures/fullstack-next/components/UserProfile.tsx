'use client';

import { useEffect, useState } from 'react';
import { displayName } from '@/lib/format';
import type { User } from '@/lib/types';
import { fetchUser } from '@/lib/users-client';

export default function UserProfile({ id }: { id: string }) {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    void fetchUser(id).then(setUser);
  }, [id]);

  if (!user) return <p>Loading…</p>;
  return <h2>{displayName(user)}</h2>;
}
