import { useContext } from 'react';
import { ThemeContext } from '@/context/ThemeContext';
import { Button } from './Button';

export function ThemeToggle() {
  const ctx = useContext(ThemeContext);
  if (!ctx) return null;
  return (
    <Button variant="ghost" onClick={ctx.toggle}>
      {ctx.theme === 'dark' ? 'Light mode' : 'Dark mode'}
    </Button>
  );
}
