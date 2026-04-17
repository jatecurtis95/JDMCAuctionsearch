# JDM Connect Auction Monitoring Agent

**Handover brief for Claude Code / Cursor**

**Project owner:** Jate Curtis, JDM Connect Pty Ltd
**Build target:** Production-ready Claude Managed Agent that continuously scans Japanese auction listings, triages them against SEVS/MRE eligibility and JDMC landed cost logic, and writes qualified hits to Supabase + Notion with alerting via Microsoft 365.
**Beta header required:** `anthropic-beta: managed-agents-2026-04-01` (the Claude SDK adds this automatically)

---

## 1. Executive summary

Build a Claude Managed Agent named `jdmc-auction-scout` that runs once daily on a morning cron (09:00 AWST, which is 10:00 JST, before the Japan auction business day really gets going). Each run:

1. Fetches all new/updated listings from the last 24 hours from one auction source (MVP: pick ONE of USS, TAA, ASNET)
2. For each listing, translates the Japanese auction sheet, checks SEVS/MRE eligibility, estimates landed cost, and scores the opportunity
3. Writes qualified hits (score >= threshold) to Supabase and a Notion "Auction Scout" database
4. Sends a single morning summary email via M365 with all hits ranked by score, with thumbnail contact sheet for high-score hits

The goal is NOT to replace human judgement on auctions. It is to eliminate the manual triage step so Jate and the team only look at pre-qualified, pre-costed candidates that match JDMC's actual sourcing priorities.

---

## 2. Architecture

```
                  +----------------------+
                  |  Trigger (cron)      |
                  |  once daily, 09:00   |
                  |  AWST / 10:00 JST    |
                  +----------+-----------+
                             |
                             v
              +--------------+---------------+
              |  Session launcher (Node/TS)  |
              |  on Vercel / Fly / your box  |
              +--------------+---------------+
                             |
                             v
              +--------------+---------------+
              |  Claude Managed Agent         |
              |  (Anthropic-hosted container) |
              |  model: claude-sonnet-4-6     |
              +---+-----------+-----------+---+
                  |           |           |
                  v           v           v
         +--------+--+  +-----+------+  +-+------------+
         |  Tools:   |  |  MCP:      |  |  Skills:     |
         |  - bash   |  |  Supabase  |  |  rover-      |
         |  - file   |  |  Notion    |  |   eligibility|
         |  - web    |  |  M365      |  |  jdm-auction-|
         |           |  |            |  |   translation|
         +-----------+  +------------+  +--------------+
                             |
                             v
              +--------------+---------------+
              |  Writes:                     |
              |  - Supabase: auction_hits    |
              |  - Supabase Storage: photos  |
              |    + translated sheet PDF    |
              |  - Notion: Auction Scout DB  |
              |    (with photo gallery)      |
              |  - Email via M365 (with      |
              |    thumbnail contact sheet)  |
              +------------------------------+
```

**Why this shape:** The session launcher is a tiny stateless piece of code that creates a Managed Agent session, sends the kickoff message, and exits. All the heavy work (scraping, translation, scoring, DB writes) happens inside the managed container. You never run a long-lived server yourself.

---

## 3. Prerequisites

Before any code:

1. **Anthropic Console account** at console.anthropic.com, separate from claude.ai. Generate an API key, enable billing, set a monthly spend cap of USD $100 to start.
2. **Supabase project** already exists (jdm-ops-hub). We will add a new table `auction_hits`.
3. **Notion**: create a new database titled "Auction Scout" in the JDM Connect workspace.
4. **M365**: the imports@jdmconnect.com.au mailbox will send the summary email. If the Conditional Access issue is still blocking SMTP, fall back to sending via Graph API with an app registration.
5. **Pick ONE auction source for MVP.** Recommend ASNET if API-adjacent access is available, otherwise USS via scraping. Do not attempt all three in v1.
6. **Secrets** required:
   - `ANTHROPIC_API_KEY`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `NOTION_API_KEY`, `NOTION_DATABASE_ID` (Auction Scout DB)
   - `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_SECRET` (for Graph API send-mail)
   - `AUCTION_SOURCE_CREDS` (source-specific)

---

## 4. Supabase schema

Run this migration against the jdm-ops-hub project:

```sql
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
  translated_sheet jsonb,                            -- structured English (see below)
  translated_sheet_markdown text,                    -- human-readable version
  photo_count      int default 0,
  cover_photo_url  text,                             -- for Notion preview + email
  raw_payload      jsonb,

  -- Workflow state
  status           text not null default 'new',      -- 'new' | 'shortlisted' | 'bid' | 'won' | 'lost' | 'ignored'
  notion_page_id   text,

  unique (source, source_listing_id)
);

create index auction_hits_score_idx on auction_hits (score desc, fetched_at desc);
create index auction_hits_status_idx on auction_hits (status);

-- Photo storage, one row per image
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

create index auction_photos_hit_idx on auction_photos (auction_hit_id, sequence);
```

### Supabase Storage buckets

Create two buckets in the jdm-ops-hub Supabase project:

- `auction-photos` (public read, authenticated write). Path convention: `{source}/{source_listing_id}/{sequence}.jpg`
- `auction-sheets` (public read, authenticated write). Path convention: `{source}/{source_listing_id}/sheet.jpg` plus `sheet_translated.pdf`

### Structure of `translated_sheet` JSON

The agent should populate this with a consistent shape so downstream queries work:

```json
{
  "vehicle": {
    "make": "Nissan", "model": "Silvia", "grade": "Spec-R",
    "chassis": "S15-123456", "year": 2001, "build_date": "2001-07",
    "transmission": "6MT", "colour": "Aztec Red",
    "mileage_km": 78500, "engine": "SR20DET"
  },
  "auction": {
    "house": "USS Tokyo", "lot": "4521",
    "auction_date": "2026-04-22", "grade": "4", "interior": "B",
    "start_price_jpy": 850000
  },
  "condition_notes": [
    { "area": "front bumper", "code": "A2", "en": "small scratch, lower lip" },
    { "area": "rear quarter R", "code": "W1", "en": "minor wave, previously repaired" }
  ],
  "equipment": ["air con", "power steering", "ABS", "HID headlights"],
  "inspector_comments_en": "Overall clean example. Interior well kept. Engine sound on test.",
  "inspector_comments_jp_original": "...",
  "warnings": []
}
```

The `unique (source, source_listing_id)` constraint is the deduplication anchor. Every run does an upsert, not an insert, so re-scanning the same listing is idempotent.

---

## 5. Notion "Auction Scout" database schema

Create a Notion database with these properties:

| Property | Type | Notes |
|---|---|---|
| Title | Title | Auto-generated as `{Year} {Make} {Model} {Grade}` |
| Source | Select | USS, TAA, ASNET |
| Auction Date | Date | |
| Score | Number | 0-100, colour-coded |
| Status | Status | New, Shortlisted, Bidding, Won, Lost, Ignored |
| Make | Select | |
| Model | Text | |
| Grade | Text | |
| Year | Number | |
| Mileage (km) | Number | |
| Auction Grade | Text | |
| SEVS | Checkbox | |
| MRE | Checkbox | |
| JPY Expected | Number | Currency: JPY |
| Landed Cost AUD | Number | Currency: AUD |
| Est Margin AUD | Number | Currency: AUD |
| Est Margin % | Number | Percent |
| Auction Sheet | URL | Original JP sheet |
| Translated Sheet | Text | Rich text, markdown rendering of structured translation |
| Cover Photo | Files & Media | First/cover photo |
| Photo Gallery | Files & Media | Up to 15 photos, exterior + interior |
| Photo Count | Number | How many total photos were fetched |
| Reasoning | Text | Score reasoning from the agent |
| Supabase ID | Text | Link back to the auction_hits row |

---

## 6. Agent definition

Create the agent ONCE, reference by ID across all sessions.

```bash
curl -sS https://api.anthropic.com/v1/agents \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: managed-agents-2026-04-01" \
  -H "content-type: application/json" \
  -d @- <<'EOF'
{
  "name": "jdmc-auction-scout",
  "model": "claude-sonnet-4-6",
  "system": "SEE SECTION 7 BELOW - paste the system prompt here",
  "tools": [
    { "type": "bash" },
    { "type": "file" },
    { "type": "web_search" }
  ],
  "mcp_servers": [
    { "type": "url", "url": "https://mcp.supabase.com/mcp", "name": "supabase" },
    { "type": "url", "url": "https://mcp.notion.com/mcp", "name": "notion" },
    { "type": "url", "url": "https://microsoft365.mcp.claude.com/mcp", "name": "m365" }
  ]
}
EOF
```

Save the returned `agent.id`. Store it as `JDMC_AGENT_ID` in your env.

---

## 7. System prompt

This is the single most important part of the build. It encodes all of JDMC's sourcing intelligence. Paste verbatim into the agent definition.

```
You are the JDM Connect Auction Scout, an autonomous agent that triages
Japanese car auction listings for JDM Connect Pty Ltd (Perth, WA).

## Your job
For each run, you will:
1. Fetch the latest auction listings from the configured source
2. For each new listing:
   a. Download the auction sheet image and all available vehicle photos
   b. Upload photos to Supabase Storage bucket 'auction-photos', path
      '{source}/{source_listing_id}/{sequence}.jpg'. Upload the sheet image to
      'auction-sheets' bucket at '{source}/{source_listing_id}/sheet.jpg'.
   c. Translate the auction sheet using your vision capability. Produce both
      the structured JSON (see schema in handover brief) AND a clean
      markdown version for human reading. Preserve the original Japanese
      inspector comments verbatim for audit.
3. Check SEVS and MRE eligibility using the rover-eligibility skill
4. Estimate landed cost in AUD using JDMC's cost model (below)
5. Estimate resale price and margin based on comparable AU market data
6. Score the opportunity 0-100
7. Upsert to Supabase (auction_hits + auction_photos) and Notion (Auction
   Scout DB). In Notion, attach the cover photo to the 'Cover Photo' field
   and populate 'Photo Gallery' with up to 15 photos max. Paste the
   markdown translation into the 'Translated Sheet' rich text field.
8. Email a summary to jate@jdmconnect.com.au if any hit scores >= 75. The
   email must include a thumbnail contact sheet (cover photo of each
   high-score hit) and a Notion link per hit.

## Translation standard
- Translate all Japanese text on the sheet: condition map codes, grade
  boxes, mileage, equipment list, inspector free-text comments.
- Standard auction condition codes (A, B, C, U, W, S, X, XX) should be
  expanded into English plain language, e.g. "A2 on front bumper" becomes
  "scratch, front bumper, small (A2)".
- Never discard the original Japanese. Store it in
  inspector_comments_jp_original so nothing is lost in translation.
- If a code or kanji is ambiguous, flag it in the 'warnings' array rather
  than guessing.

## Photo handling
- Download every photo the listing page exposes. Do not pre-filter.
- The first photo (cover) should be a front 3/4 exterior shot if available,
  otherwise the first photo in the source listing order.
- Preserve source resolution. Do not resize or recompress. If the source
  only offers ~1000px images, that is the ceiling, be clear about this in
  the email if asked.
- If a listing has fewer than 4 photos, flag 'low_photo_count' in warnings.
  Score penalty: -5.
- Store every photo as a row in auction_photos with the sequence number.

## Sourcing priorities (Tier 1, score boost +15)
- Nissan Silvia S15 (all grades, Spec-R preferred)
- Toyota Crown Athlete (200-series, turbo)
- Subaru WRX STI GVB / GRB
- Nissan Skyline R34 GT-R and GT-T
- Honda Civic Type R (EK9, EP3, FD2)
- Mazda RX-7 FD3S

## Hard pass filters (do not write to DB, log only)
- Salvage / accident-repaired (R grade) unless auction grade is 4 or higher
- Mileage > 180,000 km
- Build date outside SEVS/MRE eligibility window
- Vehicles NOT on SEVS/MRE and not exempt via 25-year rule
- Starting price > JPY 10,000,000 unless Tier 1 priority

## Cost model (use these rates)
- JPY to AUD: fetch current rate, use mid-market
- Auction fees: JPY 50,000
- Japan-side ground: JPY 30,000
- Shipping (Dolphin): AUD 3,200 (RORO) or AUD 4,800 (container)
- Duty: 0% (JAEPA)
- GST: 10% on (FOB + shipping + duty)
- LCT: apply if dutiable value > FY25-26 threshold (AUD 91,387 for fuel-efficient, AUD 80,567 otherwise)
- Compliance (SEVS RAWS): AUD 12,000 typical
- JDMC margin: AUD 8,000 minimum

## Scoring rubric (0-100)
Start at 50, then adjust:
+15 if Tier 1 priority vehicle
+10 if auction grade >= 4
+10 if mileage < 80,000 km
+10 if est margin % >= 20
+5  if est margin % 10-20
-10 if auction grade < 3.5
-15 if interior grade C or worse
-10 if km > 150,000
-20 if est margin % < 5
Cap at 100, floor at 0.

## Output discipline
- Do NOT hallucinate market data. If you don't have a reliable AU resale comp,
  mark est_resale_aud as null and note "no comp" in reasoning.
- Do NOT write to Notion or send email if Supabase write fails.
- If you encounter a listing that can't be fully parsed, log it with
  status='new' and score=0, reasoning='parse_failed: <details>'. Do not skip it.
- Prefer conservative estimates. Under-promising margin is safer than over.

## Tone for the summary email
Plain, factual, no marketing language. Structure:
- Subject: "Auction Scout: {N} hits (top score {S})"
- Body: numbered list of hits, highest score first, each with one-line summary
  and a Notion link. No emojis, no em dashes.
```

> **Note on the em dash rule**: Jate's preference is no em dashes in any output. The system prompt above already reflects this. Keep it that way in any edits.

---

## 8. Environment config

```bash
curl -sS https://api.anthropic.com/v1/environments \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: managed-agents-2026-04-01" \
  -H "content-type: application/json" \
  -d @- <<'EOF'
{
  "name": "jdmc-auction-scout-env",
  "config": {
    "type": "cloud",
    "networking": { "type": "unrestricted" },
    "packages": {
      "python": ["httpx", "beautifulsoup4", "lxml", "pypdf", "pillow"],
      "node": []
    }
  }
}
EOF
```

Save the returned `environment.id` as `JDMC_ENV_ID`.

`unrestricted` networking is needed because the agent has to hit the auction source and the MCP servers. If the auction source becomes IP-sensitive later, narrow this down.

---

## 9. Session launcher (TypeScript)

This is the tiny piece of code you actually deploy. It runs on a cron, creates a session, sends the kickoff message, then exits. The agent does the rest inside the managed container.

```typescript
// src/launch-session.ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const AGENT_ID = process.env.JDMC_AGENT_ID!;
const ENV_ID   = process.env.JDMC_ENV_ID!;

async function main() {
  const now = new Date().toISOString();

  const session = await client.sessions.create({
    agent: AGENT_ID,
    environment_id: ENV_ID,
    title: `auction-scout ${now}`,
  });

  // Kickoff message
  await client.sessions.events.create(session.id, {
    type: "user_message",
    content: `Run the auction scout now.

Source: ${process.env.AUCTION_SOURCE ?? "USS"}
Window: listings updated in the last 24 hours.
Max listings to process this run: 300.
High-score alert threshold: 75.
Always send a summary email, even if zero high-score hits (report "no hits today" with total listings scanned).

Credentials available in env:
- SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
- NOTION_DATABASE_ID
- AUCTION_SOURCE_CREDS

Follow your system prompt. Emit session.status_idle when done.`,
  });

  console.log(`Launched session ${session.id}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

### Deployment

Three reasonable options, pick one:

1. **Vercel Cron** (simplest). Put `launch-session.ts` behind an API route, add `vercel.json` with a cron schedule. Note Vercel's cron minimum is daily on the free tier, hourly on Pro.
2. **Fly.io scheduled machines**. Better for sub-hourly cadence.
3. **GitHub Actions cron**. Free, 30-min granularity, fine for MVP.

For MVP, GitHub Actions is zero-cost and good enough. Example workflow:

```yaml
# .github/workflows/auction-scout.yml
name: auction-scout
on:
  schedule:
    # once daily, 09:00 AWST (Perth) = 01:00 UTC
    - cron: "0 1 * * *"
  workflow_dispatch: {}

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: npm ci
      - run: npx tsx src/launch-session.ts
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          JDMC_AGENT_ID:     ${{ secrets.JDMC_AGENT_ID }}
          JDMC_ENV_ID:       ${{ secrets.JDMC_ENV_ID }}
          AUCTION_SOURCE:    USS
```

---

## 10. Testing plan

Build in this order, do not skip steps:

1. **Shadow mode first.** For the first 3 days of operation, set a flag that writes to Supabase but NOT to Notion or email. Review the auction_hits table manually. This catches bad scoring before it creates noise.
2. **Single-listing harness.** Before wiring the cron, run the agent once against a known past auction listing where you already know the right answer. Verify score, eligibility, and cost estimate are within tolerance.
3. **Score calibration.** After 100 listings in shadow mode, manually label 20 as "would have bid" / "would have passed" and check the score distribution. Adjust the rubric in the system prompt if needed.
4. **Turn on Notion writes.** Leave email off for another 2-3 days.
5. **Turn on email.** Set the threshold conservatively at first (score >= 85). Lower to 75 once you trust it.

---

## 11. Cost control

At the agent level:

- Set a monthly API spend cap of USD $75 in the Anthropic Console. At once-daily cadence with vision translation, actual spend should sit well under this.
- Enable prompt caching on the system prompt (the sourcing priorities and cost model don't change run to run). This is especially valuable on daily cadence since the full system prompt is cache-friendly.
- Use `claude-haiku-4-5` for listing list-extraction and `claude-sonnet-4-6` only for the translation, scoring, and reasoning steps. Sonnet 4.6 has vision and is the right model for the sheet translation. This is an optimisation worth doing in v1 because vision work is where most of the tokens go.
- Monitor session.active_hours in the Anthropic Console weekly. A daily run processing ~200-300 listings should complete in 20-40 minutes. If it's running longer than 60 min, something is wrong (photo downloads or scraping retries are usually the culprit).

Realistic steady-state cost estimate at daily cadence: **USD $20-30/month all-in.** Supabase Storage adds approximately USD $1-3/month.

---

## 12. Observability

- All agent runs log to Supabase `auction_hits` with `fetched_at`.
- Add a second table `agent_runs` with columns `id, session_id, started_at, ended_at, listings_processed, hits_written, errors jsonb`.
- Weekly review: query `select count(*), avg(score) from auction_hits where fetched_at > now() - interval '7 days' group by source;`

---

## 13. Out of scope for v1

Explicitly NOT building in the first version:

- Multi-source monitoring (start with one)
- Automated bidding (human-in-the-loop always)
- Damage detection or paint-thickness analysis from photos (just show them, don't analyse them beyond what the sheet already says)
- Integration with GHL CRM (auction_hits is upstream of the CRM funnel)
- Mobile push alerts (email with thumbnail contact sheet is fine for v1)
- Historical backfill (only forward-looking from the cron start date)
- Full-resolution photo archival (storing whatever the source exposes, not attempting to fetch higher-res versions through scraping tricks)

These are all good v2 candidates once v1 is stable.

---

## 14. Handover checklist

Before you hand control to the cron:

- [ ] Anthropic Console account + API key + USD $100 monthly cap set
- [ ] Supabase migration run, `auction_hits` and `agent_runs` tables exist
- [ ] Notion "Auction Scout" database created with all properties
- [ ] M365 Graph API app registration done, test send-mail successful
- [ ] Agent created, `JDMC_AGENT_ID` saved
- [ ] Environment created, `JDMC_ENV_ID` saved
- [ ] Single-listing harness test passed
- [ ] 3-day shadow mode review complete, scoring calibrated
- [ ] GitHub Actions workflow deployed with secrets set
- [ ] First production run observed end-to-end
- [ ] Notion + email enabled

---

## 15. Known unknowns

Flag these back to Jate before or during the build:

1. **Auction source access.** ASNET access status is unconfirmed. If scraping USS or TAA, check their ToS and consider whether a residential proxy is needed.
2. **M365 SMTP Conditional Access.** Still blocked per the last handover. Graph API send-mail via app registration is the workaround.
3. **Resale comp data source.** The agent needs AU market comps to estimate resale. Options: CarSales API (paid), manual comp table in Supabase populated from past JDMC deals, or skip resale estimation in v1 and score purely on JPY cost + eligibility.
4. **Concurrency.** If two cron runs overlap (one runs long), the second will still launch. The upsert on `(source, source_listing_id)` prevents duplicate rows but you may want a simple lock table if this becomes an issue.
5. **Photo resolution ceiling.** Most auction sources only serve ~1000px images on the public listing page. True HD/original-resolution photos are typically only available after winning the lot or via paid API tiers. Don't promise "HD" in the email if the source only exposes medium-res, just show what's actually available and be accurate about it.
6. **Supabase Storage costs.** At ~15 photos per listing, ~200KB each, 50 listings per run, 20 runs per day, that's roughly 3GB/month of new storage before cleanup. Cheap but not free. Consider a 90-day retention policy for non-shortlisted hits.

---

**End of brief.** Drop this file at the root of a new repo, then tell Claude Code: "Read JDMC_Auction_Agent_Handover_Brief.md and build this. Start with step 14's checklist in order. Ask me before making any architectural changes."
