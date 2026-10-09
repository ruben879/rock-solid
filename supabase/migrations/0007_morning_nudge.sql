-- Morning nudge settings for each phone: on or off, and what hour (7, 8, 9 or 10 a.m. Lubbock time).
alter table public.push_subscriptions add column if not exists nudge boolean not null default true;
alter table public.push_subscriptions add column if not exists nudge_hour int not null default 9;
alter table public.push_subscriptions drop constraint if exists push_subscriptions_nudge_hour_check;
alter table public.push_subscriptions add constraint push_subscriptions_nudge_hour_check check (nudge_hour between 7 and 10);
