import { memo } from 'react';

interface AvatarProps {
  name: string;
  src?: string;
  size?: number;
}

function initials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export const Avatar = memo(function Avatar({ name, src, size = 32 }: AvatarProps) {
  if (src) return <img className="avatar" src={src} alt={name} width={size} height={size} />;
  return (
    <span className="avatar avatar-fallback" style={{ width: size, height: size }}>
      {initials(name)}
    </span>
  );
});
