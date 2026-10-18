import { notFound } from 'next/navigation';
import { VisitCounter } from '@/components/VisitCounter';
import { getUserById } from '@/lib/users';

export default async function DashboardPage({ params }: { params: { id: string } }) {
  const user = await getUserById(params.id);
  if (!user) notFound();
  return (
    <section>
      <h1>{user.name}</h1>
      <VisitCounter userId={user.id} initial={user.visits} />
    </section>
  );
}
