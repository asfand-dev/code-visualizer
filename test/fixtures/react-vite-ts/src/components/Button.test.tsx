import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Button } from './Button';

describe('Button', () => {
  it('renders its label', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('is disabled while loading', () => {
    render(<Button loading>Save</Button>);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('calls onClick', () => {
    let clicks = 0;
    render(<Button onClick={() => clicks++}>Go</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(clicks).toBe(1);
  });
});
