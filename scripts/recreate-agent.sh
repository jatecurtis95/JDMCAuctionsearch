#!/usr/bin/env bash
# ============================================================================
# scripts/recreate-agent.sh
# ----------------------------------------------------------------------------
# Recreate the jdmc-auction-scout Claude Managed Agent with the current
# agent/system-prompt.md content, then archive the previous one.
#
# Use this when:
#   * the system prompt has changed and you want it baked into the agent
#     (so the launcher kickoff can shed its behavioral overrides),
#   * the tools or mcp_servers list has changed,
#   * the model has changed.
#
# What it does NOT do:
#   * update the JDMC_AGENT_ID GitHub secret automatically. After this
#     prints the new id, you must update the secret yourself (Settings >
#     Secrets and variables > Actions > JDMC_AGENT_ID) so the cron starts
#     using the new agent.
#
# Usage:
#   export ANTHROPIC_API_KEY=sk-ant-...
#   export OLD_JDMC_AGENT_ID=agent_011Ca8w8...   # optional, archives the old one
#   ./scripts/recreate-agent.sh
# ============================================================================

set -euo pipefail

: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"

command -v curl >/dev/null 2>&1 || { echo "ERROR: curl is required" >&2; exit 1; }
command -v jq   >/dev/null 2>&1 || { echo "ERROR: jq is required"   >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SYSTEM_PROMPT_FILE="$REPO_ROOT/agent/system-prompt.md"

if [[ ! -f "$SYSTEM_PROMPT_FILE" ]]; then
  echo "ERROR: system prompt not found at $SYSTEM_PROMPT_FILE" >&2
  exit 1
fi

echo "Creating new jdmc-auction-scout agent with current system-prompt.md..."

BODY=$(jq -n \
  --rawfile sys "$SYSTEM_PROMPT_FILE" \
  '{
    name: "jdmc-auction-scout",
    model: "claude-sonnet-4-6",
    system: $sys,
    tools: [
      { type: "agent_toolset_20260401" },
      { type: "mcp_toolset", mcp_server_name: "supabase" },
      { type: "mcp_toolset", mcp_server_name: "notion"   },
      { type: "mcp_toolset", mcp_server_name: "m365"     }
    ],
    mcp_servers: [
      { type: "url", url: "https://mcp.supabase.com/mcp",            name: "supabase" },
      { type: "url", url: "https://mcp.notion.com/mcp",              name: "notion"   },
      { type: "url", url: "https://microsoft365.mcp.claude.com/mcp", name: "m365"     }
    ]
  }')

RESPONSE=$(curl -sS --fail-with-body \
  https://api.anthropic.com/v1/agents \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: managed-agents-2026-04-01" \
  -H "content-type: application/json" \
  -d "$BODY")

NEW_AGENT_ID=$(printf '%s' "$RESPONSE" | jq -r '.id // empty')

if [[ -z "$NEW_AGENT_ID" ]]; then
  echo "ERROR: no agent id in response:" >&2
  printf '%s\n' "$RESPONSE" >&2
  exit 1
fi

echo "New agent created."
echo "  name: jdmc-auction-scout"
echo "  id:   $NEW_AGENT_ID"

if [[ -n "${OLD_JDMC_AGENT_ID:-}" && "$OLD_JDMC_AGENT_ID" != "$NEW_AGENT_ID" ]]; then
  echo
  echo "Archiving previous agent $OLD_JDMC_AGENT_ID..."
  ARCHIVE_HTTP=$(curl -sS -o /tmp/recreate-archive -w "%{http_code}" \
    -X POST "https://api.anthropic.com/v1/agents/$OLD_JDMC_AGENT_ID/archive" \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "anthropic-beta: managed-agents-2026-04-01")
  echo "  archive HTTP $ARCHIVE_HTTP (200 = ok)"
fi

echo
echo "Next steps:"
echo "  1. Update the JDMC_AGENT_ID GitHub Actions secret to: $NEW_AGENT_ID"
echo "       gh secret set JDMC_AGENT_ID --body $NEW_AGENT_ID"
echo "     or via UI at Settings > Secrets and variables > Actions"
echo "  2. Once updated, the daily cron will use the new agent on next fire."
echo "  3. The kickoff overrides in src/launch-session.ts can then be"
echo "     trimmed since the new system prompt covers them."
