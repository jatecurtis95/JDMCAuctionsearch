-- Newest 20 auction_hits with the fields that matter for a quick eyeball.
-- Order matches the daily email layout.

select
  fetched_at at time zone 'Australia/Perth'           as fetched_awst,
  source,
  source_listing_id,
  year, make, model, grade,
  mileage_km,
  auction_grade,
  sevs_eligible,
  mre_eligible,
  jpy_expected_bid                                    as jpy_expected,
  landed_cost_aud,
  est_resale_aud,
  est_margin_aud,
  est_margin_pct,
  score,
  status,
  left(score_reasoning, 120)                          as reasoning_preview,
  notion_page_id is not null                          as in_notion
from auction_hits
order by fetched_at desc
limit 20;
