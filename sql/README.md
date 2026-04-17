# SQL queries for the Auction Scout data

Reusable, read-only diagnostic queries against the `jdm-connect` Supabase project. Each file is named `NN_subject.sql` and contains one query, commented. Run them via the Supabase SQL editor, `psql`, or the Supabase MCP's `execute_sql`.

| File | What it answers |
|---|---|
| `01_daily_summary.sql` | One row per day: hits written, top score, runs, avg score. Good morning report. |
| `02_latest_hits.sql` | Newest 20 `auction_hits` with the fields Jate actually cares about. |
| `03_runs_trend.sql` | `agent_runs` rolled up by day, for a "is the agent healthy" glance. |
| `04_score_distribution.sql` | Histogram of scores by 10-point bucket, last 7 days. |
| `05_warnings_frequency.sql` | Which warnings fire most often, unnested from the `warnings` jsonb in `agent_runs`. Tells us what the agent struggles with. |
| `06_hard_pass_breakdown.sql` | Hard pass reasons weighted, last 7 days. Tells us what is filtering the firehose. |
| `07_tier1_tracker.sql` | Only the Tier 1 priority vehicles from the system prompt. Daily check. |
| `08_photo_coverage.sql` | Photo counts per hit, flags anything with < 4 photos. |
| `09_sync_gaps.sql` | Hits missing a `notion_page_id` or with a stale Notion page. Catches Supabase/Notion drift. |
| `10_dedup_check.sql` | Confirms the `(source, source_listing_id)` unique constraint is holding. |
