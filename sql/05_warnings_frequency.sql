-- Warning frequency across agent_runs, last 30 days. Answers "what is the
-- agent struggling with the most?". Unnests the jsonb warnings array.

select
  warning,
  count(*)                         as occurrences_across_runs,
  count(distinct ar.id)            as distinct_runs,
  min(ar.started_at at time zone 'Australia/Perth')::date as first_seen_awst,
  max(ar.started_at at time zone 'Australia/Perth')::date as last_seen_awst
from agent_runs ar,
     jsonb_array_elements_text(coalesce(ar.warnings, '[]'::jsonb)) warning
where ar.started_at > now() - interval '30 days'
group by warning
order by occurrences_across_runs desc;
