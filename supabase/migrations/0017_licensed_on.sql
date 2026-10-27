-- Agents view: the date someone got their license, for a congratulations card every year.
alter table public.contacts add column if not exists licensed_on date;
