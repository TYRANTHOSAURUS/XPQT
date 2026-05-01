/**
 * /kiosk/walkup — visitor without an invitation.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §8.5
 *
 * Three steps:
 *   1. Pick visitor type. Backend's `/kiosk/visitor-types` already filters
 *      to types where `allow_walk_up=true` AND `requires_approval=false`.
 *      If the response is empty we render a "please see reception" deny
 *      screen and never reach the form.
 *   2. Fill first name (required) + last name + company + email + phone +
 *      host search.
 *   3. Submit → /kiosk/walk-up. Confirmation screen on success; offline
 *      fallback queues the payload to IndexedDB and still shows confirmation.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { ApiError } from '@/lib/api';
import {
  useKioskHostSearch,
  useKioskVisitorTypes,
  walkupOrQueue,
  type KioskHostRow,
  type KioskVisitorType,
  type KioskWalkupPayload,
} from '@/api/visitors/kiosk';

const TIMEOUT_MS = 90_000;

type Step =
  | { kind: 'pick-type' }
  | { kind: 'form'; type: KioskVisitorType }
  | { kind: 'deny' }
  | { kind: 'error'; title: string; message: string };

function useDebounced<T>(value: T, delayMs = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return v;
}

export function KioskWalkupPage() {
  const navigate = useNavigate();
  const types = useKioskVisitorTypes();
  const [step, setStep] = useState<Step>({ kind: 'pick-type' });

  // 90s timeout — walk-up forms take a bit longer to fill out.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      navigate('/kiosk', { replace: true });
    }, TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [navigate]);

  // If types finishes loading and there are zero options, jump straight to
  // the deny screen.
  useEffect(() => {
    if (
      step.kind === 'pick-type' &&
      types.data &&
      types.data.length === 0 &&
      !types.isFetching
    ) {
      setStep({ kind: 'deny' });
    }
  }, [step.kind, types.data, types.isFetching]);

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <Button
          variant="ghost"
          size="lg"
          className="h-14 gap-2 text-lg"
          onClick={() => {
            if (step.kind === 'pick-type' || step.kind === 'deny') {
              navigate('/kiosk', { replace: true });
            } else {
              setStep({ kind: 'pick-type' });
            }
          }}
        >
          <ArrowLeft className="size-5" aria-hidden="true" />
          {step.kind === 'pick-type' ? 'Cancel' : 'Back'}
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">
          {step.kind === 'form'
            ? 'Tell us about yourself'
            : step.kind === 'deny'
              ? 'Please see reception'
              : step.kind === 'error'
                ? "Couldn't check you in"
                : "What brings you in?"}
        </h1>
        <div className="w-[120px]" />
      </header>

      <div className="flex flex-1 flex-col items-center px-6 py-8">
        {step.kind === 'pick-type' ? (
          types.isLoading ? (
            <div className="flex items-center gap-3 text-lg text-muted-foreground">
              <Spinner className="size-5" /> Loading…
            </div>
          ) : (
            <PickTypeStep
              types={types.data ?? []}
              onPick={(t) => setStep({ kind: 'form', type: t })}
            />
          )
        ) : null}

        {step.kind === 'form' ? (
          <FormStep
            type={step.type}
            onSubmit={async (payload) => {
              try {
                const outcome = await walkupOrQueue(payload);
                navigate('/kiosk/confirmation', {
                  replace: true,
                  state: {
                    hostFirstName: null,
                    hasReceptionAtBuilding: true,
                    queued: outcome.mode === 'queued',
                  },
                });
              } catch (err) {
                const mapped = mapBackendError(err);
                setStep({
                  kind: 'error',
                  title: mapped.title,
                  message: mapped.message,
                });
              }
            }}
          />
        ) : null}

        {step.kind === 'deny' ? <DenyStep /> : null}

        {step.kind === 'error' ? (
          <ErrorStep
            title={step.title}
            message={step.message}
            onRetry={() => setStep({ kind: 'pick-type' })}
          />
        ) : null}
      </div>
    </div>
  );
}

function PickTypeStep({
  types,
  onPick,
}: {
  types: KioskVisitorType[];
  onPick: (t: KioskVisitorType) => void;
}) {
  if (types.length === 0) {
    return (
      <div className="flex max-w-xl flex-col items-center gap-4 text-center">
        <p className="text-2xl font-semibold tracking-tight">
          Please see reception
        </p>
        <p className="text-lg text-muted-foreground">
          We don't have a self-service option for visitors right now. The
          reception team can help you check in.
        </p>
      </div>
    );
  }
  return (
    <div className="grid w-full max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
      {types.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onPick(t)}
          className="flex min-h-[140px] flex-col items-start justify-center gap-2 rounded-2xl border-2 bg-card px-6 py-5 text-left transition-colors duration-150 [transition-timing-function:var(--ease-snap)] hover:border-primary/50 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px"
        >
          <span className="text-2xl font-semibold tracking-tight">
            {t.display_name}
          </span>
          {t.description ? (
            <span className="text-base text-muted-foreground">
              {t.description}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function FormStep({
  type,
  onSubmit,
}: {
  type: KioskVisitorType;
  onSubmit: (payload: KioskWalkupPayload) => Promise<void>;
}) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [hostQuery, setHostQuery] = useState('');
  const [host, setHost] = useState<KioskHostRow | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const debouncedHostQuery = useDebounced(hostQuery, 200);
  const hostSearch = useKioskHostSearch(host ? '' : debouncedHostQuery);
  const hostResults = useMemo(() => hostSearch.data ?? [], [hostSearch.data]);
  const firstNameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    firstNameRef.current?.focus();
  }, []);

  const canSubmit =
    firstName.trim().length > 0 && host != null && !submitting;

  return (
    <form
      className="flex w-full max-w-3xl flex-col gap-6"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!canSubmit || !host) return;
        setSubmitting(true);
        try {
          await onSubmit({
            first_name: firstName.trim(),
            last_name: lastName.trim() || undefined,
            company: company.trim() || undefined,
            email: email.trim() || undefined,
            phone: phone.trim() || undefined,
            visitor_type_id: type.id,
            primary_host_person_id: host.id,
          });
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <FieldGroup>
        <div className="flex flex-col gap-1.5 rounded-xl border bg-muted/30 px-4 py-3 text-base text-muted-foreground">
          Visiting as <span className="font-medium text-foreground">{type.display_name}</span>
        </div>

        <Field>
          <FieldLabel htmlFor="walkup-first-name" className="text-lg">
            First name
          </FieldLabel>
          <Input
            ref={firstNameRef}
            id="walkup-first-name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            autoComplete="given-name"
            autoCapitalize="words"
            className="h-14 text-xl"
            required
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="walkup-last-name" className="text-lg">
            Last name
          </FieldLabel>
          <Input
            id="walkup-last-name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            autoComplete="family-name"
            autoCapitalize="words"
            className="h-14 text-xl"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="walkup-company" className="text-lg">
            Company (optional)
          </FieldLabel>
          <Input
            id="walkup-company"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            autoComplete="organization"
            className="h-14 text-xl"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="walkup-email" className="text-lg">
            Email (optional)
          </FieldLabel>
          <Input
            id="walkup-email"
            type="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            className="h-14 text-xl"
          />
          <FieldDescription>
            We use this to send you a quick "checked in" confirmation.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="walkup-phone" className="text-lg">
            Phone (optional)
          </FieldLabel>
          <Input
            id="walkup-phone"
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="tel"
            className="h-14 text-xl"
          />
        </Field>

        <FieldSeparator />

        <Field>
          <FieldLabel htmlFor="walkup-host-search" className="text-lg">
            Who are you here to see?
          </FieldLabel>
          {host ? (
            <div className="flex items-center justify-between rounded-xl border bg-card px-4 py-3">
              <span className="text-xl">
                {host.first_name} {host.last_initial}.
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setHost(null);
                  setHostQuery('');
                }}
              >
                Change
              </Button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id="walkup-host-search"
                  value={hostQuery}
                  onChange={(e) => setHostQuery(e.target.value)}
                  placeholder="Type their name"
                  autoComplete="off"
                  autoCapitalize="words"
                  className="h-14 pl-12 text-xl"
                />
              </div>
              <FieldDescription>
                We'll only show first name + last initial — privacy.
              </FieldDescription>
              {debouncedHostQuery.length > 0 ? (
                <div className="mt-2 flex flex-col gap-2">
                  {hostSearch.isFetching ? (
                    <div className="flex items-center gap-2 px-2 py-2 text-base text-muted-foreground">
                      <Spinner className="size-4" /> Searching…
                    </div>
                  ) : hostResults.length === 0 ? (
                    <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-3 text-base text-muted-foreground">
                      No matching host found. Ask reception for help.
                    </div>
                  ) : (
                    hostResults.map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() => setHost(h)}
                        className="flex items-center justify-between rounded-lg border bg-card px-4 py-3 text-left transition-colors duration-150 [transition-timing-function:var(--ease-snap)] hover:border-primary/50 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        <span className="text-lg">
                          {h.first_name} {h.last_initial}.
                        </span>
                        <span className="text-sm font-medium text-primary">
                          Pick
                        </span>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </>
          )}
        </Field>

        <Button
          type="submit"
          size="lg"
          className="h-16 text-xl"
          disabled={!canSubmit}
        >
          {submitting ? 'Checking you in…' : 'Check me in'}
        </Button>
      </FieldGroup>
    </form>
  );
}

function DenyStep() {
  return (
    <div className="flex max-w-xl flex-col items-center gap-6 text-center">
      <h2 className="text-3xl font-semibold tracking-tight">
        Please see reception
      </h2>
      <p className="text-lg text-muted-foreground">
        Visits at this building need to be set up with reception. They'll
        help you check in.
      </p>
    </div>
  );
}

function ErrorStep({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex max-w-xl flex-col items-center gap-6 text-center">
      <h2 className="text-3xl font-semibold tracking-tight">{title}</h2>
      <p className="text-lg text-muted-foreground">{message}</p>
      <Button size="lg" className="h-14 px-6 text-lg" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function mapBackendError(err: unknown): { title: string; message: string } {
  if (err instanceof ApiError) {
    if (err.status === 400 && /walk_up_disabled|approval_required/i.test(err.message)) {
      return {
        title: 'Self check-in is not available for this type',
        message: 'Please see reception so they can help you check in.',
      };
    }
    if (err.status === 404 && /host/i.test(err.message)) {
      return {
        title: 'Host not found',
        message: 'Please double-check the host you picked, or see reception.',
      };
    }
  }
  return {
    title: "Couldn't check you in",
    message: 'Please see reception so they can help.',
  };
}
