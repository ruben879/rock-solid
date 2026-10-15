-- Together: challenges people join, a feed with kudos, and progress that fills in from what they already log.
-- Members only ever see each other's counts and posts, never contacts or notes.

create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  kind text not null default 'custom' check (kind in ('cards', 'custom')),
  counts text[] not null default '{}',          -- custom: which touch kinds count (call, text, card, popby, facetoface, any, social, video, openhouse)
  target int not null default 1 check (target > 0),
  period text not null default 'week' check (period in ('day', 'week', 'month')),
  starts_on date not null,
  ends_on date not null,
  code text not null unique default upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6)),
  created_at timestamptz not null default now()
);

create table if not exists public.challenge_members (
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (challenge_id, user_id)
);

create table if not exists public.challenge_posts (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text,                                    -- a message someone typed
  auto_day date,                                -- or an automatic "logged it" post: one per person per day
  auto_n int not null default 0,
  created_at timestamptz not null default now(),
  unique (challenge_id, user_id, auto_day)
);

create table if not exists public.challenge_kudos (
  post_id uuid not null references public.challenge_posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create index if not exists challenge_posts_by_challenge on public.challenge_posts (challenge_id, created_at desc);
create index if not exists challenge_members_by_user on public.challenge_members (user_id);

create or replace function public.in_challenge(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.challenge_members where challenge_id = cid and user_id = auth.uid())
$$;

alter table public.challenges enable row level security;
alter table public.challenge_members enable row level security;
alter table public.challenge_posts enable row level security;
alter table public.challenge_kudos enable row level security;

drop policy if exists "see my challenges" on public.challenges;
create policy "see my challenges" on public.challenges for select using (public.in_challenge(id) or created_by = auth.uid());
drop policy if exists "start a challenge" on public.challenges;
create policy "start a challenge" on public.challenges for insert with check (created_by = auth.uid());
drop policy if exists "change my challenge" on public.challenges;
create policy "change my challenge" on public.challenges for update using (created_by = auth.uid());
drop policy if exists "end my challenge" on public.challenges;
create policy "end my challenge" on public.challenges for delete using (created_by = auth.uid());

drop policy if exists "see members" on public.challenge_members;
create policy "see members" on public.challenge_members for select using (public.in_challenge(challenge_id));
drop policy if exists "leave" on public.challenge_members;
create policy "leave" on public.challenge_members for delete using (user_id = auth.uid());

drop policy if exists "see posts" on public.challenge_posts;
create policy "see posts" on public.challenge_posts for select using (public.in_challenge(challenge_id));
drop policy if exists "post" on public.challenge_posts;
create policy "post" on public.challenge_posts for insert
  with check (user_id = auth.uid() and auto_day is null and public.in_challenge(challenge_id));
drop policy if exists "remove post" on public.challenge_posts;
create policy "remove post" on public.challenge_posts for delete
  using (user_id = auth.uid() or exists (select 1 from public.challenges c where c.id = challenge_id and c.created_by = auth.uid()));

drop policy if exists "see kudos" on public.challenge_kudos;
create policy "see kudos" on public.challenge_kudos for select
  using (exists (select 1 from public.challenge_posts p where p.id = post_id and public.in_challenge(p.challenge_id)));
drop policy if exists "give kudos" on public.challenge_kudos;
create policy "give kudos" on public.challenge_kudos for insert
  with check (user_id = auth.uid() and exists (select 1 from public.challenge_posts p where p.id = post_id and public.in_challenge(p.challenge_id)));
drop policy if exists "take back kudos" on public.challenge_kudos;
create policy "take back kudos" on public.challenge_kudos for delete using (user_id = auth.uid());

-- Whoever starts a challenge is in it.
create or replace function public.challenge_add_creator() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.challenge_members (challenge_id, user_id) values (new.id, new.created_by) on conflict do nothing;
  return new;
end $$;
drop trigger if exists challenge_creator on public.challenges;
create trigger challenge_creator after insert on public.challenges for each row execute function public.challenge_add_creator();

-- Look at a challenge from its link before joining.
create or replace function public.challenge_preview(p_code text)
returns table (id uuid, name text, kind text, starts_on date, ends_on date, members int, started_by text)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.kind, c.starts_on, c.ends_on,
    (select count(*)::int from public.challenge_members m where m.challenge_id = c.id),
    coalesce(nullif(p.full_name, ''), split_part(p.email, '@', 1))
  from public.challenges c join public.profiles p on p.id = c.created_by
  where c.code = upper(trim(p_code))
$$;

-- Join with a link's code.
create or replace function public.join_challenge(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  select id into cid from public.challenges where code = upper(trim(p_code));
  if cid is null then raise exception 'That link doesn''t match a challenge.'; end if;
  insert into public.challenge_members (challenge_id, user_id) values (cid, auth.uid()) on conflict do nothing;
  return cid;
end $$;

-- Names of the people in a challenge (only for members).
create or replace function public.challenge_people(cid uuid)
returns table (user_id uuid, name text)
language sql stable security definer set search_path = public as $$
  select m.user_id, coalesce(nullif(p.full_name, ''), split_part(p.email, '@', 1))
  from public.challenge_members m join public.profiles p on p.id = m.user_id
  where m.challenge_id = cid and public.in_challenge(cid)
$$;

-- Counts per person per day for a challenge, from what they already log. Counts only, nothing else.
create or replace function public.challenge_progress(cid uuid)
returns table (user_id uuid, day date, n int)
language sql stable security definer set search_path = public as $$
  with c as (select * from public.challenges where id = cid and public.in_challenge(cid)),
  mem as (select m.user_id from public.challenge_members m join c on m.challenge_id = c.id)
  select t.agent_id, t.occurred_on, count(*)::int
  from public.touches t, c
  where c.kind = 'custom' and t.agent_id in (select user_id from mem) and not t.is_group
    and t.occurred_on between c.starts_on and c.ends_on
    and (t.kind = any (c.counts) or ('any' = any (c.counts) and t.kind in ('call', 'text', 'card', 'popby', 'facetoface')))
  group by 1, 2
  union all
  select k.agent_id, k.sent_on, count(*)::int
  from public.cards k, c
  where c.kind = 'cards' and k.agent_id in (select user_id from mem) and k.counts_for_challenge
    and k.sent_on between c.starts_on and c.ends_on
  group by 1, 2
  union all
  select y.agent_id, y.month, sum(y.count)::int
  from public.tallies y, c
  where c.kind = 'custom' and y.agent_id in (select user_id from mem) and y.kind like '%@w'
    and replace(y.kind, '@w', '') = any (c.counts) and y.month between c.starts_on - 6 and c.ends_on
  group by 1, 2
$$;

-- When someone logs something a challenge counts, it shows up in the feed on its own (one post per person per day).
create or replace function public.challenge_autopost() returns trigger
language plpgsql security definer set search_path = public as $$
declare uid uuid; d date; k text; is_card boolean; delta int;
begin
  if tg_op = 'DELETE' then
    if tg_table_name = 'cards' then
      if not old.counts_for_challenge then return old; end if;
      uid := old.agent_id; d := old.sent_on; is_card := true;
    else
      if old.is_group then return old; end if;
      uid := old.agent_id; d := old.occurred_on; k := old.kind; is_card := false;
    end if;
    delta := -1;
  else
    if tg_table_name = 'cards' then
      if not new.counts_for_challenge then return new; end if;
      uid := new.agent_id; d := new.sent_on; is_card := true;
    else
      if new.is_group then return new; end if;
      uid := new.agent_id; d := new.occurred_on; k := new.kind; is_card := false;
    end if;
    delta := 1;
  end if;

  if delta > 0 then
    insert into public.challenge_posts (challenge_id, user_id, auto_day, auto_n)
    select c.id, uid, d, 1
    from public.challenges c join public.challenge_members m on m.challenge_id = c.id and m.user_id = uid
    where d between c.starts_on and c.ends_on
      and ((is_card and c.kind = 'cards')
        or (not is_card and c.kind = 'custom' and (k = any (c.counts) or ('any' = any (c.counts) and k in ('call', 'text', 'card', 'popby', 'facetoface')))))
    on conflict (challenge_id, user_id, auto_day) do update set auto_n = public.challenge_posts.auto_n + 1, created_at = now();
    return new;
  else
    update public.challenge_posts p set auto_n = p.auto_n - 1
    from public.challenges c
    where p.challenge_id = c.id and p.user_id = uid and p.auto_day = d
      and ((is_card and c.kind = 'cards')
        or (not is_card and c.kind = 'custom' and (k = any (c.counts) or ('any' = any (c.counts) and k in ('call', 'text', 'card', 'popby', 'facetoface')))));
    delete from public.challenge_posts where user_id = uid and auto_day = d and auto_n <= 0;
    return old;
  end if;
end $$;

drop trigger if exists touches_challenge_post on public.touches;
create trigger touches_challenge_post after insert or delete on public.touches for each row execute function public.challenge_autopost();
drop trigger if exists cards_challenge_post on public.cards;
create trigger cards_challenge_post after insert or delete on public.cards for each row execute function public.challenge_autopost();
