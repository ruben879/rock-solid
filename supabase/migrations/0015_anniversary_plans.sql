-- How to celebrate home and wedding anniversaries on Today: 'text' (on the day, the default), 'card' (a few days early), 'both', or 'none'.
alter table public.contacts add column if not exists home_plan text;
alter table public.contacts add column if not exists wedding_plan text;
