-- Recruit mode: a second sphere in the same people table.
-- Everyone that exists today stays 'client'. Recruits only show up in the broker's Recruiting views.
alter table public.contacts add column if not exists sphere text not null default 'client';
alter table public.contacts drop constraint if exists contacts_sphere_check;
alter table public.contacts add constraint contacts_sphere_check check (sphere in ('client', 'recruit'));
alter table public.contacts add column if not exists current_brokerage text;
alter table public.contacts add column if not exists years_licensed int;
alter table public.contacts add column if not exists production_note text;
alter table public.contacts add column if not exists temperature text;   -- 'A', 'B' or 'watch'
alter table public.contacts add column if not exists stage text;         -- cold, warm, talking, meeting, joined, nofit
alter table public.contacts add column if not exists stage_on date;      -- when the current stage started
alter table public.contacts add column if not exists meeting_on date;    -- for Meeting set
alter table public.contacts add column if not exists joined_on date;     -- set when they join
create index if not exists contacts_by_sphere on public.contacts (agent_id, sphere);

-- Recruiting touch types, plus 'stage' for logged stage changes (they never count as touches).
alter table public.touches drop constraint if exists touches_kind_check;
alter table public.touches add constraint touches_kind_check
  check (kind in ('call', 'text', 'card', 'popby', 'facetoface', 'email', 'newsletter', 'event',
                  'coffee', 'intel', 'congrats', 'invite', 'social', 'checkin', 'capchat', 'win', 'oneonone', 'stage'));
