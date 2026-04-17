# docs

## dashboard.html

A single-file live dashboard over the Auction Scout Supabase data. Open it any of three ways:

1. **Double click the file in Finder / Explorer.** It opens in your default browser, talks to Supabase directly. No install, no build, no server.
2. **Serve it locally** if your browser complains about local file fetch:
   ```
   cd docs && python3 -m http.server 8080
   ```
   Then open `http://localhost:8080/dashboard.html`.
3. **Host it.** Anywhere that serves static HTML works (Supabase Storage public bucket, GitHub Pages, Vercel, whatever). It talks to Supabase REST using the public anon key, no server-side rendering needed.

What it shows, left to right, top to bottom:

- **KPI cards:** hits today AWST, runs today, top score today, all-time high-score hit count, all-time total hits.
- **Latest hits table:** last 10 rows from `auction_hits` with cover thumbnail, vehicle, source, grade, km, landed cost AUD, margin %, score badge (green ≥ 75, amber 50 to 74, red < 50), status, Notion link, fetched timestamp.
- **Score distribution:** 10-point bucket histogram over the last 7 days. Useful for calibration, if everything clusters in the 40 to 60 band the rubric is too flat.
- **Runs trend:** 14 day line chart of scanned / hits written / high-score hits from `agent_runs`.
- **Hard pass reasons:** 30 day bar chart from `agent_runs.hard_pass_reasons`. Tells you what the firehose is being filtered by (usually SEVS ineligibility).
- **Warning frequency:** 30 day bar chart from `agent_runs.warnings`. Tells you what the agent is struggling with (low_photo_count, no_auction_sheet, sevs_unconfirmed).

Auto-refreshes every 60 seconds. Click the Refresh button to force.

### Notes on the anon key

The Supabase anon key embedded in the HTML is public by design, it only grants what Supabase Row-Level Security and table GRANTs allow. RLS on `auction_hits`, `auction_photos`, and `agent_runs` is currently off, so anon can read them but not write. If you ever turn on RLS, add a `select` policy for the `anon` role or the dashboard will silently empty out.
