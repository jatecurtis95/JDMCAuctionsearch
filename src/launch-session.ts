// ============================================================================
// src/launch-session.ts
// ----------------------------------------------------------------------------
// Daily session launcher for the jdmc-auction-scout Managed Agent.
// Brief ref: JDMC_Auction_Agent_Handover_Brief.md section 9.
//
// Creates a session against the pre-provisioned agent and environment,
// sends a single kickoff message, then exits. All the real work
// (scraping, translation, scoring, DB writes, email) happens inside the
// managed container, so this process does not need to stay alive.
//
// The beta header 'anthropic-beta: managed-agents-2026-04-01' is added
// automatically by the SDK, per brief section 1.
// ============================================================================

import Anthropic from "@anthropic-ai/sdk";

// The managed-agents-2026-04-01 beta API surface (client.sessions.*) is
// not yet exposed on the typed @anthropic-ai/sdk at the version pinned
// in package.json. We cast through a minimal local interface until the
// SDK types catch up. Shape matches brief section 9.
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

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

const ANTHROPIC_API_KEY = requireEnv("ANTHROPIC_API_KEY");
const AGENT_ID          = requireEnv("JDMC_AGENT_ID");
const ENV_ID            = requireEnv("JDMC_ENV_ID");
const AUCTION_SOURCE    = process.env.AUCTION_SOURCE ?? "USS";

const client = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
}) as unknown as ManagedAgentsClient;

async function main(): Promise<void> {
  const now = new Date().toISOString();

  const session = await client.sessions.create({
    agent: AGENT_ID,
    environment_id: ENV_ID,
    title: `auction-scout ${now}`,
  });

  // Kickoff message. Rules and scoring logic live in the agent system
  // prompt (agent/system-prompt.md), so this message only starts the run
  // and passes in the dynamic knobs.
  await client.sessions.events.create(session.id, {
    type: "user_message",
    content: `Run the auction scout now.

Source: ${AUCTION_SOURCE}
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

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
