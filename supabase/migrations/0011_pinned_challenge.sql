-- Each person picks the challenge that sits at the top of their Challenges tab ('cad' = their own Card a Day).
alter table public.profiles add column if not exists pinned_challenge text;
