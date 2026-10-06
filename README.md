# Rock Solid

Clear Rock Realty's database-touch tracker: a 10-at-a-time contact list, Card a Day, touch-score thermometers,
coach and broker views, and the monthly drawing.

## Stack
- React + Vite web app, installable to a phone's home screen
- Supabase for sign-in, the database and access rules
- Vercel for hosting; every push to `main` deploys

## Setup
1. **Supabase:** create a project, open SQL Editor, and run `supabase/migrations/0001_init.sql`, then `0002_seed_clear_rock.sql`.
2. **Supabase auth:** under Authentication > URL Configuration, set the Site URL to the Vercel address.
3. **Vercel:** import this repository and add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
   (Supabase > Project Settings > API). Redeploy.

## Who sees what
- Agents read and write only their own contacts, touches and cards.
- Coaches read the agents assigned to them.
- The broker reads everyone in the brokerage, assigns coaches and runs the drawing.
- Only people with an invite can sign in.
