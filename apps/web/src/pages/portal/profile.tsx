import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toastError, toastRemoved, toastSuccess } from '@/lib/toast';
import {
  Building2,
  Camera,
  Check,
  ChevronDown,
  LogOut,
  MapPin,
  Monitor,
  Moon,
  Sun,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/providers/auth-provider';
import { usePortal, type AuthorizedLocation } from '@/providers/portal-provider';
import { useTheme } from '@/providers/theme-provider';
import { useDebouncedSave } from '@/hooks/use-debounced-save';
import { cn } from '@/lib/utils';

const PERSON_TYPE_LABEL: Record<string, string> = {
  employee: 'Employee',
  contractor: 'Contractor',
  vendor_contact: 'Vendor contact',
  visitor: 'Visitor',
  temporary_worker: 'Temporary worker',
};

export function PortalProfilePage() {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const { data, loading } = usePortal();

  if (loading || !data) {
    return (
      <div className="mx-auto w-full max-w-[640px] px-4 py-12 sm:px-6">
        <div className="flex justify-center py-16">
          <Spinner className="size-6 text-muted-foreground" />
        </div>
      </div>
    );
  }

  const fullName = `${data.person.first_name} ${data.person.last_name}`.trim();
  const handleSignOut = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <div className="mx-auto w-full max-w-[640px] px-4 py-8 sm:px-6 sm:py-12 flex flex-col gap-8 pb-24 md:pb-12">
      <ProfileHero
        fullName={fullName}
        email={data.user.email ?? data.person.email ?? ''}
        avatarUrl={data.person.avatar_url}
      />

      <ProfileSection title="About you" description="Visible to teammates when you submit requests.">
        <ReadOnlyRow label="Name" value={fullName} />
        <ReadOnlyRow label="Email" value={data.user.email ?? data.person.email ?? '—'} />
        <ReadOnlyRow label="Account type" value={PERSON_TYPE_LABEL[data.person.type] ?? data.person.type} />
        {data.person.primary_org_node && (
          <ReadOnlyRow
            label="Department"
            value={data.person.primary_org_node.name}
            hint={data.person.primary_org_node.code}
          />
        )}
        <PhoneRow phone={data.person.phone ?? ''} />
      </ProfileSection>

      <ProfileSection
        title="Your work location"
        description="Where you usually work. We use it to show the right services and announcements."
      >
        <DefaultLocationRow
          defaultLocation={data.default_location}
          authorized={data.authorized_locations}
        />
      </ProfileSection>

      <ProfileSection title="Appearance" description="How the app looks on this device.">
        <ThemeRow />
      </ProfileSection>

      <div className="pt-2">
        <Button
          variant="outline"
          className="w-full sm:w-auto gap-2 text-muted-foreground hover:text-foreground"
          onClick={() => void handleSignOut()}
        >
          <LogOut className="size-4" /> Sign out
        </Button>
      </div>
    </div>
  );
}

// ─── Hero ────────────────────────────────────────────────────────────────────

function ProfileHero({
  fullName,
  email,
  avatarUrl,
}: {
  fullName: string;
  email: string;
  avatarUrl: string | null;
}) {
  const { uploadAvatar, removeAvatar } = usePortal();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const initials = fullName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join('')
    .toUpperCase() || (email[0] ?? 'U').toUpperCase();

  const onPick = () => fileInputRef.current?.click();

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      toastError('Unsupported image type', {
        description: 'Choose a JPG, PNG, or WebP image.',
      });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toastError('Image is too large', { description: 'Keep it under 2 MB.' });
      return;
    }
    setBusy(true);
    try {
      await uploadAvatar(file);
      toastSuccess('Profile photo updated');
    } catch (e) {
      toastError("Couldn't upload photo", { error: e });
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    setBusy(true);
    try {
      await removeAvatar();
      toastRemoved('Photo');
    } catch (e) {
      toastError("Couldn't remove photo", { error: e });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-4 pt-2">
      <div className="relative">
        <Avatar className="size-24 ring-1 ring-border">
          {avatarUrl && <AvatarImage src={avatarUrl} alt={fullName} loading="eager" />}
          <AvatarFallback className="text-2xl bg-gradient-to-br from-indigo-500 to-pink-500 text-white font-semibold">
            {initials}
          </AvatarFallback>
        </Avatar>
        <button
          type="button"
          onClick={onPick}
          disabled={busy}
          aria-label="Change profile photo"
          className="absolute -bottom-1 -right-1 inline-flex size-9 items-center justify-center rounded-full bg-foreground text-background shadow-sm ring-2 ring-background transition-colors hover:bg-foreground/90 disabled:opacity-60"
          style={{ transitionTimingFunction: 'var(--ease-snap)', transitionDuration: '120ms' }}
        >
          {busy ? <Spinner className="size-4" /> : <Camera className="size-4" />}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          onChange={(e) => void onFile(e)}
        />
      </div>
      <div className="text-center">
        <h1 className="text-xl font-semibold tracking-tight">{fullName || 'Your profile'}</h1>
        <p className="text-sm text-muted-foreground">{email}</p>
      </div>
      {avatarUrl && (
        <button
          type="button"
          onClick={() => void onRemove()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-60"
        >
          <Trash2 className="size-3.5" /> Remove photo
        </button>
      )}
    </div>
  );
}

// ─── Section + rows ──────────────────────────────────────────────────────────

function ProfileSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="px-1">
        <h2 className="text-sm font-medium">{title}</h2>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="rounded-xl border bg-card divide-y overflow-hidden">{children}</div>
    </section>
  );
}

function ProfileRow({
  label,
  description,
  children,
  align = 'center',
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
  /** 'center' for inline controls; 'start' when the right side is multi-line text. */
  align?: 'center' | 'start';
}) {
  return (
    <div
      className={cn(
        'flex gap-4 px-4 py-3.5 min-h-[64px]',
        align === 'center' ? 'items-center' : 'items-start',
      )}
    >
      <div className="flex flex-col gap-0.5 min-w-[120px] shrink-0">
        <div className="text-sm font-medium">{label}</div>
        {description && <div className="text-xs text-muted-foreground max-w-[260px]">{description}</div>}
      </div>
      <div className="flex flex-1 items-center justify-end gap-2 min-w-0">{children}</div>
    </div>
  );
}

function ReadOnlyRow({ label, value, hint }: { label: string; value: string; hint?: string | null }) {
  return (
    <ProfileRow label={label} align="start">
      <div className="text-sm text-foreground/80 text-right break-words pt-0.5">
        {value}
        {hint && <span className="ml-2 text-xs text-muted-foreground">({hint})</span>}
      </div>
    </ProfileRow>
  );
}

function PhoneRow({ phone }: { phone: string }) {
  const { updateProfile } = usePortal();
  const [value, setValue] = useState(phone);
  useEffect(() => setValue(phone), [phone]);

  useDebouncedSave(value, (next) => {
    if (next === phone) return;
    void updateProfile({ phone: next })
      .catch((e) => toastError("Couldn't save phone", { error: e }));
  });

  return (
    <ProfileRow label="Phone" description="Used by the desk if they need to reach you about a request.">
      <Input
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        placeholder="+31 6 12 34 56 78"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-9 w-56 sm:w-64"
      />
    </ProfileRow>
  );
}

// ─── Default location picker ────────────────────────────────────────────────

function DefaultLocationRow({
  defaultLocation,
  authorized,
}: {
  defaultLocation: { id: string; name: string; type: string } | null;
  authorized: AuthorizedLocation[];
}) {
  const { updateProfile } = usePortal();
  const [busy, setBusy] = useState(false);

  // Only sites and buildings are valid as a default work location (DB trigger
  // 00047). Filter the authorized set so the picker can never propose a value
  // the server would reject.
  const choices = authorized.filter((l) => l.type === 'site' || l.type === 'building');

  const handleSelect = async (spaceId: string) => {
    if (spaceId === defaultLocation?.id) return;
    setBusy(true);
    try {
      await updateProfile({ default_location_id: spaceId });
      toastSuccess('Default location updated');
    } catch (e) {
      toastError("Couldn't update location", { error: e });
    } finally {
      setBusy(false);
    }
  };

  if (choices.length === 0) {
    return (
      <ProfileRow label="Default location" description="Ask an admin to grant you access to a site or building.">
        <span className="text-sm text-muted-foreground">No options</span>
      </ProfileRow>
    );
  }

  return (
    <ProfileRow
      label="Default location"
      description="The location we use when you open the portal."
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm" className="h-9 gap-2 max-w-[14rem]" disabled={busy}>
              {defaultLocation ? (
                <>
                  {defaultLocation.type === 'site' ? (
                    <MapPin className="size-4 shrink-0" />
                  ) : (
                    <Building2 className="size-4 shrink-0" />
                  )}
                  <span className="truncate">{defaultLocation.name}</span>
                </>
              ) : (
                <span className="text-muted-foreground">Choose a location</span>
              )}
              <ChevronDown className="size-3.5 opacity-60 shrink-0" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="min-w-[260px]">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Pick your default
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {choices.map((loc) => (
            <DropdownMenuItem
              key={loc.id}
              onClick={() => void handleSelect(loc.id)}
              disabled={busy}
              className="flex items-start gap-2"
            >
              {loc.type === 'site' ? (
                <MapPin className="size-4 mt-0.5 shrink-0" />
              ) : (
                <Building2 className="size-4 mt-0.5 shrink-0" />
              )}
              <div className="flex flex-col flex-1 min-w-0">
                <span className="truncate">{loc.name}</span>
                <span className="text-xs text-muted-foreground capitalize">{loc.type}</span>
              </div>
              {loc.id === defaultLocation?.id && <Check className="size-4 text-foreground/70" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </ProfileRow>
  );
}

// ─── Theme row ───────────────────────────────────────────────────────────────

function ThemeRow() {
  const { theme, setTheme } = useTheme();
  const options = [
    { value: 'light' as const, label: 'Light', Icon: Sun },
    { value: 'dark' as const, label: 'Dark', Icon: Moon },
    { value: 'system' as const, label: 'System', Icon: Monitor },
  ];
  const current = options.find((o) => o.value === theme) ?? options[2];

  return (
    <ProfileRow label="Theme" description="Choose how the portal looks on this device.">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm" className="h-9 gap-2">
              <current.Icon className="size-4" />
              <span>{current.label}</span>
              <ChevronDown className="size-3.5 opacity-60" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="min-w-[180px]">
          {options.map(({ value, label, Icon }) => (
            <DropdownMenuItem key={value} onClick={() => setTheme(value)} className="gap-2">
              <Icon className="size-4" />
              <span className="flex-1">{label}</span>
              {theme === value && <Check className="size-4 text-foreground/70" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </ProfileRow>
  );
}
