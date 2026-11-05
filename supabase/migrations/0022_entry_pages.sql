-- Hosted entry page: every agent gets a public link (/enter/<token>). Entries land in a staging table and are
-- processed on the server (Vercel /api/enter, service role) through the same matching engine as the Entry form import.
-- No public request writes to contacts. Run after 0021.

-- Which imports came from the entry page, and whether that batch still takes new entries.
alter table public.imports add column if not exists via text not null default 'upload' check (via in ('upload', 'entry_page'));
alter table public.imports add column if not exists closed boolean not null default false;
-- One open entry page batch per agent at a time.
create unique index if not exists imports_one_open_entry_batch on public.imports (agent_id) where via = 'entry_page' and not closed;

-- One entry page per agent.
create table if not exists public.entry_pages (
  agent_id uuid primary key references public.profiles(id) on delete cascade,
  brokerage_id uuid not null references public.brokerages(id) on delete cascade,
  token text not null unique check (token ~ '^[A-Za-z0-9]{20,}$'),
  label text not null check (length(trim(label)) > 0),
  updated_at timestamptz not null default now()
);
alter table public.entry_pages enable row level security;

-- The agent sees their own page; brokers see every page in their brokerage.
drop policy if exists "see entry pages" on public.entry_pages;
create policy "see entry pages" on public.entry_pages for select
  using (agent_id = auth.uid() or (public.is_broker() and brokerage_id = public.current_brokerage()));
-- Only the agent changes their page, and only the label (the link changes through entry_page_regenerate).
drop policy if exists "edit my entry page" on public.entry_pages;
create policy "edit my entry page" on public.entry_pages for update
  using (agent_id = auth.uid()) with check (agent_id = auth.uid());
revoke all on public.entry_pages from anon;
revoke insert, update, delete on public.entry_pages from authenticated;
grant select on public.entry_pages to authenticated;
grant update (label) on public.entry_pages to authenticated;

-- A long random token (32 letters and digits). Never a name or an id.
create or replace function public.entry_token() returns text language sql volatile as $$
  select substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 32)
$$;

-- The agent's page, made the first time anyone opens it. Brokers can open (and so start) any agent's page in their brokerage.
create or replace function public.entry_page_for(p_agent uuid)
returns public.entry_pages language plpgsql security definer set search_path = public as $$
declare pr public.profiles%rowtype; pg public.entry_pages%rowtype;
begin
  select * into pr from public.profiles where id = p_agent;
  if not found or not (p_agent = auth.uid() or (public.is_broker() and pr.brokerage_id = public.current_brokerage())) then
    raise exception 'Not allowed';
  end if;
  insert into public.entry_pages (agent_id, brokerage_id, token, label)
    values (p_agent, pr.brokerage_id, public.entry_token(), 'Giveaway entry')
    on conflict (agent_id) do nothing;
  select * into pg from public.entry_pages where agent_id = p_agent;
  return pg;
end $$;

-- A new link. The old one stops working right away. Only the agent can do this.
create or replace function public.entry_page_regenerate()
returns public.entry_pages language plpgsql security definer set search_path = public as $$
declare pg public.entry_pages%rowtype;
begin
  update public.entry_pages set token = public.entry_token(), updated_at = now() where agent_id = auth.uid() returning * into pg;
  if not found then raise exception 'Not allowed'; end if;
  return pg;
end $$;

revoke all on function public.entry_token() from public, anon, authenticated;
revoke all on function public.entry_page_for(uuid) from public, anon;
revoke all on function public.entry_page_regenerate() from public, anon;
grant execute on function public.entry_page_for(uuid) to authenticated;
grant execute on function public.entry_page_regenerate() to authenticated;

-- A new label closes the open batch, so the next entry starts a new one.
create or replace function public.entry_label_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.label is distinct from old.label then
    new.updated_at := now();
    update public.imports set closed = true where agent_id = new.agent_id and via = 'entry_page' and not closed;
  end if;
  return new;
end $$;
drop trigger if exists entry_label_changed on public.entry_pages;
create trigger entry_label_changed before update of label on public.entry_pages
  for each row execute function public.entry_label_changed();

-- Staging: every accepted entry, exactly as submitted, before it's matched. Only the server (service role) reads or writes it.
create table if not exists public.entry_submissions (
  id uuid primary key default gen_random_uuid(),
  brokerage_id uuid not null references public.brokerages(id) on delete cascade,
  agent_id uuid not null references public.profiles(id) on delete cascade,
  label text not null,                                   -- the page label when the entry came in
  full_name text not null,
  email text,
  phone text,
  street text,
  city text,
  state text,
  zip text,
  consent boolean not null,
  consent_text text not null,                            -- the exact line shown above the Enter button
  ip_hash text not null,                                 -- for the 5-an-hour limit; never the address itself
  submitted_at timestamptz not null default now(),
  processed_at timestamptz,
  batch_id uuid references public.imports(id) on delete set null,
  outcome text check (outcome in ('created', 'updated', 'duplicate', 'check')),
  contact_id uuid references public.contacts(id) on delete set null
);
create index if not exists entry_submissions_by_ip on public.entry_submissions (ip_hash, submitted_at);
create index if not exists entry_submissions_waiting on public.entry_submissions (agent_id, submitted_at) where processed_at is null;
alter table public.entry_submissions enable row level security;   -- no policies: no one but the server
revoke all on public.entry_submissions from anon, authenticated;

-- Adds one entry's result to its batch counts (atomic, so two entries at once both count). Server only.
create or replace function public.entry_batch_add(p_batch uuid, p_imported int, p_duplicate text, p_updated jsonb, p_checks int)
returns void language sql security definer set search_path = public as $$
  update public.imports set
    imported = imported + p_imported,
    duplicates = duplicates + case when p_duplicate is null then 0 else 1 end,
    details = jsonb_build_object(
      'errorRows', coalesce(details->'errorRows', '[]'::jsonb),
      'duplicates', coalesce(details->'duplicates', '[]'::jsonb) || case when p_duplicate is null then '[]'::jsonb else jsonb_build_array(p_duplicate) end,
      'updated', coalesce(details->'updated', '[]'::jsonb) || case when p_updated is null then '[]'::jsonb else jsonb_build_array(p_updated) end,
      'checks', coalesce((details->>'checks')::int, 0) + p_checks)
  where id = p_batch
$$;
revoke all on function public.entry_batch_add(uuid, int, text, jsonb, int) from public, anon, authenticated;
grant execute on function public.entry_batch_add(uuid, int, text, jsonb, int) to service_role;
grant all on public.entry_submissions to service_role;
grant all on public.entry_pages to service_role;
