-- One row per day for the last 14 days. Treat as the morning report.
-- Joins agent_runs and auction_hits on the date of fetched_at / started_at.

with day_hits as (
  select
    date_trunc('day', fetched_at at time zone 'Australia/Perth') as day,
    count(*)                                                      as hits_written,
    count(*) filter (where score >= 75)                           as high_score_hits,
    max(score)                                                    as top_score,
    round(avg(score), 1)                                          as avg_score
  from auction_hits
  where fetched_at > now() - interval '14 days'
  group by 1
),
day_runs as (
  select
    date_trunc('day', started_at at time zone 'Australia/Perth') as day,
    count(*)                                                      as runs,
    sum(listings_scanned)                                         as listings_scanned,
    sum(hits_written)                                             as runs_hits_written
  from agent_runs
  where started_at > now() - interval '14 days'
  group by 1
)
select
  coalesce(dh.day, dr.day)::date       as day_awst,
  coalesce(dr.runs, 0)                 as runs,
  coalesce(dr.listings_scanned, 0)     as listings_scanned,
  coalesce(dh.hits_written, 0)         as hits_written,
  coalesce(dh.high_score_hits, 0)      as high_score_hits,
  dh.top_score,
  dh.avg_score
from day_hits dh
full outer join day_runs dr on dh.day = dr.day
order by day_awst desc;
