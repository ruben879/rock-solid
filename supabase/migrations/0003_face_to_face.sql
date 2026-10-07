-- Add "face to face" as a touch type.
alter table public.touches drop constraint if exists touches_kind_check;
alter table public.touches add constraint touches_kind_check
  check (kind in ('call', 'text', 'card', 'popby', 'facetoface', 'email', 'newsletter', 'event'));
