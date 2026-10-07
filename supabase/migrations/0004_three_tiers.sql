-- Simplify to three tiers: A every 14 days, B every 30, C every 60.
update public.contacts set tier = 'B' where tier = 'U';
update public.contacts set tier = 'C' where tier = 'D';
alter table public.contacts alter column tier set default 'B';
update public.profiles set tier_days = '{"A":14,"B":30,"C":60}'::jsonb;
alter table public.profiles alter column tier_days set default '{"A":14,"B":30,"C":60}'::jsonb;
