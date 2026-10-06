-- Rock Solid: Clear Rock Realty setup
-- Run after 0001_init.sql. Adds the brokerage and the first invite (the broker).
-- Agent and coach invites get added from the app's Broker view, or by adding rows below.

insert into public.brokerages (id, name, settings)
values (
  '00000000-0000-0000-0000-00000000c0de',
  'Clear Rock Realty',
  '{
    "prizes": [25, 15, 10],
    "touch_goal": 36,
    "touch_mix": {"email": 12, "newsletter": 4, "call": 6, "text": 6, "card": 2, "popby": 2, "event": 4},
    "monthly_goals": {"call": 21, "text": 21, "card": 7}
  }'::jsonb
);

insert into public.invites (email, brokerage_id, full_name, role)
values ('ruben@clearrockrealty.com', '00000000-0000-0000-0000-00000000c0de', 'Ruben Trujillo', 'broker');

-- Coach roster (add each person's email when you have it, then run):
-- insert into public.invites (email, brokerage_id, full_name, role, coach_email) values
--   ('tiffany@...', '00000000-0000-0000-0000-00000000c0de', 'Tiffany Norris', 'coach', null),
--   ('libby@...',   '00000000-0000-0000-0000-00000000c0de', 'Libby Draughon', 'coach', null),
--   ('brooke@...',  '00000000-0000-0000-0000-00000000c0de', 'Brooke Linnenkugel', 'agent', 'ruben@clearrockrealty.com');
