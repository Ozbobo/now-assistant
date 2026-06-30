# v7 — Accounts, User-Scoped Persistence, Weekly Stats

**Date:** 2026-06-30
**Status:** Approved (design)

## Decisions (from the user)

- **Accounts: on now.** Multi-user via email **6-digit code** (OTP), not magic link — so the
  home-screen PWA logs in reliably (a magic link opens Safari, a separate storage context).
- **Data: fresh start.** Drop the existing single-user `task_instances` and recreate it
  user-scoped. Existing test check-offs are discarded.

## Goals

1. Each person signs in with their email; their check-offs and stats are private (RLS).
2. Per-user persistence (already working for writes; now scoped to `auth.uid()`).
3. Weekly stats: one summary row per user per week + a compact week dot-bar + a history list.

Non-goals (future addendum): per-user custom schedules. All users share the hardcoded
`tasks.js` schedule for now.

## Architecture

The app is build-step-free vanilla JS (`tasks.js` → `NOW_DATA`, `supabase.js` → `NOW_DB`,
`app.js` → engine, all IIFEs loaded via `<script>`). Auth needs the Supabase client library,
loaded from a CDN as an ES module — **no build step added**.

### Load order change

Today: `supabase.js`, `tasks.js`, `app.js` (all classic, app auto-starts on DOMContentLoaded).

New: `tasks.js` (classic) → `app.js` (classic, **no longer auto-starts** — exposes
`window.NOW_APP = { start }`) → `supabase.js` as `<script type="module">` **last**. ES modules
are deferred, so the module runs after the classic scripts have defined everything. The module
creates the authed client, defines `window.NOW_DB`, runs the auth gate, and calls
`NOW_APP.start()` only once a session exists.

`app.js` change is minimal: read `DB = window.NOW_DB` inside `start()` (not at IIFE top, since
the module hasn't run yet), and expose `start` instead of calling it. Everything else (cards,
tasks, carryover, calendar, voice) is unchanged.

### supabase.js (rewritten as a module)

Imports `createClient` from `https://esm.sh/@supabase/supabase-js@2`. Keeps the **same
`NOW_DB` interface** so `app.js` barely changes:

- `ensureInstances`, `fetchByDate`, `fetchCarryover`, `fetchWeek`, `setCompleted`,
  `setDismissed`, `parseVoice` — reimplemented with `sb.from('task_instances')…` and
  `sb.functions.invoke('parse-voice', …)`. Writes include `user_id`; reads rely on RLS.
  Same return contract (array|null for reads, bool for writes, object|null for parseVoice) so
  the existing fail-silent/offline handling in `app.js` still holds.
- New stats methods: `getWeeklyStats(limit)`, `getWeeklyStat(weekStart)`,
  `insertWeeklyStat(row)`, `deleteInstancesBefore(dateKey)`.

Also owns auth: `sendCode(email)` → `signInWithOtp`; `verifyCode(email, token)` →
`verifyOtp({ type: 'email' })`; `signOut()` → `auth.signOut()` then `location.reload()`
(simplest reset of in-memory state). On `getSession()`/`onAuthStateChange` SIGNED_IN, hide the
login view, show the app, and `NOW_APP.start()` once (guarded by a `started` flag).

## Data model (schema.sql — fresh)

```
drop table if exists task_completions cascade;
drop table if exists task_instances cascade;

task_instances ( id uuid pk, user_id uuid -> auth.users on delete cascade,
  task_key text, assigned_date date, completed_at timestamptz, dismissed_at timestamptz,
  created_at timestamptz default now(), unique(user_id, task_key, assigned_date) )
  index (user_id, assigned_date)
  RLS: select/insert/update/delete where auth.uid() = user_id

weekly_stats ( id uuid pk, user_id uuid -> auth.users on delete cascade,
  week_start_date date,  -- Monday
  completion_percentage int, days_complete int, days_partial int, days_zero int,
  days text,             -- 7 chars Mon..Sun: c|p|z|- (deviation from spec, see below)
  created_at timestamptz default now(), unique(user_id, week_start_date) )
  index (user_id, week_start_date desc)
  RLS: select/insert where auth.uid() = user_id
```

**Deviation from spec:** added a `days` column (7-char per-day status string). The spec's
weekly-history UI shows a 7-dot Mon–Sun breakdown, but its schema only stored aggregate counts
(`days_complete/partial/zero`) — which can't reconstruct the per-day sequence. The extra column
stores it cheaply.

## Weekly rollup

On load after auth: if last week (`mondayOf(today) - 7`) has no `weekly_stats` row, compute it
from that week's `task_instances` (scheduled count per day = `tasksForDay(dayNum).length`),
insert the summary (+`days` string), then `deleteInstancesBefore(mondayOf(today))` to keep
storage tiny.

**Behavior change to flag:** deleting daily rows older than this Monday means **carryover now
resets weekly** — last week's unfinished tasks won't drag into the new week as carryover.
Within the current week, carryover still works (those rows are ≥ this Monday). The calendar
shows the current week only, so it's unaffected.

## UI additions

- **Week dot-bar** (`#week-bar`, above Today's Tasks): 7 dots Mon→Sun with day initials.
  green = all scheduled done; amber = some; red = a past day with none; dim = today/future.
  Today gets a ring. Computed from current-week instances + scheduled counts.
- **Weekly Stats** (`#weekly-stats`, below the calendar): rows of `Week of <date> · NN% · ●●◐○…`
  from `weekly_stats` (desc, limit ~12), dots rendered from the `days` string.
- **Login view** (`#login-view`, full-screen overlay): NOW title, email input, "Send code",
  then code input + "Verify", status line. Styled in existing ink/paper/tangerine tokens.
- **Sign out**: small control in the footer near Refresh.

## Manual Supabase steps (user does these; I provide exact clicks)

1. Authentication → Sign In / Providers → enable **Email**.
2. Authentication → Email Templates → **Magic Link** template: include the code `{{ .Token }}`
   in the body (so the email delivers a 6-digit code, not just a link).
3. Authentication → URL Configuration → Site URL + Redirect URLs:
   `https://ozbobo.github.io/now-assistant/`.
4. SQL Editor → run the new `schema.sql`.

## Risks / edge cases

- **iOS PWA login** — solved by the OTP-code flow (login happens in-context).
- **Session longevity** — Supabase session is in localStorage; iOS Safari ITP may evict it
  after ~7 days idle, requiring re-login. Acceptable.
- **Voice Edge Function** — unchanged; still `verify_jwt = false`, now invoked via the client
  (JWT attached, ignored by the function). Still works.
- **Offline** — reads return null → app keeps last in-memory state, same as today.

## Testing (must pass before shipping)

1. Sign in with email code → app appears. 2. Check a task → close tab → reopen → still checked.
3. Second account sees none of the first's data. 4. Dot-bar reflects today's completions.
5. Voice still checks off + replies. 6. Sign out → login view returns.
