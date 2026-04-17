-- Supabase to Notion sync gaps. If the agent wrote to auction_hits but
-- failed to mirror to Notion, the row will have notion_page_id null.
-- These rows are "silently missing" from Notion and need a manual fix
-- or a re-dispatch.

select
  id,
  fetched_at at time zone 'Australia/Perth'   as fetched_awst,
  source,
  source_listing_id,
  year, make, model, grade,
  score,
  status,
  'missing_notion_page'                       as sync_gap
from auction_hits
where notion_page_id is null
  and fetched_at > now() - interval '30 days'
order by fetched_at desc;
