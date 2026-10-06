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

## What's in the app
- **Your Next 10:** the weekly rotation, 10 at a time, with call/text buttons, logging, "next week" skips, goal tiles and celebrations
- **Card a Day:** logging with the optional once-every-12-months rule, streak, calendar and history
- **Monthly:** call/text/card totals, monthly push counters, the yearly economic plan and personal goals
- **Database:** rolling 12-month thermometers, filters, editing, CSV import (BoldTrail exports work as is), group touches, per-agent tier frequencies
- **Coaches:** My Agents overview and read-only access to each agent's tracker
- **Broker:** All Agents, Team (invites, roles, coach assignments) and the monthly prize wheel

## Who sees what
- Agents read and write only their own contacts, touches and cards.
- Coaches read the agents assigned to them.
- The broker reads everyone in the brokerage, assigns coaches and runs the drawing.
- Only people with an invite can sign in.
