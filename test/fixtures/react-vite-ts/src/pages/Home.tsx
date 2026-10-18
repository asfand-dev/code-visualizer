import { useNavigate } from 'react-router-dom';
import { Spinner, UserCard } from '@/components';
import { useUsers } from '@/hooks/useUsers';
import { percent } from '@/utils/math';

export default function Home() {
  const { users, loading, error } = useUsers();
  const navigate = useNavigate();

  if (loading) return <Spinner size={24} />;
  if (error) return <p role="alert">{error.message}</p>;

  const admins = users.filter((u) => u.role === 'admin').length;
  return (
    <section>
      <h1>Team</h1>
      <p>{percent(admins, users.length)} admins</p>
      {users.map((user) => (
        <UserCard key={user.id} user={user} onSelect={(u) => navigate(`/users/${u.id}`)} />
      ))}
    </section>
  );
}
