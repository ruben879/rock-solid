-- Phone reminders for birthdays and anniversaries.
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  brokerage_id uuid references public.brokerages(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  heads_up boolean not null default true,   -- also remind 3 days ahead (time to mail a card)
  last_sent date,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists "own push subscriptions" on public.push_subscriptions;
create policy "own push subscriptions" on public.push_subscriptions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- The app's push keys. Only the server can read this table (no policies on purpose).
create table if not exists public.push_config (
  id int primary key default 1,
  public_key text,
  private_key text
);
alter table public.push_config enable row level security;
