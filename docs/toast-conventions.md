# Toast conventions

Sonner is mounted globally in `apps/web/src/App.tsx` (top-right, richColors, themed). Every call site uses the helpers in **`apps/web/src/lib/toast.ts`** — that file is the single source of truth for what a toast can look like. Don't import from `'sonner'` directly. The wrapper exists to keep voice, structure, and behavior consistent across ~90 call sites; deviating defeats the point.

If you're adding a toast, this doc is the contract.

## TL;DR — pick the right helper

| Helper | Use for | Example |
|---|---|---|
| `toastCreated(entity, { onView })` | A new entity was just created | `toastCreated('Webhook', { onView: () => navigate(`/admin/webhooks/${id}`) })` |
| `toastSaved(entity, { silent })` | An existing entity persisted; auto-save flows pass `silent: true` | `toastSaved('Webhook', { silent: opts.silent })` |
| `toastUpdated(entity)` | A discrete state change committed (status, membership, role) | `toastUpdated('Booking')` |
| `toastRemoved(entity, { verb, onUndo })` | Reversible delete / detach / revoke / archive / cancel | `toastRemoved('Member', { onUndo: () => readd() })` |
| `toastError(title, { error, retry })` | Anything failed | `toastError("Couldn't save webhook", { error: err, retry: handleSave })` |
| `toastSuccess(title)` | Generic success that doesn't fit an entity (`Reply sent`, `API key copied`) | `toastSuccess('Reply sent')` |
| `toast.message(...)` / `toast.warning(...)` | Neutral hint or partial-failure note (re-exported `toast` from the wrapper) | `toast.warning('Updated 4 of 5', { description: '1 failed: …' })` |

> **Never** call `toast.success` or `toast.error` directly — use a helper. The helpers enforce voice, retry, and undo so you don't have to remember.

## Voice rules

These are not optional. They keep the app feeling coherent.

- **Errors:** `Couldn't <verb> <thing>`. Always present-tense "couldn't", lower-case verb, the entity name. Examples: `Couldn't save webhook`, `Couldn't update status`, `Couldn't delete grant`. Never `Failed to X`, `X failed`, `Save failed`, or `Error: X`.
- **Successes:** `<Thing> <past-tense verb>`. Examples: `Webhook saved`, `Workflow published`, `Member removed`, `Cover uploaded`. Never `Successfully X`, `X has been done`, `Done!`, or just `Saved`.
- **Entity name first** for any toast about a specific thing. `Webhook saved` reads better than `Saved webhook`. The helpers handle this — `toastSaved('Webhook')` already does the right thing.
- **No emojis** in toast titles or descriptions. Sonner's icons carry that load.
- **No trailing punctuation in titles** ("Webhook saved", not "Webhook saved."). Descriptions are full sentences with periods.
- **No tech / debug copy in user-facing text.** `routing_v2_mode = v2_only` doesn't ship — `Routing mode set to v2_only` does.

## Structural rules

### Title vs description

Sonner shows the title and an optional second line for the description. **Never concatenate the error message into the title.**

```ts
// ❌ wrong — error detail jammed into the title
toast.error(`Failed to update status: ${err.message}`);

// ✅ right — title is the outcome, description is the server message
toastError("Couldn't update status", { error: err, retry: handleSave });
```

`toastError` pulls `error.message` into the description automatically. Pass `description` to override only when the server message is unhelpful and you have something clearer to say.

### Errors must offer Retry when the call can be re-fired

For any mutation that can be safely retried with the same arguments, pass `retry`. The helper renders a "Retry" action button so the user isn't stuck on a dead-end toast.

```ts
mutation.mutate(payload, {
  onError: (err) => toastError("Couldn't save vendor", {
    error: err,
    retry: () => mutation.mutate(payload),
  }),
});
```

Skip `retry` only when:
- the failure is genuinely unrecoverable (e.g. validation that depends on form state the user must change),
- or retrying would cause harm (e.g. duplicate-charge risk).

### Successful creates should offer "View"

The user just made a thing — they're 90% likely to want to look at it.

```ts
toastCreated('Webhook', {
  onView: () => navigate(`/admin/webhooks/${created.id}`),
});
```

The label defaults to "View"; pass `viewLabel` to override (e.g. "Open").

If the page already navigates immediately on success, still wire `onView` to the same route — it costs nothing and keeps a consistent action affordance.

### Reversible removes should offer "Undo"

For any delete / detach / revoke / archive / cancel that can be reversed by re-creating or flipping a flag, pass `onUndo`. The helper doubles the duration to 8 s so users have time to react.

```ts
toastRemoved('Member', {
  onUndo: () => apiFetch(`/teams/${teamId}/members`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  }).then(refetch),
});
```

Skip `onUndo` only when re-creating has dangerous side effects:
- audit log already emitted with a "removed by X" entry that can't be retracted,
- external webhook fired that can't be un-fired,
- destructive operation the user just confirmed in a `ConfirmDialog`.

For confirmed destructive deletes (the `ConfirmDialog` flow on `*-detail` pages), skip Undo — the confirm prompt is the safety net.

### Pick the right `verb` on `toastRemoved`

`toastRemoved` defaults to `removed`. Override when the past tense doesn't fit:

| `verb` | When |
|---|---|
| `removed` | Default — member, label, attachment |
| `deleted` | Permanent destruction — webhook, role, organisation |
| `detached` | Severing a link without destroying — team from org node, calendar from account |
| `revoked` | Permission / grant taken away |
| `archived` | Soft-hidden but recoverable — space, request type |
| `deactivated` | Made inactive but kept |
| `unpublished` | Workflow / template demoted |
| `cancelled` | Booking, recurring series occurrence |

Don't invent a new verb — the type union enforces this.

## Form validation is NOT a toast

Required-field errors belong **inline**, near the field, not as a toast. Toasts cover form context; users have to scan back to find what's wrong.

The right pattern is one of:

1. **Disable the submit button** when the form isn't valid. No toast at all — the button being disabled is the signal. This is the preferred pattern for single-field guards.
   ```tsx
   const canSubmit = name.trim().length > 0 && !submitting;
   <Button onClick={submit} disabled={!canSubmit}>Create</Button>
   ```

2. **Inline `<FieldError>`** when the user can submit but a field is wrong (server-side validation, format mismatch). Render it in the `<Field>` next to the offender.

3. **Single banner above the submit button** for cross-field rules ("Every scoped row needs a location and a team") that don't map to one input.
   ```tsx
   {incompleteRow && (
     <p className="mt-2 text-xs text-destructive">
       Every scoped row needs a location and a team.
     </p>
   )}
   ```

4. **`toast.message` with an action** for *contextual* preconditions where the user needs to navigate elsewhere — e.g. "Add an email to invite this person" (the email field is on a different screen). The action button takes them to the fix.

If you're tempted to write `toastError('"<field>" is required')`, stop and use approach 1 or 2. There's no exception.

## Auto-save

Detail pages with debounced field saves use a wrapper:

```ts
const save = (patch, opts: { silent?: boolean } = {}) => {
  update.mutate(patch, {
    onSuccess: () => toastSaved('Webhook', { silent: opts.silent }),
    onError: (err) => toastError("Couldn't save webhook", { error: err, retry: () => save(patch, opts) }),
  });
};

useDebouncedSave(name, (v) => save({ name: v }, { silent: true }));
```

Pass `silent: true` from debounced field changes; the helper becomes a no-op. The toast still fires on explicit Save clicks (where `silent` isn't passed) and on every error. **Never wrap your own `if (!opts.silent)` around the call** — `toastSaved` already does it.

## When generic `toastSuccess` is right

Three cases:

1. **No clean entity to name.** `Reply sent`, `API key copied`, `Checked in`, `Cover uploaded`, `Conflict resolved`. The user's mental model isn't "the thing", it's the action.
2. **Compound state change.** `Status set to Resolved`, `Priority set to High` — describing the new state is clearer than "Ticket updated".
3. **Custom action affordance** — the create / remove helpers are too rigid for what you need.

   ```ts
   toastSuccess('Workflow cloned', {
     action: { label: 'Open', onClick: () => navigate(`/admin/workflow-templates/${id}`) },
   });
   ```

   Still prefer `toastCreated` / `toastRemoved` when they fit; reach for `toastSuccess + action` only when they don't.

## Patterns to avoid

| Anti-pattern | Why | Use instead |
|---|---|---|
| `toast.success('Saved')` | Tells the user nothing about what was saved | `toastSaved('Webhook')` |
| `toast.error('Failed to X')` | Verb-first, dead-end, no retry | `toastError("Couldn't X", { error, retry })` |
| ``toast.error(`X failed: ${err.message}`)`` | Detail jammed into title | `toastError("Couldn't X", { error: err })` |
| `toast.error('Field is required')` | Validation belongs inline | Disable submit, or `<FieldError>` |
| `toast.success('Member removed')` | No Undo for a reversible op | `toastRemoved('Member', { onUndo: …​ })` |
| `toast.success('Webhook created')` | No follow-up to view it | `toastCreated('Webhook', { onView: …​ })` |
| `toast.error(...)` with no `retry` for a re-runnable mutation | User stuck on a dead-end toast | Add `retry: () => mutation.mutate(args)` |
| Auto-save firing `toast.success` on every keystroke | Notification spam | `toastSaved(entity, { silent: true })` from the debounced path |
| Tech / variable names in the title (`routing_v2_mode = …`) | User-hostile | Translate to user words; keep the variable in audit log |

## Adding a new helper

The wrapper is intentionally small. Before adding a new helper:

1. Can it be expressed as `toastSuccess(title, { action })` or one of the existing helpers? If yes, use that.
2. Is it reused in **at least 3 call sites**? If not, keep it inline.
3. Does it enforce a UX rule (voice, action, duration) that the existing helpers can't? If yes, propose it; otherwise the bar is reuse, not novelty.

The wrapper lives at `apps/web/src/lib/toast.ts`. Add the helper there with frontmatter docs, update this doc, and migrate at least one call site as a worked example in the same PR.

## Reference: Sonner setup

The mount lives in `apps/web/src/App.tsx`:

```tsx
<Toaster position="top-right" richColors />
```

The themed wrapper at `apps/web/src/components/ui/sonner.tsx` injects Lucide icons (`CircleCheckIcon`, `OctagonXIcon`, etc.) and binds toast tokens to `--popover` / `--popover-foreground` / `--border` / `--radius`. Don't override these per-toast — if you need different chrome, you're probably building the wrong thing.
