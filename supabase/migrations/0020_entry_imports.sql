-- Entry form imports (giveaway forms and the like): each upload is one import with an Import label and an Owning agent.
-- People an import creates are "New people" (import_batch_id set) until the owning agent Keeps or Removes them.
create table if not exists public.imports (
  id uuid primary key default gen_random_uuid(),
  brokerage_id uuid not null references public.brokerages(id) on delete cascade,
  agent_id uuid not null references public.profiles(id) on delete cascade,      -- Owning agent
  imported_by uuid not null references public.profiles(id) on delete cascade,
  source_label text not null check (length(trim(source_label)) > 0),           -- Import label, stored verbatim
  imported int not null default 0,
  duplicates int not null default 0,
  errors int not null default 0,
  details jsonb not null default '{}'::jsonb,                                    -- error row numbers, duplicate emails/phones
  created_at timestamptz not null default now()
);
alter table public.imports enable row level security;

drop policy if exists "see imports" on public.imports;
create policy "see imports" on public.imports for select
  using (brokerage_id = public.current_brokerage() and (agent_id = auth.uid() or imported_by = auth.uid() or public.is_broker()));

drop policy if exists "create imports" on public.imports;
create policy "create imports" on public.imports for insert
  with check (
    imported_by = auth.uid() and brokerage_id = public.current_brokerage()
    and (agent_id = auth.uid() or public.is_broker())
    and exists (select 1 from public.profiles p where p.id = agent_id and p.brokerage_id = public.current_brokerage())
  );

-- Only used to undo an import that failed partway (the app never deletes an import otherwise).
drop policy if exists "undo my failed import" on public.imports;
create policy "undo my failed import" on public.imports for delete using (imported_by = auth.uid());

alter table public.contacts add column if not exists import_batch_id uuid references public.imports(id) on delete set null;
create index if not exists contacts_by_import on public.contacts (import_batch_id) where import_batch_id is not null;

-- A broker may create New people for another agent in their own brokerage (insert only, and only as part of an import).
drop policy if exists "broker imports for agents" on public.contacts;
create policy "broker imports for agents" on public.contacts for insert
  with check (
    public.is_broker() and import_batch_id is not null and brokerage_id = public.current_brokerage()
    and exists (select 1 from public.profiles p where p.id = agent_id and p.brokerage_id = public.current_brokerage())
  );
