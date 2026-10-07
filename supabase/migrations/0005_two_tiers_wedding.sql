-- Two tiers plus "?": A VIP every 14 days, B Advocates every 30, ? (needs a tag) every 30. Adds wedding anniversary.
update public.contacts set tier = 'B' where tier in ('C', 'D');
alter table public.contacts alter column tier set default 'U';
update public.profiles set tier_days = '{"A":14,"B":30,"U":30}'::jsonb;
alter table public.profiles alter column tier_days set default '{"A":14,"B":30,"U":30}'::jsonb;
alter table public.contacts add column if not exists wedding_anniversary date;
