-- Score histogram in 10-point buckets, last 7 days. Useful for calibration.
-- If everything clusters at 45 to 55, the rubric is too flat.
-- If nothing crosses 75, the threshold needs a rethink OR the agent is too strict.

select
  (score / 10) * 10                as bucket_start,
  (score / 10) * 10 + 9            as bucket_end,
  count(*)                         as hits,
  repeat('#', count(*)::int)       as bar
from auction_hits
where fetched_at > now() - interval '7 days'
group by 1, 2
order by 1;
