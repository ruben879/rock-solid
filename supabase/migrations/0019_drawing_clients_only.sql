-- Drawing entries count client touches only: stage changes and touches with people in the Agents view don't count.
create or replace view public.drawing_entries with (security_invoker = true) as
select t.brokerage_id, t.agent_id, date_trunc('month', t.occurred_on)::date as month, count(*)::int as entries
from public.touches t
left join public.contacts c on c.id = t.contact_id
where not t.is_group and t.kind <> 'stage' and coalesce(c.sphere, 'client') = 'client'
group by 1, 2, 3;
