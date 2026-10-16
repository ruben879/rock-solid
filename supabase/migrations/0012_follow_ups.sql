-- Follow-ups: pick a day to reach back out to someone. They show up at the top of Today that day, with the note.
alter table public.contacts add column if not exists follow_up_on date;
alter table public.contacts add column if not exists follow_up_note text;
