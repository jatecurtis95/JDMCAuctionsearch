-- agent_runs rolled up by day, with the usual ratio derivations.
-- If 'runs_this_day' is 0 or 'listings_scanned' is low, the cron had a bad day.

select
  date_trunc('day', started_at at time zone 'Australia/Perth')::date as day_awst,
  count(*)                                                            as runs,
  sum(listings_scanned)                                               as listings_scanned,
  sum(listings_eligible)                                              as listings_eligible,
  round(
    100.0 * sum(listings_eligible)::numeric / nullif(sum(listings_scanned), 0),
    2
  )                                                                   as pct_eligible,
  sum(hits_written)                                                   as hits_written,
  sum(high_score_hits)                                                as high_score_hits,
  max(top_score)                                                      as top_score,
  sum(hard_pass_count)                                                as hard_pass_count,
  round(
    extract(epoch from avg(ended_at - started_at)) / 60.0,
    1
  )                                                                   as avg_run_minutes
from agent_runs
where started_at > now() - interval '30 days'
group by 1
order by day_awst desc;
