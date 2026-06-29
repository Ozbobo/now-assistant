-- NOW assistant — Supabase schema (v2: task_instances)
-- Run this in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- Safe to re-run.

-- Fresh setup: the original v1 table held no data worth keeping.
drop table if exists public.task_completions;

-- 1. Table -------------------------------------------------------------------
create table if not exists public.task_instances (
  id            uuid primary key default gen_random_uuid(),
  task_key      text not null,
  assigned_date date not null,            -- the day the task was originally for
  completed_at  timestamptz,              -- null = not yet completed
  dismissed_at  timestamptz,              -- null = not dismissed (skipped)
  created_at    timestamptz default now(),
  unique (task_key, assigned_date)
);

create index if not exists task_instances_date_idx
  on public.task_instances (assigned_date);

-- Partial index: the carryover query hits "open" rows constantly.
create index if not exists task_instances_open_idx
  on public.task_instances (completed_at) where completed_at is null;

-- 2. Row Level Security ------------------------------------------------------
-- Solo app: the anon (publishable) key may read/insert/update its own rows.
-- UPDATE is required because completing/dismissing/uncompleting are upserts
-- (INSERT ... ON CONFLICT DO UPDATE). No DELETE — nothing is ever destroyed.
alter table public.task_instances enable row level security;

drop policy if exists "anon can read instances"   on public.task_instances;
drop policy if exists "anon can insert instances" on public.task_instances;
drop policy if exists "anon can update instances" on public.task_instances;

create policy "anon can read instances"
  on public.task_instances for select to anon using (true);

create policy "anon can insert instances"
  on public.task_instances for insert to anon with check (true);

create policy "anon can update instances"
  on public.task_instances for update to anon using (true) with check (true);
