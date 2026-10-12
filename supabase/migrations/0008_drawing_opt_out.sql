-- Broker can leave someone out of the monthly drawing (for example, coaches or the broker).
alter table public.profiles add column if not exists in_drawing boolean not null default true;

-- Only the broker can change roles, coaches, brokerage or who's in the drawing.
create or replace function public.guard_profile_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_broker() and (
       new.role is distinct from old.role
    or new.coach_id is distinct from old.coach_id
    or new.brokerage_id is distinct from old.brokerage_id
    or new.in_drawing is distinct from old.in_drawing) then
    raise exception 'Only the broker can change roles, coach assignments or the drawing';
  end if;
  return new;
end $$;
