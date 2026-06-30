-- NOW assistant — Supabase schema (v7: accounts + user-scoped data + weekly stats)
-- Run this in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- This DROPS the old single-user tables and recreates them scoped to a user.
-- Safe to re-run (idempotent).

-- ── Clean slate ─────────────────────────────────────────────────────────────
drop table if exists public.task_completions cascade;   -- ancient v1
drop table if exists public.task_instances   cascade;   -- pre-v7 (single-user)
drop table if exists public.weekly_stats      cascade;

-- ── 1. task_instances — one row per (user, task, day) ───────────────────────
create table public.task_instances (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  task_key      text not null,
  assigned_date date not null,              -- the day the task was originally for
  completed_at  timestamptz,               -- null = not yet completed
  dismissed_at  timestamptz,               -- null = not dismissed (skipped)
  created_at    timestamptz default now(),
  unique (user_id, task_key, assigned_date)
);

create index task_instances_user_date_idx
  on public.task_instances (user_id, assigned_date);

alter table public.task_instances enable row level security;

-- Each user sees and writes only their own rows (auth.uid() = user_id).
drop policy if exists "own instances select" on public.task_instances;
drop policy if exists "own instances insert" on public.task_instances;
drop policy if exists "own instances update" on public.task_instances;
drop policy if exists "own instances delete" on public.task_instances;

create policy "own instances select"
  on public.task_instances for select to authenticated using (auth.uid() = user_id);
create policy "own instances insert"
  on public.task_instances for insert to authenticated with check (auth.uid() = user_id);
create policy "own instances update"
  on public.task_instances for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own instances delete"
  on public.task_instances for delete to authenticated using (auth.uid() = user_id);

-- ── 2. weekly_stats — one summary row per (user, week) ──────────────────────
-- `days` is a 7-char Mon..Sun status string so the history view can redraw the
-- per-day dots: c = all done, p = partial, z = zero (a passed day with none),
-- - = not evaluated (no tasks scheduled, or future).
create table public.weekly_stats (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users (id) on delete cascade,
  week_start_date       date not null,      -- Monday of that week
  completion_percentage int  not null,      -- 0–100
  days_complete         int  not null,      -- days at 100% (0–7)
  days_partial          int  not null,      -- days with some but not all (0–7)
  days_zero             int  not null,      -- days with nothing checked (0–7)
  days                  text not null default '-------',  -- 7 chars, Mon..Sun
  created_at            timestamptz default now(),
  unique (user_id, week_start_date)
);

create index weekly_stats_user_week_idx
  on public.weekly_stats (user_id, week_start_date desc);

alter table public.weekly_stats enable row level security;

drop policy if exists "own stats select" on public.weekly_stats;
drop policy if exists "own stats insert" on public.weekly_stats;

create policy "own stats select"
  on public.weekly_stats for select to authenticated using (auth.uid() = user_id);
create policy "own stats insert"
  on public.weekly_stats for insert to authenticated with check (auth.uid() = user_id);
