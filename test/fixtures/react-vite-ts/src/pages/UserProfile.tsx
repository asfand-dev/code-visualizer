import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Avatar } from '@/components/Avatar';
import { fetchUser } from '@/api/client';
import type { User } from '@/types';

export default function UserProfile() {
  const { userId, id } = useParams();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const key = userId ?? id;
    if (key) fetchUser(key).then(setUser);
  }, [userId, id]);

  if (!user) return null;
  return (
    <article>
      <Avatar name={user.name} src={user.avatarUrl} size={96} />
      <h1>{user.name}</h1>
      <a href={`mailto:${user.email}`}>{user.email}</a>
    </article>
  );
}
