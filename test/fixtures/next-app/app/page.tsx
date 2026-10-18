import UserList from '@/components/UserList';
import { getUsers } from '@/lib/users';
import { createUser } from './actions';

export default async function HomePage() {
  const users = await getUsers();
  return (
    <main>
      <h1>Users</h1>
      <UserList users={users} />
      <form action={createUser}>
        <input name="name" placeholder="Name" />
        <input name="email" type="email" placeholder="Email" />
        <button type="submit">Add</button>
      </form>
    </main>
  );
}
