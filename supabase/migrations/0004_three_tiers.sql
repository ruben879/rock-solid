-- Three tiers plus "?" (not tagged yet): A every 14 days, B every 30, C every 60, ? every 30.
update public.contacts set tier = 'C' where tier = 'D';
alter table public.contacts alter column tier set default 'U';
update public.profiles set tier_days = '{"A":14,"B":30,"C":60,"U":30}'::jsonb;
alter table public.profiles alter column tier_days set default '{"A":14,"B":30,"C":60,"U":30}'::jsonb;
