/**
 * /kiosk/name-fallback — name-typed check-in.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §8.4
 *
 * Three-step flow:
 *   1. Visitor types name. Debounced 200ms search hits
 *      `GET /kiosk/expected/search?q=…`. Results show first name + last
 *      initial + company; never a host name (privacy per spec §8.4).
 *   2. Visitor taps a result → kiosk fetches the visitor's host context
 *      from the result's row metadata (the search response intentionally
 *      omits host names; we ask the server again with the visitor_id —
 *      see Important note below).
 *
 *      Important note re: backend deviation
 *      ------------------------------------
 *      Spec §8.4 step 5 says "I'm here to see [host first initial + last
 *      name]?" → tap to confirm. The backend's `POST /kiosk/check-in/by-name`
 *      requires `host_first_name_confirmation` as a string and verifies it
 *      against the persons row server-side. There is no "show the host name
 *      then ask the visitor to tap" endpoint — the search result also
 *      doesn't reveal the host (privacy).
 *
 *      To honour the spec ("tap to confirm") AND the backend contract
 *      (server gets a host first-name string), we implemented a
 *      tap-to-confirm UX:
 *        - The kiosk shows TWO host candidates derived from the visitor's
 *          host (the real one) plus a hint pulled from a public expected
 *          search by visitor_id. This isn't shipped yet; the lightest
 *          accurate v1 path is to surface a tap-prompt that asks the
 *          visitor to TYPE the host's first name, with a soft-keyboard
 *          one-line input and a single "Confirm" button.
 *
 *      v1 reality: we ship a TYPE-AND-CONFIRM flow (one input field, one
 *      tap to submit). It honours the spec's intent (visitor must demonstrate
 *      knowledge of who they're meeting) without reorganising the backend
 *      to expose host names anonymously. A future slice can replace the
 *      input with a multi-choice tap UI once a host-hint endpoint exists.
 *      Reception is the safety net for any visitor who can't type the
 *      host's first name.
 *
 *   3. On submit: `POST /kiosk/check-in/by-name`. Confirmation screen on
 *      success; error message on host-mismatch.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Search, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { ApiError } from '@/lib/api';
import {
  useKioskExpectedSearch,
  useKioskNameCheckin,
  type KioskExpectedRow,
} from '@/api/visitors/kiosk';

const TIMEOUT_MS = 60_000;

type Step =
  | { kind: 'search' }
  | { kind: 'confirm'; visitor: KioskExpectedRow }
  | { kind: 'error'; title: string; message: string };

function useDebounced<T>(value: T, delayMs = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return v;
}

export function KioskNameFallbackPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>({ kind: 'search' });
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, 200);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const checkin = useKioskNameCheckin();

  const search = useKioskExpectedSearch(debounced);
  const results = useMemo(() => search.data ?? [], [search.data]);

  // Auto-focus the input on mount + after each step return so the OS
  // keyboard pops up immediately.
  useEffect(() => {
    if (step.kind === 'search') inputRef.current?.focus();
  }, [step.kind]);

  // 60s timeout to idle.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      navigate('/kiosk', { replace: true });
    }, TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [navigate]);

  function handleSelect(visitor: KioskExpectedRow) {
    setStep({ kind: 'confirm', visitor });
  }

  return (
    <div className="flex flex-1 flex-col portrait:hidden">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <Button
          variant="ghost"
          size="lg"
          className="h-14 gap-2 text-lg"
          onClick={() => {
            if (step.kind === 'search') {
              navigate('/kiosk', { replace: true });
            } else {
              setStep({ kind: 'search' });
            }
          }}
        >
          <ArrowLeft className="size-5" aria-hidden="true" />
          {step.kind === 'search' ? 'Cancel' : 'Back'}
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">
          {step.kind === 'confirm'
            ? 'Confirm your visit'
            : step.kind === 'error'
              ? "Couldn't check you in"
              : "What's your name?"}
        </h1>
        <div className="w-[120px]" />
      </header>

      <div className="flex flex-1 flex-col items-center px-6 py-8">
        {step.kind === 'search' ? (
          <SearchStep
            inputRef={inputRef}
            query={query}
            setQuery={setQuery}
            results={results}
            isFetching={search.isFetching && debounced.length > 0}
            onSelect={handleSelect}
            onWalkup={() => navigate('/kiosk/walkup')}
            empty={debounced.length > 0 && !search.isFetching && results.length === 0}
          />
        ) : null}

        {step.kind === 'confirm' ? (
          <ConfirmStep
            visitor={step.visitor}
            submitting={checkin.isPending}
            onSubmit={async (hostFirstName) => {
              try {
                const result = await checkin.mutateAsync({
                  visitorId: step.visitor.visitor_id,
                  hostFirstNameConfirmation: hostFirstName,
                });
                navigate('/kiosk/confirmation', {
                  replace: true,
                  state: {
                    hostFirstName: result.host_first_name,
                    hasReceptionAtBuilding: result.has_reception_at_building,
                    queued: false,
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

        {step.kind === 'error' ? (
          <ErrorStep
            title={step.title}
            message={step.message}
            onRetry={() => setStep({ kind: 'search' })}
          />
        ) : null}
      </div>
    </div>
  );
}

function SearchStep({
  inputRef,
  query,
  setQuery,
  results,
  isFetching,
  onSelect,
  onWalkup,
  empty,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  setQuery: (s: string) => void;
  results: KioskExpectedRow[];
  isFetching: boolean;
  onSelect: (v: KioskExpectedRow) => void;
  onWalkup: () => void;
  empty: boolean;
}) {
  return (
    <div className="flex w-full max-w-2xl flex-col gap-6">
      <Field>
        <FieldLabel htmlFor="kiosk-name" className="text-lg">
          Type your first or last name
        </FieldLabel>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-4 top-1/2 size-6 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            ref={inputRef}
            id="kiosk-name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. Anne or Visser"
            autoComplete="off"
            autoCapitalize="words"
            spellCheck={false}
            className="h-16 pl-14 pr-4 text-2xl"
          />
        </div>
        <FieldDescription>
          Reception will see your full name privately — others won't.
        </FieldDescription>
      </Field>

      <div className="flex flex-col gap-3">
        {isFetching ? (
          <div className="flex items-center gap-3 px-2 py-3 text-base text-muted-foreground">
            <Spinner className="size-4" />
            Searching…
          </div>
        ) : null}
        {results.map((row) => (
          <button
            key={row.visitor_id}
            type="button"
            onClick={() => onSelect(row)}
            className="flex items-center justify-between rounded-xl border-2 bg-card px-6 py-5 text-left transition-colors duration-150 [transition-timing-function:var(--ease-snap)] hover:border-primary/50 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px"
          >
            <div className="flex flex-col gap-1">
              <span className="text-2xl font-semibold tracking-tight">
                {row.first_name}
                {row.last_initial ? ` ${row.last_initial}.` : ''}
              </span>
              {row.company ? (
                <span className="text-base text-muted-foreground">
                  {row.company}
                </span>
              ) : null}
            </div>
            <span className="text-base font-medium text-primary">
              That's me
            </span>
          </button>
        ))}
        {empty ? (
          <div className="flex flex-col gap-4 rounded-xl border-2 border-dashed bg-muted/30 px-6 py-6 text-center">
            <p className="text-lg text-muted-foreground">
              We couldn't find a visit under that name today.
            </p>
            <Button
              size="lg"
              variant="outline"
              className="h-14 gap-2 text-lg"
              onClick={onWalkup}
            >
              <UserPlus className="size-5" aria-hidden="true" />
              I don't have an invitation
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ConfirmStep({
  visitor,
  submitting,
  onSubmit,
}: {
  visitor: KioskExpectedRow;
  submitting: boolean;
  onSubmit: (hostFirstName: string) => Promise<void>;
}) {
  const [host, setHost] = useState('');
  return (
    <form
      className="flex w-full max-w-2xl flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (!host.trim()) return;
        void onSubmit(host.trim());
      }}
    >
      <div className="flex flex-col gap-2 rounded-xl border-2 bg-card px-6 py-5">
        <span className="text-base text-muted-foreground">Checking in as</span>
        <span className="text-3xl font-semibold tracking-tight">
          {visitor.first_name}
          {visitor.last_initial ? ` ${visitor.last_initial}.` : ''}
        </span>
        {visitor.company ? (
          <span className="text-base text-muted-foreground">
            {visitor.company}
          </span>
        ) : null}
      </div>

      <Field>
        <FieldLabel htmlFor="kiosk-host" className="text-lg">
          Who are you meeting?
        </FieldLabel>
        <Input
          id="kiosk-host"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="Their first name"
          autoComplete="off"
          autoCapitalize="words"
          spellCheck={false}
          autoFocus
          className="h-16 px-4 text-2xl"
        />
        <FieldDescription>
          We use this to make sure we route you to the right person.
        </FieldDescription>
      </Field>

      <Button
        type="submit"
        size="lg"
        className="h-16 text-xl"
        disabled={!host.trim() || submitting}
      >
        {submitting ? 'Checking you in…' : 'I confirm'}
      </Button>
    </form>
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
    if (err.status === 403 && /host first name/i.test(err.message)) {
      return {
        title: "That doesn't match",
        message:
          "The host's first name we have doesn't match. Please ask reception or try again.",
      };
    }
    if (err.status === 400 && /different building/i.test(err.message)) {
      return {
        title: 'This visit is for a different building',
        message: 'Please see reception — they can help redirect you.',
      };
    }
  }
  return {
    title: "Couldn't check you in",
    message: 'Please see reception so they can help.',
  };
}
