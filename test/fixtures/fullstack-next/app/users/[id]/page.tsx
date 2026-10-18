import UserProfile from '@/components/UserProfile';

export default function UserPage({ params }: { params: { id: string } }) {
  return <UserProfile id={params.id} />;
}
