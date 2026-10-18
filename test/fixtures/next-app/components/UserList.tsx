import Link from 'next/link';
import type { UserSummary } from '@/lib/users';

export default function UserList({ users }: { users: UserSummary[] }) {
  if (!users.length) return <p>No users yet.</p>;
  return (
    <ul>
      {users.map((u) => (
        <li key={u.id}>
          <Link href={`/dashboard/${u.id}`}>{u.name}</Link>
        </li>
      ))}
    </ul>
  );
}
