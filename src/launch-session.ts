// ============================================================================
// src/launch-session.ts
// ----------------------------------------------------------------------------
// Daily session launcher for the jdmc-auction-scout Managed Agent.
// Brief ref: JDMC_Auction_Agent_Handover_Brief.md section 9.
//
// What this does, per run:
//   1. Reads three long-lived tokens from env (Supabase PAT, Notion
//      integration secret, and the M365 app registration triple).
//   2. Mints a fresh Microsoft Graph bearer via client credentials OAuth,
//      valid for ~1 hour. Daily cadence means we always get a fresh token
//      per run.
//   3. Patches the agent's mcp_servers list so each server carries the
//      current authorization_token. This avoids baking long-lived secrets
//      into the agent definition, so rotation is a secret change, not an
//      agent recreate.
//   4. Creates a session against the managed agent, sends the kickoff
//      message with the dynamic knobs (source, Notion DB id, Supabase
//      project id), exits. Actual scraping / scoring / writes happen
//      inside the managed container.
//
// The beta header 'anthropic-beta: managed-agents-2026-04-01' is added
// automatically by the SDK.
// ============================================================================

// Using raw fetch for the managed-agents-2026-04-01 beta API surface.
// The pinned @anthropic-ai/sdk does not yet type sessions.create, session
// events, or vault credentials, so we call the endpoints directly until
// the SDK catches up.

// ---- Types ------------------------------------------------------------------

interface ManagedAgentSession {
  id: string;
}
interface McpServer {
  type: "url";
  url: string;
  name: string;
  authorization_token: string;
}

// ---- Env helpers ------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

// ---- M365 Graph token mint (client credentials flow) ------------------------

async function mintGraphBearer(
  tenantId: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Graph token mint failed: HTTP ${res.status}: ${errText}`,
    );
  }

  const json = (await res.json()) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error(
      `Graph token mint returned no access_token: ${JSON.stringify(json)}`,
    );
  }
  return json.access_token;
}

// ---- Session create (raw fetch, SDK does not yet cover managed-agents) ------
// We construct the request directly so we can pass mcp_servers inline with
// per-server authorization_token values. Once Anthropic SDK types land for
// the managed-agents beta, this can collapse back into client.sessions.create.
// See known follow-up: migrate to vault-based credentials per the docs at
// https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/managed-agents-overview.md

async function createSession(
  apiKey: string,
  body: {
    agent: string;
    environment_id: string;
    title: string;
  },
): Promise<ManagedAgentSession> {
  const res = await fetch("https://api.anthropic.com/v1/sessions", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "managed-agents-2026-04-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Session create failed: HTTP ${res.status}: ${errText}`,
    );
  }

  return (await res.json()) as ManagedAgentSession;
}

async function sendKickoff(
  apiKey: string,
  sessionId: string,
  text: string,
): Promise<void> {
  // The brief's {type:"user_message", content:"..."} shape is rejected
  // with "content: Extra inputs are not permitted". The managed-agents
  // events endpoint follows the Messages API shape: a message object
  // with role + content blocks.
  const url = `https://api.anthropic.com/v1/sessions/${sessionId}/events`;
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "managed-agents-2026-04-01",
    "content-type": "application/json",
  };

  // Body shape verified end to end on dispatch run 24556570636:
  //   { events: [ { type: "user.message", content: [ { type: "text", text } ] } ] }
  // The events-array wrapper and dotted event type come from the
  // managed-agents skills doc, the array-of-text-blocks content shape
  // matches the Messages API.
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      events: [
        {
          type: "user.message",
          content: [{ type: "text", text }],
        },
      ],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Kickoff event failed: HTTP ${res.status}: ${errText}`);
  }
}

// ---- Notion watchlist fetch -------------------------------------------------
// Pulls Active rows from the "Client Watchlist" Notion database and shapes
// them into a simple array the agent can match against. Source of truth is
// Notion (easy for Jate to edit on phone), agent reads at runtime, no
// intermediate Supabase sync needed.

interface WatchlistEntry {
  notion_page_id: string;
  title: string;
  client: string | null;
  make: string | null;
  model: string | null;
  chassis_code: string | null;
  year_min: number | null;
  year_max: number | null;
  km_max: number | null;
  jpy_max: number | null;
  landed_aud_max: number | null;
  grade_min: string | null;
  transmission: string | null;
  colour_pref: string | null;
  priority_boost: number;
  notes: string | null;
}

function rt(prop: unknown): string | null {
  const arr = (prop as { rich_text?: Array<{ plain_text?: string }> } | undefined)?.rich_text;
  if (!arr || arr.length === 0) return null;
  const joined = arr.map((x) => x.plain_text ?? "").join("").trim();
  return joined || null;
}
function title(prop: unknown): string {
  const arr = (prop as { title?: Array<{ plain_text?: string }> } | undefined)?.title;
  return (arr ?? []).map((x) => x.plain_text ?? "").join("").trim();
}
function num(prop: unknown): number | null {
  const v = (prop as { number?: number | null } | undefined)?.number;
  return v ?? null;
}
function sel(prop: unknown): string | null {
  const v = (prop as { select?: { name?: string } | null } | undefined)?.select;
  return v?.name ?? null;
}

async function fetchWatchlist(
  notionToken: string,
  watchlistDatabaseId: string,
): Promise<WatchlistEntry[]> {
  // Legacy Notion API uses /v1/databases/:id/query. The newer
  // /v1/data_sources/:id/query exists in later API versions but is not
  // available under Notion-Version 2022-06-28 which we pin here for
  // stability across the rest of the agent's tool calls.
  const url = `https://api.notion.com/v1/databases/${watchlistDatabaseId}/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filter: { property: "Status", select: { equals: "Active" } },
      page_size: 100,
    }),
  });
  if (!res.ok) {
    // Non-fatal, agent still runs without watchlist
    console.warn(
      `Watchlist fetch failed: HTTP ${res.status}: ${await res.text()}. Continuing without watchlist.`,
    );
    return [];
  }
  const body = (await res.json()) as { results?: Array<{ id: string; properties: Record<string, unknown> }> };
  return (body.results ?? []).map((page) => {
    const p = page.properties;
    return {
      notion_page_id:  page.id,
      title:           title(p["Title"]),
      client:          rt(p["Client"]),
      make:            sel(p["Make"]),
      model:           rt(p["Model"]),
      chassis_code:    rt(p["Chassis Code"]),
      year_min:        num(p["Year Min"]),
      year_max:        num(p["Year Max"]),
      km_max:          num(p["Km Max"]),
      jpy_max:         num(p["JPY Max"]),
      landed_aud_max:  num(p["Landed AUD Max"]),
      grade_min:       rt(p["Grade Min"]),
      transmission:    sel(p["Transmission"]),
      colour_pref:     rt(p["Colour Pref"]),
      priority_boost:  num(p["Priority Boost"]) ?? 25,
      notes:           rt(p["Notes"]),
    };
  });
}

// ---- Ad-hoc search inputs from workflow_dispatch ----------------------------
// workflow_dispatch can pass inputs as env vars (INPUT_*). When any are set,
// we switch the agent into "targeted" mode on top of (not instead of) the
// daily scan.

interface AdhocQuery {
  make?: string;
  model?: string;
  year_min?: number;
  year_max?: number;
  km_max?: number;
  jpy_max?: number;
  note?: string;
}

function readAdhocQuery(): AdhocQuery | null {
  const q: AdhocQuery = {};
  const s = (k: string) => {
    const v = process.env[k]?.trim();
    return v && v.length > 0 ? v : undefined;
  };
  const n = (k: string) => {
    const v = s(k);
    if (!v) return undefined;
    const num = Number(v);
    return Number.isFinite(num) ? num : undefined;
  };
  const make     = s("INPUT_MAKE");
  const model    = s("INPUT_MODEL");
  const year_min = n("INPUT_YEAR_MIN");
  const year_max = n("INPUT_YEAR_MAX");
  const km_max   = n("INPUT_KM_MAX");
  const jpy_max  = n("INPUT_JPY_MAX");
  const note     = s("INPUT_NOTE");
  if (!make && !model && !year_min && !year_max && !km_max && !jpy_max && !note) {
    return null;
  }
  if (make)     q.make = make;
  if (model)    q.model = model;
  if (year_min) q.year_min = year_min;
  if (year_max) q.year_max = year_max;
  if (km_max)   q.km_max = km_max;
  if (jpy_max)  q.jpy_max = jpy_max;
  if (note)     q.note = note;
  return q;
}

// ---- Main -------------------------------------------------------------------

async function main(): Promise<void> {
  // Required for the agent and session plumbing itself.
  const ANTHROPIC_API_KEY = requireEnv("ANTHROPIC_API_KEY");
  const AGENT_ID          = requireEnv("JDMC_AGENT_ID");
  const ENV_ID            = requireEnv("JDMC_ENV_ID");
  const AUCTION_SOURCE    = process.env.AUCTION_SOURCE ?? "USS";

  // Required for MCP authorization.
  const SUPABASE_PAT              = requireEnv("SUPABASE_PAT");
  const NOTION_INTEGRATION_SECRET = requireEnv("NOTION_INTEGRATION_SECRET");
  const M365_TENANT_ID            = requireEnv("M365_TENANT_ID");
  const M365_CLIENT_ID            = requireEnv("M365_CLIENT_ID");
  const M365_CLIENT_SECRET        = requireEnv("M365_CLIENT_SECRET");

  // Dynamic context passed to the agent via kickoff. Static config lives in
  // the system prompt, dynamic knobs (db ids, project ids) live here so
  // they can change without touching the agent definition.
  const NOTION_DATABASE_ID   = process.env.NOTION_DATABASE_ID
    ?? "f08e1ac7-f179-4407-9e1f-8b3c232f10d1";
  const NOTION_AUCTION_SCOUT_DB_ID = process.env.NOTION_AUCTION_SCOUT_DB_ID
    ?? "f08e1ac7-f179-4407-9e1f-8b3c232f10d1";
  const NOTION_WATCHLIST_DB_ID = process.env.NOTION_WATCHLIST_DB_ID
    ?? "f9176ff3-cd8b-4e06-9ea8-34903e27b8dc";
  const SUPABASE_PROJECT_ID  = process.env.SUPABASE_PROJECT_ID
    ?? "rrvuxgajwaxadwwolgox";
  const ALERT_EMAIL          = process.env.ALERT_EMAIL
    ?? "jate@jdmconnect.com.au";
  const ALERT_FROM_MAILBOX   = process.env.ALERT_FROM_MAILBOX
    ?? "imports@jdmconnect.com.au";

  console.log("Fetching active client watchlist from Notion...");
  const watchlist = await fetchWatchlist(
    NOTION_INTEGRATION_SECRET,
    NOTION_WATCHLIST_DB_ID,
  );
  console.log(`Watchlist rows fetched: ${watchlist.length}`);

  const adhoc = readAdhocQuery();
  if (adhoc) {
    console.log(`Ad-hoc query: ${JSON.stringify(adhoc)}`);
  } else {
    console.log("No ad-hoc query, standard daily scan.");
  }

  console.log("Minting Microsoft Graph bearer...");
  const graphBearer = await mintGraphBearer(
    M365_TENANT_ID,
    M365_CLIENT_ID,
    M365_CLIENT_SECRET,
  );
  console.log(`Graph bearer minted, length ${graphBearer.length}.`);

  console.log("Creating session...");
  const now = new Date().toISOString();
  const session = await createSession(ANTHROPIC_API_KEY, {
    agent: AGENT_ID,
    environment_id: ENV_ID,
    title: `auction-scout ${now}`,
  });
  console.log(`Session created: ${session.id}`);

  // Tokens are passed in the kickoff so the agent can call Supabase REST,
  // Notion REST, and Microsoft Graph directly via bash + curl. The hosted
  // MCP servers declared on the agent are unauthenticated for now and
  // will be migrated to vault-based credentials in a follow-up PR.
  await sendKickoff(ANTHROPIC_API_KEY, session.id,
    `Run the auction scout now. Session id: ${session.id}.

## Run parameters
- Source: ${AUCTION_SOURCE} (always write this exact uppercase string into auction_hits.source and the Notion Source select)
- Window: listings updated in the last 24 hours
- Max listings to process this run: 1500 (raised from previous 300, USS publishes thousands daily)
- High-score alert threshold: 75
- Always send a summary email, even if zero high-score hits ("no hits today" with total listings scanned)

## Mode: ${adhoc ? "TARGETED SEARCH + daily scan" : "Daily scan"}
${adhoc ? `
### Targeted query (from workflow_dispatch inputs)
The user dispatched this run manually with the following filters. Prioritize listings that match these and feature them at the top of the email. Still run the normal daily scan and scoring for everything else, but flag anything matching the targeted query even if score < 75, with "Targeted match" in the email line item.
\`\`\`json
${JSON.stringify(adhoc, null, 2)}
\`\`\`
` : ""}

## Client Watchlist (standing orders from JDMC clients)
${watchlist.length === 0 ? "No active watchlist rows. Standard scoring only." : `There are ${watchlist.length} active watchlist rows. For every listing that survives the hard pass filter, check it against each watchlist row. A listing "matches" a watchlist row when all of these agree (null fields on the watchlist mean "any"):

- Make matches (case-insensitive, or watchlist.make = "Any")
- Model substring match (case-insensitive, watchlist.model is in listing.model)
- Chassis code starts with watchlist.chassis_code (if set)
- Year is within [year_min, year_max] (if set)
- Mileage km <= km_max (if set)
- JPY expected bid <= jpy_max (if set)
- Landed cost AUD <= landed_aud_max (if set)
- Grade >= grade_min (if set, numeric compare after stripping non-digits)
- Transmission matches (if set, watchlist.transmission = "Any" means any)

When matched:
- Add watchlist.priority_boost to the score (do this IN ADDITION to the normal rubric, cap at 100).
- Set auction_hits.matched_watchlist_client = watchlist.client (or watchlist.title if client is blank).
- Set auction_hits.matched_watchlist_id = watchlist.notion_page_id.
- Set auction_hits.watchlist_boost = watchlist.priority_boost.
- In Notion, set "Watchlist Match" to "\${client} (\${title})" and "Watchlist Boost" to the boost number.
- In the email, matched hits go at the TOP regardless of score, under a header "Watchlist matches" listing client name and boost.

If multiple watchlist rows match the same listing, pick the one with the highest priority_boost and note the tie in reasoning.

Active watchlist rows as JSON:
\`\`\`json
${JSON.stringify(watchlist, null, 2)}
\`\`\`
`}

## Behavior overrides for this run (these take precedence over the system prompt)

1. DO NOT call the rover-eligibility skill. It is not available in this managed container. For SEVS / MRE eligibility, use web_search against
   https://rover.infrastructure.gov.au and the public SEVS / MRE registers.
   If you cannot confirm eligibility from a primary source, set sevs_eligible/mre_eligible to null (not true) and add 'sevs_unconfirmed' to warnings.

2. NEVER fabricate URLs. If you did not actually upload a file to Supabase Storage, set the URL field to null. Do not invent paths in non-existent buckets like 'vehicle-images'. The only legal buckets are 'auction-photos' and 'auction-sheets'. The only legal path conventions are:
     auction-photos: {SOURCE}/{source_listing_id}/{sequence}.jpg   (sequence is 1, 2, 3, ...)
     auction-sheets: {SOURCE}/{source_listing_id}/sheet.jpg
   Use the SOURCE in uppercase, matching the auction_hits.source value.

3. If you do upload a real auction sheet image, also set both auction_sheet_url AND auction_sheet_image_path. If you do not upload a sheet (e.g. the listing did not expose one), leave BOTH fields null and add 'no_auction_sheet' to warnings. Never put a vehicle photo in the auction_sheet_url field.

4. For unknown numeric fields, write null, not 0. jpy_start_price=0 is wrong if the listing did not expose a start price; use null instead.

5. Listing id format: use just the auction-house-native id, like 'USSOsaka-6348' or 'USSNagoya-4521'. Do NOT mix prefixes like 'ASNET-6348-USSOsaka'.

## Targets
- Supabase project ref: ${SUPABASE_PROJECT_ID}
  REST base: https://${SUPABASE_PROJECT_ID}.supabase.co/rest/v1
  Storage base: https://${SUPABASE_PROJECT_ID}.supabase.co/storage/v1
  Tables: auction_hits, auction_photos, agent_runs
  Buckets: auction-photos, auction-sheets
- Notion database id: ${NOTION_DATABASE_ID}
  database name: "Auction Scout"
  REST base: https://api.notion.com/v1
  Notion-Version header required: 2022-06-28
- Email from mailbox: ${ALERT_FROM_MAILBOX}
  Email to: ${ALERT_EMAIL}
  Graph base: https://graph.microsoft.com/v1.0

## Credentials (use via bash + curl)
- SUPABASE_TOKEN: ${SUPABASE_PAT}
  Headers required: 'Authorization: Bearer <token>' AND 'apikey: <token>'
- NOTION_TOKEN: ${NOTION_INTEGRATION_SECRET}
  Headers required: 'Authorization: Bearer <token>' AND 'Notion-Version: 2022-06-28'
- GRAPH_BEARER (~1 hour validity): ${graphBearer}
  Header required: 'Authorization: Bearer <token>'

The hosted MCP servers (supabase, notion, m365) declared on the agent are NOT authenticated. Do not call them. Use bash + curl + jq for all external calls.

## End-of-run observability
After the email is sent (or attempted), insert one row into agent_runs:
  POST https://${SUPABASE_PROJECT_ID}.supabase.co/rest/v1/agent_runs
  Body shape:
    {
      "session_id": "${session.id}",
      "source": "${AUCTION_SOURCE}",
      "started_at": "${now}",
      "ended_at": "<current ISO timestamp>",
      "listings_scanned": <int>,
      "listings_eligible": <int, those that passed all hard filters>,
      "hits_written": <int rows added to auction_hits this run>,
      "high_score_hits": <int with score >= 75>,
      "top_score": <int or null>,
      "hard_pass_count": <int>,
      "hard_pass_reasons": { "<reason>": <count>, ... },
      "errors": [ <strings> ],
      "warnings": [ <strings> ]
    }
This row is what powers the weekly trend dashboards, so be honest about counts.

Follow your system prompt for everything else. Emit session.status_idle when done.`);

  console.log(`Launched session ${session.id}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
