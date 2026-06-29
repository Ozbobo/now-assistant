-- NOW assistant — Supabase schema
-- Run this in the Supabase dashboard: SQL Editor → New query → paste → Run.

-- 1. Table -------------------------------------------------------------------
create table if not exists public.task_completions (
  id              uuid primary key default gen_random_uuid(),
  task_key        text not null,
  completion_date date not null,
  completed_at    timestamptz default now(),
  unique (task_key, completion_date)
);

-- Fast lookups by date (the only query the app runs on load)
create index if not exists task_completions_date_idx
  on public.task_completions (completion_date);

-- 2. Row Level Security ------------------------------------------------------
-- Solo app: the anon (publishable) key may read/insert/delete its own task
-- completions. No user data, no secrets — just checkmarks.
alter table public.task_completions enable row level security;

-- Policies are dropped first so this script is safe to re-run.
drop policy if exists "anon can read completions"   on public.task_completions;
drop policy if exists "anon can insert completions" on public.task_completions;
drop policy if exists "anon can delete completions" on public.task_completions;

create policy "anon can read completions"
  on public.task_completions
  for select
  to anon
  using (true);

create policy "anon can insert completions"
  on public.task_completions
  for insert
  to anon
  with check (true);

create policy "anon can delete completions"
  on public.task_completions
  for delete
  to anon
  using (true);
