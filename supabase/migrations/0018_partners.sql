-- Spouses and partners: two people linked both ways, so one card addressed to both counts for both.
alter table public.contacts add column if not exists partner_id uuid references public.contacts(id) on delete set null;
