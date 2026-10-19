-- Replies in challenge chats: a post can answer another post.
alter table public.challenge_posts add column if not exists reply_to uuid references public.challenge_posts(id) on delete cascade;
create index if not exists challenge_posts_replies on public.challenge_posts (reply_to);

-- How to celebrate each person's birthday: 'text' (on the day, the default), 'card' (a few days early), 'both', or 'none'.
alter table public.contacts add column if not exists birthday_plan text;
