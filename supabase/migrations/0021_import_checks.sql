-- Import matching: an import may fill a blank field on a matched contact, and asks the owning agent
-- (a Check item) before changing anything that's already filled. Run after 0020.

create table if not exists public.import_checks (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.imports(id) on delete cascade,
  brokerage_id uuid not null references public.brokerages(id) on delete cascade,
  agent_id uuid not null references public.profiles(id) on delete cascade,        -- the owning agent
  contact_id uuid references public.contacts(id) on delete set null,                -- the person (email match for an ambiguous item)
  contact_id_2 uuid references public.contacts(id) on delete set null,              -- the other person in an ambiguous match (phone match)
  field text check (field in ('email', 'phone', 'address', 'city', 'state', 'zip')), -- null for an ambiguous item
  existing_value text,
  entry_value text,
  entry_snapshot jsonb not null default '{}'::jsonb,                                  -- the full row, so a later pick can run the rules
  status text not null default 'pending' check (status in ('pending', 'kept_mine', 'used_entry', 'assigned', 'created_new', 'discarded')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists import_checks_pending on public.import_checks (agent_id) where status = 'pending';
alter table public.import_checks enable row level security;

-- Seen by the owning agent, the person who ran the import, and brokers in the brokerage (same as imports).
drop policy if exists "see import checks" on public.import_checks;
create policy "see import checks" on public.import_checks for select
  using (brokerage_id = public.current_brokerage() and (
    agent_id = auth.uid() or public.is_broker()
    or exists (select 1 from public.imports i where i.id = import_checks.import_id and i.imported_by = auth.uid())));

-- Created by whoever ran the import (or the owning agent, when an ambiguous pick turns up a conflict).
drop policy if exists "create import checks" on public.import_checks;
create policy "create import checks" on public.import_checks for insert
  with check (brokerage_id = public.current_brokerage() and exists (
    select 1 from public.imports i where i.id = import_checks.import_id and i.agent_id = import_checks.agent_id and (i.imported_by = auth.uid() or i.agent_id = auth.uid())));

-- Only the owning agent resolves them.
drop policy if exists "resolve import checks" on public.import_checks;
create policy "resolve import checks" on public.import_checks for update
  using (agent_id = auth.uid()) with check (agent_id = auth.uid());

-- Gap-fill: copies a value into a matched contact's field only while that field is blank.
-- Runs for the person who ran the import (a broker importing for an agent included), only on the owning agent's contacts.
create or replace function public.import_gap_fill(p_import uuid, p_contact uuid, p_fields jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare imp public.imports%rowtype;
begin
  select * into imp from public.imports where id = p_import;
  if not found or (imp.imported_by <> auth.uid() and imp.agent_id <> auth.uid()) then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.contacts where id = p_contact and agent_id = imp.agent_id) then raise exception 'Not allowed'; end if;
  update public.contacts set
    email   = case when coalesce(trim(email), '') = ''   and coalesce(p_fields->>'email', '') <> ''   then p_fields->>'email'   else email end,
    phone   = case when coalesce(trim(phone), '') = ''   and coalesce(p_fields->>'phone', '') <> ''   then p_fields->>'phone'   else phone end,
    address = case when coalesce(trim(address), '') = '' and coalesce(p_fields->>'address', '') <> '' then p_fields->>'address' else address end,
    city    = case when coalesce(trim(city), '') = ''    and coalesce(p_fields->>'city', '') <> ''    then p_fields->>'city'    else city end,
    state   = case when coalesce(trim(state), '') = ''   and coalesce(p_fields->>'state', '') <> ''   then p_fields->>'state'   else state end,
    zip     = case when coalesce(trim(zip), '') = ''     and coalesce(p_fields->>'zip', '') <> ''     then p_fields->>'zip'     else zip end,
    updated_at = now()
  where id = p_contact;
end $$;
revoke all on function public.import_gap_fill(uuid, uuid, jsonb) from public, anon;
grant execute on function public.import_gap_fill(uuid, uuid, jsonb) to authenticated;
