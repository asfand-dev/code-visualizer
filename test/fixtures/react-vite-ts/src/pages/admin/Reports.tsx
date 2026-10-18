import { Card } from '@/components';
import { useUsers } from '@/hooks/useUsers';

// Route module for react-router's `lazy()` — exports `Component` by convention.
export function Component() {
  const { users } = useUsers();
  return (
    <Card title="Reports">
      <p>{users.length} users total</p>
    </Card>
  );
}

Component.displayName = 'ReportsPage';
