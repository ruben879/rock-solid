-- Invite people in your brokerage to a challenge right in the app (no link needed).

create table if not exists public.challenge_invites (
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  invited_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (challenge_id, user_id)
);
alter table public.challenge_invites enable row level security;

drop policy if exists "see invites" on public.challenge_invites;
create policy "see invites" on public.challenge_invites for select
  using (user_id = auth.uid() or public.in_challenge(challenge_id));
drop policy if exists "send invites" on public.challenge_invites;
create policy "send invites" on public.challenge_invites for insert
  with check (invited_by = auth.uid() and public.in_challenge(challenge_id));
drop policy if exists "drop invites" on public.challenge_invites;
create policy "drop invites" on public.challenge_invites for delete
  using (user_id = auth.uid() or invited_by = auth.uid());

-- People in my brokerage I could invite (names only).
create or replace function public.brokerage_people()
returns table (user_id uuid, name text)
language sql stable security definer set search_path = public as $$
  select p.id, coalesce(nullif(p.full_name, ''), split_part(p.email, '@', 1))
  from public.profiles p
  where p.brokerage_id = (select brokerage_id from public.profiles where id = auth.uid()) and p.id <> auth.uid()
  order by 2
$$;

-- Challenges I've been invited to and haven't joined yet.
create or replace function public.my_invites()
returns table (challenge_id uuid, name text, code text, starts_on date, ends_on date, invited_by text, members int)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.code, c.starts_on, c.ends_on,
    coalesce(nullif(p.full_name, ''), split_part(p.email, '@', 1)),
    (select count(*)::int from public.challenge_members m where m.challenge_id = c.id)
  from public.challenge_invites i
  join public.challenges c on c.id = i.challenge_id
  join public.profiles p on p.id = i.invited_by
  where i.user_id = auth.uid() and c.ends_on >= current_date
    and not exists (select 1 from public.challenge_members m where m.challenge_id = c.id and m.user_id = auth.uid())
  order by i.created_at desc
$$;

-- Joining also clears any invite to that challenge.
create or replace function public.join_challenge(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  select id into cid from public.challenges where code = upper(trim(p_code));
  if cid is null then raise exception 'That link doesn''t match a challenge.'; end if;
  insert into public.challenge_members (challenge_id, user_id) values (cid, auth.uid()) on conflict do nothing;
  delete from public.challenge_invites where challenge_id = cid and user_id = auth.uid();
  return cid;
end $$;
