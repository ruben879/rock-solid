-- Encouragement: the broker (or an agent's coach) sends a short note. It pops up the next time that agent opens the app.
create table if not exists public.cheers (
  id uuid primary key default gen_random_uuid(),
  brokerage_id uuid not null references public.brokerages(id) on delete cascade,
  from_id uuid not null references public.profiles(id) on delete cascade,
  from_name text not null,
  to_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now(),
  seen_at timestamptz
);
create index if not exists cheers_to on public.cheers (to_id, seen_at);
alter table public.cheers enable row level security;

drop policy if exists "see my cheers" on public.cheers;
create policy "see my cheers" on public.cheers for select using (to_id = auth.uid() or from_id = auth.uid());

drop policy if exists "send cheers" on public.cheers;
create policy "send cheers" on public.cheers for insert with check (
  from_id = auth.uid() and brokerage_id = public.current_brokerage()
  and exists (select 1 from public.profiles p where p.id = to_id and p.brokerage_id = public.current_brokerage()
    and (public.is_broker() or p.coach_id = auth.uid()))
);

drop policy if exists "mark cheers seen" on public.cheers;
create policy "mark cheers seen" on public.cheers for update using (to_id = auth.uid()) with check (to_id = auth.uid());
