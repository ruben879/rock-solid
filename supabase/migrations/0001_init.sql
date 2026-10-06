-- Rock Solid: initial schema
-- Paste this whole file into Supabase > SQL Editor and run it once.
-- Every table is scoped to a brokerage so the app can serve more than one brokerage later.

-- ---------- Types ----------
create type public.app_role as enum ('agent', 'coach', 'broker');

-- ---------- Tables ----------
create table public.brokerages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  settings jsonb not null default '{}'::jsonb,   -- prizes, default tier days, touch mix, branding
  created_at timestamptz not null default now()
);

-- Who is allowed to sign up, and with what role. Added by the broker.
create table public.invites (
  email text primary key,                        -- stored lowercase
  brokerage_id uuid not null references public.brokerages(id) on delete cascade,
  full_name text,
  role public.app_role not null default 'agent',
  coach_email text,                              -- lowercase; links to the coach once both have signed in
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  brokerage_id uuid not null references public.brokerages(id) on delete cascade,
  full_name text,
  email text not null,
  role public.app_role not null default 'agent',
  coach_id uuid references public.profiles(id) on delete set null,
  tier_days jsonb not null default '{"A":14,"B":30,"C":90,"D":60,"U":30}'::jsonb,
  daily_goal int not null default 5,
  weekly_goal int not null default 20,
  card_rule boolean not null default true,       -- Card a Day: count each person once per 12 months
  plan jsonb not null default '{}'::jsonb,       -- economic model inputs (income goal, cap, price, rate, conversion)
  created_at timestamptz not null default now()
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  brokerage_id uuid not null references public.brokerages(id) on delete cascade,
  agent_id uuid not null references public.profiles(id) on delete cascade,
  first_name text not null,
  last_name text not null default '',
  phone text,
  email text,
  address text,
  city text,
  state text,
  zip text,
  tier text not null default 'U' check (tier in ('A', 'B', 'C', 'D', 'U')),
  notes text,
  birthday date,
  home_anniversary date,
  prior_touches int not null default 0,          -- touches carried in from the old tracker
  added_on date not null default current_date,
  last_touch_on date,
  skip_until date,                               -- "next week" pushes
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index contacts_agent_idx on public.contacts (agent_id);

create table public.touches (
  id uuid primary key default gen_random_uuid(),
  brokerage_id uuid not null references public.brokerages(id) on delete cascade,
  agent_id uuid not null references public.profiles(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete cascade,
  kind text not null check (kind in ('call', 'text', 'card', 'popby', 'email', 'newsletter', 'event')),
  is_group boolean not null default false,       -- group touches score contacts but don't earn drawing entries
  note text,
  occurred_on date not null default current_date,
  created_at timestamptz not null default now()
);
create index touches_agent_date_idx on public.touches (agent_id, occurred_on);
create index touches_contact_idx on public.touches (contact_id);

create table public.cards (
  id uuid primary key default gen_random_uuid(),
  brokerage_id uuid not null references public.brokerages(id) on delete cascade,
  agent_id uuid not null references public.profiles(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  recipient_name text not null,
  relationship text,
  occasion text,
  note text,
  sent_on date not null default current_date,
  counts_for_challenge boolean not null default true,
  created_at timestamptz not null default now()
);
create index cards_agent_idx on public.cards (agent_id, sent_on);

-- Monthly counters for things that aren't tied to one contact (giveaways, videos, open houses, social posts)
create table public.tallies (
  agent_id uuid not null references public.profiles(id) on delete cascade,
  brokerage_id uuid not null references public.brokerages(id) on delete cascade,
  month date not null,                           -- first day of the month
  kind text not null,
  count int not null default 0,
  primary key (agent_id, month, kind)
);

create table public.drawings (
  id uuid primary key default gen_random_uuid(),
  brokerage_id uuid not null references public.brokerages(id) on delete cascade,
  month date not null,
  prize_dollars int not null,
  winner_id uuid references public.profiles(id) on delete set null,
  winner_entries int,
  total_entries int,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

-- ---------- Helper functions (used by the access rules) ----------
create or replace function public.current_brokerage() returns uuid
language sql stable security definer set search_path = public as $$
  select brokerage_id from public.profiles where id = auth.uid()
$$;

create or replace function public.is_broker() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'broker')
$$;

-- You can see an agent's data if it's yours, you're their coach, or you're the broker of their brokerage.
create or replace function public.can_view_agent(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select target = auth.uid()
      or exists (select 1 from public.profiles p where p.id = target and p.coach_id = auth.uid())
      or exists (select 1 from public.profiles p where p.id = target and p.brokerage_id = public.current_brokerage() and public.is_broker())
$$;

-- ---------- New sign-ins become profiles only if invited ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare inv public.invites;
begin
  select * into inv from public.invites where email = lower(new.email);
  if not found then
    return new;  -- not invited: the app shows "ask your broker for an invite"
  end if;

  insert into public.profiles (id, brokerage_id, full_name, email, role, coach_id)
  values (
    new.id, inv.brokerage_id, inv.full_name, lower(new.email), inv.role,
    (select id from public.profiles where email = inv.coach_email and brokerage_id = inv.brokerage_id)
  );

  -- If this person coaches agents who signed in first, link them now.
  update public.profiles p set coach_id = new.id
  from public.invites i
  where i.email = p.email and i.coach_email = lower(new.email)
    and p.brokerage_id = inv.brokerage_id and p.coach_id is null;

  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Only the broker can change roles, coaches or brokerage.
create or replace function public.guard_profile_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_broker() and (
       new.role is distinct from old.role
    or new.coach_id is distinct from old.coach_id
    or new.brokerage_id is distinct from old.brokerage_id) then
    raise exception 'Only the broker can change roles or coach assignments';
  end if;
  return new;
end $$;

create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profile_update();

-- Keep each contact's last touch date current.
create or replace function public.bump_last_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.contact_id is not null then
    update public.contacts
       set last_touch_on = greatest(coalesce(last_touch_on, new.occurred_on), new.occurred_on),
           updated_at = now()
     where id = new.contact_id;
  end if;
  return new;
end $$;

create trigger touches_bump after insert on public.touches
  for each row execute function public.bump_last_touch();

-- ---------- Access rules (row level security) ----------
alter table public.brokerages enable row level security;
alter table public.invites    enable row level security;
alter table public.profiles   enable row level security;
alter table public.contacts   enable row level security;
alter table public.touches    enable row level security;
alter table public.cards      enable row level security;
alter table public.tallies    enable row level security;
alter table public.drawings   enable row level security;

create policy "see own brokerage" on public.brokerages for select using (id = public.current_brokerage());
create policy "broker edits brokerage" on public.brokerages for update using (id = public.current_brokerage() and public.is_broker());

create policy "broker manages invites" on public.invites for all
  using (brokerage_id = public.current_brokerage() and public.is_broker())
  with check (brokerage_id = public.current_brokerage() and public.is_broker());

-- Everyone in the brokerage can see names (for the drawing); numbers are protected by the tables below.
create policy "see colleagues" on public.profiles for select using (brokerage_id = public.current_brokerage());
create policy "edit own profile" on public.profiles for update using (id = auth.uid());
create policy "broker edits profiles" on public.profiles for update using (brokerage_id = public.current_brokerage() and public.is_broker());

-- Same pattern for every agent-owned table: agent owns it; coach and broker can read it.
create policy "read contacts" on public.contacts for select using (public.can_view_agent(agent_id));
create policy "write own contacts" on public.contacts for all
  using (agent_id = auth.uid())
  with check (agent_id = auth.uid() and brokerage_id = public.current_brokerage());

create policy "read touches" on public.touches for select using (public.can_view_agent(agent_id));
create policy "write own touches" on public.touches for all
  using (agent_id = auth.uid())
  with check (agent_id = auth.uid() and brokerage_id = public.current_brokerage());

create policy "read cards" on public.cards for select using (public.can_view_agent(agent_id));
create policy "write own cards" on public.cards for all
  using (agent_id = auth.uid())
  with check (agent_id = auth.uid() and brokerage_id = public.current_brokerage());

create policy "read tallies" on public.tallies for select using (public.can_view_agent(agent_id));
create policy "write own tallies" on public.tallies for all
  using (agent_id = auth.uid())
  with check (agent_id = auth.uid() and brokerage_id = public.current_brokerage());

create policy "see drawings" on public.drawings for select using (brokerage_id = public.current_brokerage());
create policy "broker runs drawings" on public.drawings for all
  using (brokerage_id = public.current_brokerage() and public.is_broker())
  with check (brokerage_id = public.current_brokerage() and public.is_broker());

-- ---------- Drawing entries: one per individual touch logged in a month ----------
create or replace view public.drawing_entries with (security_invoker = true) as
select t.brokerage_id, t.agent_id, date_trunc('month', t.occurred_on)::date as month, count(*)::int as entries
from public.touches t
where not t.is_group
group by 1, 2, 3;
