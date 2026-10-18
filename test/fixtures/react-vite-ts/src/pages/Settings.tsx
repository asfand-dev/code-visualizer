import { useState } from 'react';
import { Button, Card, ThemeToggle } from '@/components';
import { useDebounce } from '@/hooks/useDebounce';
import { useCartStore } from '@/store/useCartStore';
import { formatCurrency } from '@/utils/format';

export default function Settings() {
  const [displayName, setDisplayName] = useState('');
  const debouncedName = useDebounce(displayName, 500);
  const items = useCartStore((s) => s.items);
  const clear = useCartStore((s) => s.clear);
  const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);

  // TODO: persist the display name to the server
  return (
    <Card title="Settings">
      <label>
        Display name
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      <p>Preview: {debouncedName || 'Anonymous'}</p>
      <ThemeToggle />
      <p>Cart total: {formatCurrency(total)}</p>
      <Button variant="danger" onClick={clear} disabled={items.length === 0}>
        Clear cart
      </Button>
    </Card>
  );
}
