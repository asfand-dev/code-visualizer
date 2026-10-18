'use client';

import { useState, useTransition } from 'react';
import { incrementVisits } from '@/app/actions';

export function VisitCounter({ userId, initial }: { userId: string; initial: number }) {
  const [count, setCount] = useState(initial);
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(async () => setCount(await incrementVisits(userId)))}
    >
      Visits: {count}
    </button>
  );
}
