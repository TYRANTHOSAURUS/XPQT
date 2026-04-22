# Ticket Workflow Capability Matrix

Date: 2026-04-21

Scope:
- Current worktree: `feat/reclassify-ticket`
- New routing work: `.worktrees/routing-studio` on `feat/routing-studio`

## Legend

- Status values:
  - `Yes`
  - `Mostly yes`
  - `Partial`
  - `Work in progress`
  - `No`
  - `Discouraged`
- Verdict values:
  - `Use now`
  - `Use with caveat`
  - `Avoid`
  - `Future`
- Approval values:
  - `None`
  - `Optional`
  - `Yes`

## Best Supported Complex Pattern

```text
request type
  -> optional approval
  -> parent case owned by internal team
  -> workflow/manual dispatch creates child work orders
  -> each child assigned to team / user / vendor
  -> each child gets its own SLA
  -> visibility handled independently
```

## 1. Master Matrix

```text
ID  Pattern                               Parent  Children         Approval  Visibility        SLA                Current repo      Routing-studio    Verdict           Note
--  ------------------------------------  ------  ---------------  --------  ----------------  -----------------  ----------------  ----------------  ----------------  ----------------------------------------
A   Team-owned case only                  Team    None             Optional  Standard          Case only          Yes               Yes               Use now           Simplest supported shape
B   Team-owned case + internal child      Team    Team/User        Optional  Independent       Case + child       Yes               Yes               Use now           Good desk -> specialist handoff
C   Team-owned case + vendor child        Team    Vendor           Optional  Vendor weak       Case + child       Partial           Work in progress  Use with caveat   Ops good; vendor visibility still weak
D   Team-owned case + mixed children      Team    Team/User/Vndr   Optional  Mixed, vendor OK  Separate per child Mostly yes        Work in progress  Use now           Best current "all at once" shape
E   Parent directly owned by vendor       Vendor  Optional         Optional  Ownership muddy   SLA model awkward  Discouraged       No                Avoid             New model is pushing this away
F   Policy owner + policy split + policy
    child routing                         Team    Policy multi     Optional  Explicit hints    Separate clocks    No                Work in progress  Future            Routing-studio target state
G   Approval -> create children -> wait
    -> timer -> notify -> HTTP            Team    One or many      Yes       Standard          Separate clocks    Mostly yes        Mostly yes        Use with caveat   Missing true parallelism + auto resume
H   Vendor-only child visibility          Team    Vendor           Optional  Vendor only       Separate clocks    No                Work in progress  Future            Design exists; runtime not finished
```

## 2. Parent Ownership Matrix

```text
Option                                  Current repo      Routing-studio    Verdict   Note
--------------------------------------  ----------------  ----------------  --------  ----------------------------------------------
Team owns parent case                   Yes               Yes               Use now   Canonical model
User owns parent case                   Partial           No                Avoid     Row exists, but model is team-first
Vendor owns parent case                 Discouraged       No                Avoid     Better as child execution, not ownership
Request-type default team               Yes               Yes               Use now   Stable fallback
Request-type default vendor             Discouraged       No                Avoid     Legacy shape, wrong direction
Location-based parent ownership         Yes               Work in progress  Use now   Current resolver does this today
Support-window-aware parent ownership   No                Work in progress  Future    Planned in case_owner_policy rows
Rule-based parent -> team/user          Yes               Yes               Use now   Current rules support team/user targets
Rule-based parent -> vendor             No                No                Future    Still a gap
```

## 3. Child Execution Matrix

```text
Option                                  Current repo      Routing-studio    Verdict           Note
--------------------------------------  ----------------  ----------------  ----------------  ------------------------------------------------
Manual child -> team                    Yes               Yes               Use now           Supported in desk UI and API
Manual child -> user                    Yes               Yes               Use now           Supported in desk UI and API
Manual child -> vendor                  Yes               Yes               Use now           First-class pattern
Workflow child -> team                  Yes               Yes               Use now           Editor supports it
Workflow child -> user                  Partial           Partial           Use with caveat   Engine can forward it; editor does not expose it
Workflow child -> vendor                Partial           Partial           Use with caveat   Same as above
Unassigned child allowed                Yes               Yes               Use with caveat   Fine for misses/fallback gaps
Child routed by asset                   Yes               Partial           Use now           Strong in legacy; incomplete in new child resolver
Child routed by location                Yes               Yes               Use now           Strong path
Child routed by asset then location     Yes               Partial           Use now           Legacy auto path is better today
Fixed child target = team               Yes               Yes               Use now           Good for simple lanes
Fixed child target = vendor             Yes               Yes               Use now           Good for contracted work
Many children by repeated actions       Yes               Yes               Use now           Works now
Multi-child split per location          No                Work in progress  Future            Schema exists; split engine still emits one plan
Multi-child split per asset             No                Work in progress  Future            Same
Multi-child split per vendor/service    No                Work in progress  Future            Same
Dispatch mode = none                    Partial           Work in progress  Use now           Behavioral today, explicit in new policy
Dispatch mode = optional                Partial           Work in progress  Use now           Same
Dispatch mode = always                  Partial           Work in progress  Use now           Same
Dispatch mode = multi-template          No                Work in progress  Future            Design exists, not runtime
```

## 4. Authorization / Visibility Matrix

```text
Option                                  Current repo      Routing-studio    Verdict           Note
--------------------------------------  ----------------  ----------------  ----------------  ------------------------------------------------
Requester sees own case                 Yes               Yes               Use now           Participant path
Assigned user sees ticket               Yes               Yes               Use now           Participant path
Assigned team members see ticket        Yes               Yes               Use now           Operator path
Watchers see ticket                     Yes               Yes               Use now           Participant path
Role-scoped domain + location           Yes               Yes               Use now           Core operator model
tickets:read_all / tickets:write_all    Yes               Yes               Use now           Override model
Vendor participant visibility           Partial           Partial           Use with caveat   Explicitly documented as incomplete
Parent owner sees spawned children      Partial           Work in progress  Use with caveat   More implicit today; more explicit in new branch
Vendor sees only own child tickets      Partial           Work in progress  Use with caveat   Product intent is clear; runtime still weak
Cross-location overlay visibility       Partial           Work in progress  Future            Modeled as a new routing-owned hint
Bulk update checks visibility           No                No                Future            Current gap
Reporting checks visibility             No                No                Future            Current gap
Search checks visibility                No                No                Future            Search endpoint not built
```

## 5. SLA Matrix

```text
Option                                  Current repo      Routing-studio    Verdict   Note
--------------------------------------  ----------------  ----------------  --------  ------------------------------------------------
Case SLA from request type              Yes               Yes               Use now   Requester-facing clock
Child SLA independent from case         Yes               Yes               Use now   Executor-facing clock
Child SLA explicit on manual dispatch   Yes               Yes               Use now   Sub-issue dialog supports it
Child SLA explicit in workflow task     Yes               Yes               Use now   Per-task SLA picker exists
Child SLA from vendor default           Yes               Yes               Use now   Vendor wins before team default
Child SLA from team default             Yes               Yes               Use now   Supported
Child SLA from assigned user's team     Yes               Yes               Use now   Supported
Child explicitly has no SLA             Yes               Yes               Use now   Supported
Child SLA editable after dispatch       Yes               Yes               Use now   Restarts timers
Case SLA editable after create          No                No                Avoid     Locked by design
SLA changes automatically on reassign   No                No                Avoid     Explicitly rejected
Business-hours per SLA policy           Yes               Yes               Use now   Current model
Business-hours per team/vendor          No                No                Future    Not modeled
SLA threshold / at-risk / breach        Yes               Yes               Use now   Available now
```

## 6. Approval + Workflow Matrix

```text
Option                                  Current repo      Routing-studio    Verdict           Note
--------------------------------------  ----------------  ----------------  ----------------  ------------------------------------------------
Approval required by request type       Yes               Yes               Use now           Current request-type setting
Approval approver = person              Yes               Yes               Use now           Supported
Approval approver = team                Yes               Yes               Use now           Supported
Approval chain = sequential             Partial           Partial           Future            Service can do it; editor cannot model it well
Approval group = parallel               Partial           Partial           Future            Same
Workflow assign -> team                 Yes               Yes               Use now           Supported
Workflow assign -> user                 Yes               Yes               Use now           Supported
Workflow assign -> vendor               No                No                Future            Assign node does not support vendor target
Workflow create child tasks             Yes               Yes               Use now           Strong current path
Workflow wait for child tasks           Yes               Yes               Use now           Supported
Workflow wait for status/event          Yes               Yes               Use now           Supported
Workflow timer                          Partial           Partial           Use with caveat   Wait exists; resume is manual
Workflow notification                   Yes               Yes               Use now           Supported
Workflow HTTP request                   Yes               Yes               Use now           Supported
True parallel workflow execution        No                No                Future            Engine remains single-path
```

## 7. "All At Once" Mix Matrix

```text
Scenario                                Current repo      Routing-studio    Verdict           Note
--------------------------------------  ----------------  ----------------  ----------------  ------------------------------------------------
Team-owned parent + approval + one
internal child + one vendor child
+ separate child SLAs                   Mostly yes        Work in progress  Use now           Best-supported complex pattern

Team-owned parent + many children
across team/user/vendor + wait for
completion + parent auto-rollup         Mostly yes        Work in progress  Use now           Works; visibility weaker than routing

Team-owned parent + vendor child +
vendor-only access + parent owner
access + requester sees only case       Partial           Work in progress  Use with caveat   Runtime visibility is the weak spot

User-owned parent + vendor child +
team overlays + separate child SLAs     Partial           No                Avoid             Works against the direction of the model

Vendor-owned parent + vendor child +
requester-facing case lifecycle         Discouraged       No                Avoid             Conflates ownership and execution

Support-window owner + multi-location
split + per-vendor execution plan +
explicit child visibility modes         No                Work in progress  Future            Broad routing-studio promise, not current reality

Approval -> create children -> wait
-> timer -> notify -> outbound HTTP     Mostly yes        Mostly yes        Use with caveat   Missing auto timer resume + parallelism
```

## 8. Recommended vs Avoided Shapes

```text
Shape                                   Verdict   Why
--------------------------------------  --------  ----------------------------------------------
Internal team owns parent; children
do execution                            Use now   Clean split between accountability and execution

Child vendor gets its own SLA; parent
keeps desk SLA                          Use now   Strongest current implementation

Visibility configured separately from
assignee                                Use now   Matches docs and routing-studio direction

Parent case directly assigned to
vendor                                  Avoid     Weakens ownership, visibility, SLA semantics

Assume vendor portal-grade visibility
is finished                             Avoid     Not true yet

Assume routing-studio multi-split is
already live                            Avoid     Schema exists; runtime is still MVP
```

## 9. Routing-Studio Delta

```text
Area                    Current repo                            Routing-studio delta                          State
----------------------  -------------------------------------  --------------------------------------------  ----------------
Parent ownership        Resolver-driven legacy tables          case_owner_policy, team-only targets          Work in progress
Child dispatch          Behavior, not one policy object        child_dispatch_policy                         Work in progress
Split orchestration     Repeated actions / workflow arrays     Dedicated split-orchestration service         Work in progress
Child execution         Legacy resolver + dispatch paths       Dedicated child execution resolver            Work in progress
Visibility              Separate runtime/docs, weak UI         Explicit visibility axis + inheritance hints  Work in progress
Simulator               Resolver simulator only                Full Routing Studio surface                   Work in progress
```

## 10. Practical Bottom Line

```text
Question                                         Answer
-----------------------------------------------  ---------------------------------------------------------------
Can you do complex mixed workflows today?        Yes, if the parent stays team-owned and children do execution.
Can you mix team, user, vendor, approval,
child tickets, and SLAs at once?                 Yes, mostly.
Where does it break down today?                  Vendor visibility, vendor rule targets, assign-to-vendor,
                                                 multi-split runtime, support-window ownership, parallelism.
What is the new worktree changing?               Stricter parent ownership, explicit child-dispatch policy,
                                                 and less implicit visibility semantics.
```

## Sources Checked

Current repo:
- `docs/assignments-routing-fulfillment.md`
- `docs/visibility.md`
- `docs/service-management-current-state-review-2026-04-20.md`
- `docs/routing-studio-improvement-plan-2026-04-21.md`
- `apps/api/src/modules/ticket/dispatch.service.ts`
- `apps/api/src/modules/ticket/ticket.service.ts`
- `apps/api/src/modules/workflow/workflow-engine.service.ts`
- `apps/web/src/components/desk/add-sub-issue-dialog.tsx`
- `apps/web/src/components/workflow-editor/inspector-forms/create-child-tasks-form.tsx`
- `apps/web/src/components/admin/request-type-dialog.tsx`

Routing-studio worktree:
- `.worktrees/routing-studio/apps/api/src/modules/routing/policy-validators.ts`
- `.worktrees/routing-studio/apps/api/src/modules/routing/routing-evaluator.service.ts`
- `.worktrees/routing-studio/apps/api/src/modules/routing/split-orchestration.service.ts`
- `.worktrees/routing-studio/apps/api/src/modules/routing/child-execution-resolver.service.ts`
- `.worktrees/routing-studio/apps/web/src/pages/admin/routing-studio.tsx`
- `.worktrees/routing-studio/apps/web/src/components/admin/routing-studio/overview-tab.tsx`
- `.worktrees/routing-studio/apps/web/src/components/admin/routing-studio/simulator.tsx`
- `.worktrees/routing-studio/apps/web/src/components/admin/routing-studio/case-ownership-editor.tsx`
