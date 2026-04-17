-- ============================================================================
-- JDMC Auction Scout: initial schema
-- ----------------------------------------------------------------------------
-- Source:    JDMC_Auction_Agent_Handover_Brief.md, section 4
-- Generated: 2026-04-17
-- Target:    Supabase project jdm-ops-hub
--
-- This migration creates:
--   1. auction_hits    main triage table, one row per auction listing
--   2. auction_photos  child table, one row per downloaded image
--   3. Storage buckets 'auction-photos' and 'auction-sheets'
--      (public read, authenticated write)
--
-- Out of scope for this migration (flagged for follow-ups):
--   * agent_runs observability table (brief section 12) will ship in a
--     separate migration once agent launch wiring lands.
--   * RLS policies on auction_hits / auction_photos. The agent writes
--     with SUPABASE_SERVICE_ROLE_KEY which bypasses RLS, so tightening
--     these tables is a hardening pass, not a v1 requirement.
-- ============================================================================

-- ============================================================
-- Table: auction_hits
-- ============================================================
create table if not exists auction_hits (
  id               uuid primary key default gen_random_uuid(),
  source           text not null,                    -- 'USS' | 'TAA' | 'ASNET'
  source_listing_id text not null,                   -- the auction house's ID
  auction_date     timestamptz,
  fetched_at       timestamptz not null default now(),

  -- Vehicle
  make             text,
  model            text,
  grade            text,
  year             int,
  build_date       date,
  chassis_code     text,
  mileage_km       int,
  transmission     text,
  colour           text,
  auction_grade    text,                             -- e.g. '4.5', 'R', 'S'
  interior_grade   text,                             -- e.g. 'B', 'C'

  -- Eligibility
  sevs_eligible    boolean,
  mre_eligible     boolean,
  eligibility_notes text,

  -- Cost
  jpy_start_price  int,
  jpy_expected_bid int,
  landed_cost_aud  numeric(12,2),
  est_resale_aud   numeric(12,2),
  est_margin_aud   numeric(12,2),
  est_margin_pct   numeric(5,2),

  -- Scoring
  score            int not null,                     -- 0-100
  score_reasoning  text,

  -- Raw artefacts for audit
  auction_sheet_url text,                            -- original JP sheet
  auction_sheet_image_path text,                     -- Supabase Storage path
  translated_sheet jsonb,                            -- structured English, see brief section 4
  translated_sheet_markdown text,                    -- human-readable version
  photo_count      int default 0,
  cover_photo_url  text,                             -- for Notion preview + email
  raw_payload      jsonb,

  -- Workflow state
  status           text not null default 'new',      -- 'new' | 'shortlisted' | 'bid' | 'won' | 'lost' | 'ignored'
  notion_page_id   text,

  unique (source, source_listing_id)
);

create index if not exists auction_hits_score_idx
  on auction_hits (score desc, fetched_at desc);

create index if not exists auction_hits_status_idx
  on auction_hits (status);

-- ============================================================
-- Table: auction_photos
-- ============================================================
create table if not exists auction_photos (
  id               uuid primary key default gen_random_uuid(),
  auction_hit_id   uuid not null references auction_hits(id) on delete cascade,
  sequence         int not null,                     -- 1 = cover, 2+ = rest
  storage_path     text not null,                    -- path in Supabase Storage
  public_url       text not null,                    -- signed or public URL
  width_px         int,
  height_px        int,
  size_bytes       int,
  caption          text,                             -- optional, e.g. 'front 3/4'
  unique (auction_hit_id, sequence)
);

create index if not exists auction_photos_hit_idx
  on auction_photos (auction_hit_id, sequence);

-- ============================================================
-- Storage buckets
-- ------------------------------------------------------------
-- Brief section 4 specifies:
--   auction-photos  path: {source}/{source_listing_id}/{sequence}.jpg
--   auction-sheets  path: {source}/{source_listing_id}/sheet.jpg
--                   plus sheet_translated.pdf
-- Path conventions are enforced by the agent at write time, not by
-- database constraints.
-- ============================================================

insert into storage.buckets (id, name, public)
values ('auction-photos', 'auction-photos', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('auction-sheets', 'auction-sheets', true)
on conflict (id) do nothing;

-- Authenticated write policies on storage.objects for both buckets.
-- Service-role writes bypass RLS, so these matter only if a non-service
-- client ever needs to upload. Kept permissive by design, tighten later.

drop policy if exists "jdmc_auction_photos_authenticated_insert"
  on storage.objects;
create policy "jdmc_auction_photos_authenticated_insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'auction-photos');

drop policy if exists "jdmc_auction_photos_authenticated_update"
  on storage.objects;
create policy "jdmc_auction_photos_authenticated_update"
  on storage.objects for update to authenticated
  using (bucket_id = 'auction-photos');

drop policy if exists "jdmc_auction_sheets_authenticated_insert"
  on storage.objects;
create policy "jdmc_auction_sheets_authenticated_insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'auction-sheets');

drop policy if exists "jdmc_auction_sheets_authenticated_update"
  on storage.objects;
create policy "jdmc_auction_sheets_authenticated_update"
  on storage.objects for update to authenticated
  using (bucket_id = 'auction-sheets');
