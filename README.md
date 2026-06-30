# NOW

A single-page personal web app that tells me what I should be doing **right now**
based on the day and time, shows my day's tasks (with suggested times), carries
unfinished tasks forward, and lays the whole week out in a calendar. Check-offs
persist to Supabase so they survive refreshes and sync across devices. I can also
**check tasks off by voice** — tap the mic, say what I finished, and the matching
tasks tick themselves.

Mobile-first. Built to live on the iPhone home screen as a PWA. No framework,
no build step — just static files.

**Live:** https://ozbobo.github.io/now-assistant/

---

## Files

| File                   | Purpose                                                          |
|------------------------|------------------------------------------------------------------|
| `index.html`           | Markup + PWA meta tags                                            |
| `style.css`            | Design tokens, card states, checkbox/calendar styling            |
| `tasks.js`             | **Data only** — time blocks, per-day tasks + suggested times     |
| `app.js`               | Engine — now/next, today list, carryover, calendar, sync         |
| `supabase.js`          | Supabase URL + key + REST helpers (fail-silent if offline)       |
| `manifest.webmanifest` | PWA manifest                                                     |
| `icon.svg`             | App icon                                                         |
| `schema.sql`           | Supabase `task_instances` table + RLS policies                   |
| `supabase/functions/parse-voice/index.ts` | Edge Function — voice transcript → task_keys (Claude) |

To change the schedule or tasks, edit **`tasks.js`** — it's plain data.

---

## Setup

### 1. Supabase

The URL and key are already wired into `supabase.js`. Create the table:

1. Open your project → **SQL Editor** → **New query**.
2. Paste the contents of [`schema.sql`](./schema.sql) and click **Run**.

That creates `task_instances`, its indexes, enables Row Level Security, and adds
policies letting the `anon` (publishable) key read/insert/update rows. Safe to
re-run. (It also drops the old v1 `task_completions` table, which held no data.)

> The publishable key in `supabase.js` is meant to be public — that's what it's
> for. Access is constrained by the RLS policies. Never put the `service_role`
> key in this repo.

Until you run this, the app still works — check-offs just stay in memory and
don't persist (you'll see fail-silent `404` warnings in the console).

### 2. Deploy to GitHub Pages

Already deployed at the live URL above. To push updates:

```bash
git add .
git commit -m "your message"
git push
```

GitHub Pages rebuilds automatically (~30–60s). Pages requires a **public** repo
on the free plan.

### 3. Voice — Edge Function

The mic button needs the `parse-voice` Edge Function deployed, with your Anthropic
API key set as a secret. This is the **only** place the key lives — it never
reaches the browser. The function parses each voice command into checked-off tasks
and/or a spoken reply.

You'll need the [Supabase CLI](https://supabase.com/docs/guides/cli) and an
[Anthropic API key](https://console.anthropic.com/).

```bash
# One-time: link this repo to your Supabase project (project ref from the dashboard URL)
supabase login
supabase link --project-ref zwzndwbcksggntlvgdag

# Set the key as a secret (stays server-side)
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

# Deploy the function. --no-verify-jwt lets the app call it with the public
# publishable key (the function is safe to expose: the secret stays on the server).
supabase functions deploy parse-voice --no-verify-jwt
```

The function calls **Claude Haiku 4.5** (`claude-haiku-4-5`) once per voice command
— a few hundred tokens each, so cost is negligible. Until it's deployed, the rest
of the app works fine; tapping the mic just shows a "couldn't reach the voice
service" toast.

### 4. Add to iPhone home screen

Open the live URL in **Safari** → **Share** → **Add to Home Screen**.

---

## How it works

- **Now / Up next** are computed from the device's local clock (`new Date()`).
- **Today's Tasks** show the day's tasks sorted by **suggested time**, each with
  a checkbox. Checking upserts a `task_instances` row (`completed_at = now()`).
- **Carryover** — any task from an earlier day that's still open (not completed,
  not dismissed) appears in a **Carried Over** block at the top of today, tagged
  and labelled with its original date. Completing or dismissing it clears it.
- **Dismiss** — skip a task without completing it. Carryover tasks always show a
  `×`; today's tasks reveal one on **long-press** (~0.5s). Dismissing sets
  `dismissed_at` so the task won't carry forward or reappear.
- **This Week** — a 7-day calendar (Mon–Sun). Today is highlighted with a
  `TODAY` pill; past days fade and show a `X of Y completed · Z carried forward`
  summary; future days look normal. Checking a task anywhere (today list or
  calendar) updates everywhere — it's one in-memory source of truth.
- **Voice** — the floating mic handles **both commands and questions**, and Claude
  talks back:
  - *Check off* — *"I finished the morning creative and launched the Meta batch"* →
    those tasks tick off.
  - *Ask* — *"What should I be doing now?"*, *"What's next?"*, *"What's left today?"*,
    *"Did I do the Meta batch yet?"* → Claude answers out loud.

  The browser transcribes the speech (Web Speech API) and sends the transcript plus
  the day's context (current block, next block, every task with its status) to a
  Supabase Edge Function. Claude (Haiku 4.5) decides whether it's a check-off, a
  question, or both, returns the matched `task_key`s and a short spoken `reply`;
  matches are checked off through the normal sync path (already-done tasks are left
  alone), and the reply is **spoken aloud** (browser text-to-speech) **and** shown
  as a toast — so it works hands-free, hands-busy, or in a noisy room. Tapping the
  mic again cancels any speech and listens fresh. The mic is hidden on browsers
  without speech recognition (works in Chrome and iOS Safari). **No API key ever
  touches the browser** — the Anthropic key lives only in the Edge Function as a
  Supabase secret. Needs the [Edge Function deployed](#3-voice--edge-function).
- **Every minute** the now block recomputes. Crossing **midnight** rebuilds the
  day and re-pulls instances; yesterday's completed tasks drop off, unfinished
  ones become carryover.
- **Offline / Supabase down** → fails silently. Everything works in memory; the
  next action made while online syncs.

### How carryover is tracked

On load, the app **upserts an instance row for each of today's tasks** (with
`completed_at`/`dismissed_at` null). That's what lets an untouched task be
detected as "open" tomorrow. Carryover therefore covers any day the app was
opened; a day you never opened the app won't generate carryover.

---

## Editing the schedule

Everything lives in `tasks.js`:

- `WEEKDAY_BLOCKS` / `WEEKEND_BLOCKS` — the NOW/next time blocks. Times use the
  `H(hour, minute)` helper (minutes-from-midnight).
- `TRAINING_BY_DAY` — which training fills the 10:00–13:00 weekday slot.
- `DAY_LABEL` — the tag shown on the NOW card and calendar days.
- `TASKS_BY_DAY` — the checkable tasks per weekday. Each needs a stable, unique
  `key` (the DB identifier — changing it orphans history), a `tag`
  (`tiktok` / `meta` / `weekend`, color-coding only), and a `time`
  (suggested time in minutes, via `H()`), used for sorting and display.
