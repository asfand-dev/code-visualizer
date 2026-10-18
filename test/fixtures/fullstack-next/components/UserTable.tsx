'use client';

import { useEffect, useState } from 'react';
import { MAX_USERS } from '@/lib/db';
import { formatUserName } from '@/lib/format';
import type { User } from '@/lib/types';

export default function UserTable() {
  const [users, setUsers] = useState<User[]>([]);

  useEffect(() => {
    fetch('/api/users')
      .then((res) => res.json())
      .then((list: User[]) => setUsers(list.slice(0, MAX_USERS)));
  }, []);

  async function remove(id: string) {
    await fetch(`/api/users/${id}`, { method: 'DELETE' });
    setUsers((list) => list.filter((u) => u.id !== id));
  }

  async function exportCsv() {
    // There is no such route (yet), so the API map cannot link this call.
    await fetch('/api/reports/export', { method: 'POST' });
  }

  return (
    <table>
      <tbody>
        {users.map((u) => (
          <tr key={u.id}>
            <td>{formatUserName(u)}</td>
            <td>
              <button onClick={() => remove(u.id)}>Delete</button>
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td>
            <button onClick={exportCsv}>Export</button>
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
