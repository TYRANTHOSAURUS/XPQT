import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

interface PersonLike {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
}

function getInitials(person: PersonLike | null | undefined, fallback = '?'): string {
  if (!person) return fallback;
  const first = person.first_name?.trim()?.[0];
  const last = person.last_name?.trim()?.[0];
  if (first && last) return `${first}${last}`.toUpperCase();
  if (first) return first.toUpperCase();
  if (person.email) return person.email[0]!.toUpperCase();
  return fallback;
}

interface PersonAvatarProps {
  person: PersonLike | null | undefined;
  size?: 'sm' | 'default' | 'lg';
  className?: string;
  /** Override the alt text / display name used for AvatarImage. */
  alt?: string;
}

/**
 * Renders a person's avatar with a consistent initials fallback. Accepts any object with
 * `first_name`, `last_name`, `email` (all optional) plus an optional `avatar_url`.
 */
export function PersonAvatar({ person, size = 'default', className, alt }: PersonAvatarProps) {
  const fullName = [person?.first_name, person?.last_name].filter(Boolean).join(' ');
  const displayAlt = alt ?? (fullName || person?.email || 'User');
  return (
    <Avatar size={size} className={cn(className)}>
      {person?.avatar_url && (
        <AvatarImage src={person.avatar_url} alt={displayAlt} loading="lazy" decoding="async" />
      )}
      <AvatarFallback>{getInitials(person)}</AvatarFallback>
    </Avatar>
  );
}
