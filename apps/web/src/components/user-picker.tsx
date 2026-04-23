import { useMemo } from 'react';
import { useUsers, type UserOption } from '@/api/users';
import { EntityPicker } from '@/components/desk/editors/entity-picker';
import { PersonAvatar } from '@/components/person-avatar';

export type { UserOption };

interface UserPickerProps {
  value: string | null | undefined;
  onChange: (id: string) => void;
  /** Called with the full user object on selection, or null on clear. */
  onSelect?: (user: UserOption | null) => void;
  /** Exclude a user id (e.g. self when delegating away). */
  excludeId?: string | null;
  placeholder?: string;
  clearLabel?: string | null;
  disabled?: boolean;
}

function userLabel(u: UserOption): string {
  const name = `${u.person?.first_name ?? ''} ${u.person?.last_name ?? ''}`.trim();
  return name || u.email;
}

export function UserPicker({
  value,
  onChange,
  onSelect,
  excludeId,
  placeholder = 'Select user...',
  clearLabel = 'Clear',
  disabled,
}: UserPickerProps) {
  const { data: users } = useUsers();

  const options = useMemo(() => {
    const list = users ?? [];
    return list
      .filter((u) => (excludeId ? u.id !== excludeId : true))
      .map((u) => ({
        id: u.id,
        label: userLabel(u),
        sublabel: u.email,
        leading: <PersonAvatar size="sm" person={u.person ?? { email: u.email }} />,
      }));
  }, [users, excludeId]);

  const selected = useMemo(
    () => (users ?? []).find((u) => u.id === value) ?? null,
    [users, value],
  );

  return (
    <EntityPicker
      value={value ? value : null}
      options={options}
      placeholder="user"
      clearLabel={clearLabel}
      disabled={disabled}
      renderValue={(opt) => {
        if (!opt) {
          return <span className="text-muted-foreground">{placeholder}</span>;
        }
        return (
          <span className="flex min-w-0 items-center gap-2">
            <PersonAvatar size="sm" person={selected?.person ?? { email: selected?.email }} />
            <span className="truncate">{opt.label}</span>
          </span>
        );
      }}
      onChange={(opt) => {
        onChange(opt?.id ?? '');
        if (onSelect) {
          const u = opt ? (users ?? []).find((x) => x.id === opt.id) ?? null : null;
          onSelect(u);
        }
      }}
    />
  );
}
