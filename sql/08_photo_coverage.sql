-- Photo coverage per hit, last 30 days. Flags anything with < 4 photos
-- (score penalty applies) and anything with no cover photo.
-- Cross-checks auction_photos rows against auction_hits.photo_count to
-- detect drift.

select
  ah.id,
  ah.fetched_at at time zone 'Australia/Perth' as fetched_awst,
  ah.source,
  ah.source_listing_id,
  ah.year, ah.make, ah.model,
  ah.photo_count                                      as reported_photo_count,
  count(ap.id)                                        as actual_photo_rows,
  ah.cover_photo_url is not null                      as has_cover_url,
  case
    when count(ap.id) < 4                             then 'low_photo_count'
    when ah.photo_count != count(ap.id)               then 'count_mismatch'
    when ah.cover_photo_url is null                   then 'no_cover_url'
    else 'ok'
  end                                                 as status
from auction_hits ah
left join auction_photos ap on ap.auction_hit_id = ah.id
where ah.fetched_at > now() - interval '30 days'
group by ah.id, ah.fetched_at, ah.source, ah.source_listing_id,
         ah.year, ah.make, ah.model, ah.photo_count, ah.cover_photo_url
order by fetched_awst desc;
