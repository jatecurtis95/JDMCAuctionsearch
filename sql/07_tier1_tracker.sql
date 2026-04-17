-- Tier 1 priority vehicles only, last 30 days.
-- Brief section 7 Tier 1 list: Silvia S15, Crown Athlete 200-series turbo,
-- Subaru WRX STI GVB/GRB, Skyline R34 GT-R/GT-T, Civic Type R EK9/EP3/FD2,
-- Mazda RX-7 FD3S. Pattern match is deliberately loose, the agent's
-- `make`/`model`/`grade` fields are not perfectly normalized.

select
  fetched_at at time zone 'Australia/Perth' as fetched_awst,
  source, source_listing_id,
  year, make, model, grade, chassis_code,
  mileage_km, auction_grade,
  sevs_eligible, mre_eligible,
  jpy_expected_bid, landed_cost_aud, est_margin_pct,
  score, status,
  notion_page_id
from auction_hits
where fetched_at > now() - interval '30 days'
  and (
    -- Silvia S15
    (lower(model) like '%silvia%' and (chassis_code ilike 'S15%' or model ilike '%S15%'))
    -- Crown Athlete 200-series turbo
 or (lower(model) like '%crown%' and lower(grade) like '%athlete%'
     and (chassis_code ilike 'GRS20%' or chassis_code ilike 'UZS20%'))
    -- WRX STI GVB/GRB
 or (lower(make) like '%subaru%' and (chassis_code ilike 'GVB%' or chassis_code ilike 'GRB%'))
    -- Skyline R34 GT-R/GT-T
 or (lower(model) like '%skyline%' and (chassis_code ilike 'BNR34%' or chassis_code ilike 'ER34%'))
    -- Civic Type R
 or (lower(model) like '%civic%' and lower(grade) like '%type r%'
     and (chassis_code ilike 'EK9%' or chassis_code ilike 'EP3%' or chassis_code ilike 'FD2%'))
    -- RX-7 FD3S
 or (lower(model) like '%rx-7%' or chassis_code ilike 'FD3S%')
  )
order by score desc, fetched_at desc;
