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

import Anthropic from "@anthropic-ai/sdk";

// ---- Types ------------------------------------------------------------------

interface ManagedAgentSession {
  id: string;
}
interface ManagedAgentsClient {
  sessions: {
    create(params: {
      agent: string;
      environment_id: string;
      title?: string;
    }): Promise<ManagedAgentSession>;
    events: {
      create(
        sessionId: string,
        body: { type: "user_message"; content: string },
      ): Promise<unknown>;
    };
  };
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

// ---- Anthropic agent update (raw fetch, SDK does not yet cover this) --------

async function updateAgentMcpServers(
  apiKey: string,
  agentId: string,
  mcpServers: McpServer[],
): Promise<void> {
  const url = `https://api.anthropic.com/v1/agents/${agentId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "managed-agents-2026-04-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ mcp_servers: mcpServers }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Agent mcp_servers update failed: HTTP ${res.status}: ${errText}`,
    );
  }
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
  const SUPABASE_PROJECT_ID  = process.env.SUPABASE_PROJECT_ID
    ?? "rrvuxgajwaxadwwolgox";
  const ALERT_EMAIL          = process.env.ALERT_EMAIL
    ?? "jate@jdmconnect.com.au";
  const ALERT_FROM_MAILBOX   = process.env.ALERT_FROM_MAILBOX
    ?? "imports@jdmconnect.com.au";

  console.log("Minting Microsoft Graph bearer...");
  const graphBearer = await mintGraphBearer(
    M365_TENANT_ID,
    M365_CLIENT_ID,
    M365_CLIENT_SECRET,
  );
  console.log(`Graph bearer minted, length ${graphBearer.length}.`);

  console.log("Updating agent mcp_servers with fresh authorization tokens...");
  await updateAgentMcpServers(ANTHROPIC_API_KEY, AGENT_ID, [
    {
      type: "url",
      url: "https://mcp.supabase.com/mcp",
      name: "supabase",
      authorization_token: SUPABASE_PAT,
    },
    {
      type: "url",
      url: "https://mcp.notion.com/mcp",
      name: "notion",
      authorization_token: NOTION_INTEGRATION_SECRET,
    },
    {
      type: "url",
      url: "https://microsoft365.mcp.claude.com/mcp",
      name: "m365",
      authorization_token: graphBearer,
    },
  ]);
  console.log("Agent mcp_servers updated.");

  // Session create and kickoff
  const client = new Anthropic({
    apiKey: ANTHROPIC_API_KEY,
  }) as unknown as ManagedAgentsClient;

  const now = new Date().toISOString();
  const session = await client.sessions.create({
    agent: AGENT_ID,
    environment_id: ENV_ID,
    title: `auction-scout ${now}`,
  });

  await client.sessions.events.create(session.id, {
    type: "user_message",
    content: `Run the auction scout now.

Source: ${AUCTION_SOURCE}
Window: listings updated in the last 24 hours.
Max listings to process this run: 300.
High-score alert threshold: 75.
Always send a summary email, even if zero high-score hits (report "no hits today" with total listings scanned).

Targets:
- Supabase project id: ${SUPABASE_PROJECT_ID}
  tables: auction_hits, auction_photos
  storage buckets: auction-photos, auction-sheets
- Notion database id: ${NOTION_DATABASE_ID}
  database name: "Auction Scout"
- Email from mailbox: ${ALERT_FROM_MAILBOX}
  Email to: ${ALERT_EMAIL}

MCP authorization:
- supabase, notion, m365 MCP servers are authorized on this session via
  authorization_token on each mcp_server entry. You do not need to pass
  tokens yourself, the MCP layer handles it.

Follow your system prompt. Emit session.status_idle when done.`,
  });

  console.log(`Launched session ${session.id}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
