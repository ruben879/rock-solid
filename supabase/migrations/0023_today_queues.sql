-- Today's list, shared by each person's phone so the morning nudge can name people from it.
-- One row per person: the day, the current set (ids) and the people still waiting in Today order (queue).
-- Only the person reads or writes their own row; the nudge reads it on the server. Run after 0022.
create table if not exists public.today_queues (
  agent_id uuid primary key references public.profiles(id) on delete cascade,
  day date not null,
  ids jsonb not null default '[]'::jsonb,
  queue jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.today_queues enable row level security;

drop policy if exists "see my today queue" on public.today_queues;
create policy "see my today queue" on public.today_queues for select using (agent_id = auth.uid());
drop policy if exists "add my today queue" on public.today_queues;
create policy "add my today queue" on public.today_queues for insert with check (agent_id = auth.uid());
drop policy if exists "update my today queue" on public.today_queues;
create policy "update my today queue" on public.today_queues for update using (agent_id = auth.uid()) with check (agent_id = auth.uid());

revoke all on public.today_queues from anon;
grant select, insert, update on public.today_queues to authenticated;
grant all on public.today_queues to service_role;
