-- Confirms the (source, source_listing_id) unique constraint on auction_hits
-- is holding. Should always return zero rows. If not, the upsert logic is
-- broken and the agent is creating dupes.

select
  source,
  source_listing_id,
  count(*) as dupe_count,
  array_agg(id order by fetched_at) as row_ids,
  min(fetched_at) as first_seen,
  max(fetched_at) as last_seen
from auction_hits
group by source, source_listing_id
having count(*) > 1
order by dupe_count desc, last_seen desc;
