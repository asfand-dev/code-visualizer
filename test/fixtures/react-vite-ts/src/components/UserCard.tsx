import type { User } from '@/types';
import { formatDate } from '@/utils/format';
import { Avatar } from './Avatar';
import { Button } from './Button';
import { Card } from './Card';

interface UserCardProps {
  user: User;
  joinedAt?: string;
  onSelect?: (user: User) => void;
}

export const UserCard = ({ user, joinedAt, onSelect }: UserCardProps) => (
  <Card
    title={user.name}
    footer={joinedAt ? <small>Joined {formatDate(joinedAt)}</small> : null}
  >
    <Avatar name={user.name} src={user.avatarUrl} />
    <p>{user.email}</p>
    <Button variant="ghost" size="sm" onClick={() => onSelect?.(user)}>
      View profile
    </Button>
  </Card>
);
