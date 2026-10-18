import { forwardRef, type ButtonHTMLAttributes } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

/** Design-system button. Forwards its ref to the native element. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', loading = false, className, children, ...rest }, ref) => {
    const classes = ['btn', `btn-${variant}`, `btn-${size}`, className].filter(Boolean).join(' ');
    return (
      <button ref={ref} className={classes} disabled={loading || rest.disabled} {...rest}>
        {loading ? '…' : children}
      </button>
    );
  },
);

Button.displayName = 'Button';
