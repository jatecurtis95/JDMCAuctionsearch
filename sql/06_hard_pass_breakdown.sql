-- Hard pass reasons, weighted, last 30 days. Tells us how the firehose
-- is being filtered. Unnests the hard_pass_reasons jsonb (shape is
-- {"Not SEVS/MRE eligible": 254, "R-grade ...": 22, ...}).

select
  reason,
  sum((value)::int)     as total_listings_failed,
  count(*)              as runs_where_present,
  round(
    100.0 * sum((value)::int)::numeric / nullif(sum(sum((value)::int)) over (), 0),
    2
  )                     as pct_of_all_hard_passes
from agent_runs ar,
     jsonb_each_text(coalesce(ar.hard_pass_reasons, '{}'::jsonb)) as kv(reason, value)
where ar.started_at > now() - interval '30 days'
group by reason
order by total_listings_failed desc;
