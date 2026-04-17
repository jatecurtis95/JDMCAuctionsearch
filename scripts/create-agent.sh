#!/usr/bin/env bash
# ============================================================================
# scripts/create-agent.sh
# ----------------------------------------------------------------------------
# Creates the jdmc-auction-scout Claude Managed Agent.
# Brief ref: JDMC_Auction_Agent_Handover_Brief.md sections 6 and 7.
#
# Usage:
#   export ANTHROPIC_API_KEY=sk-ant-...
#   ./scripts/create-agent.sh
#
# On success prints the agent id. Save it as JDMC_AGENT_ID in your shell
# env and as a GitHub Actions repo secret so the launcher workflow can use
# it.
#
# This script is idempotent in the trivial sense that it will always try
# to create a new agent. If you rerun it you will get a second agent with
# the same name but a different id. Use list / update endpoints if you
# need to mutate an existing agent.
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

# Note: the brief section 6 shows a tools array of
#   [{type:"bash"},{type:"file"},{type:"web_search"}]
# but the real managed-agents-2026-04-01 API rejects that shape with
#   tools[0].type: "bash" is not a valid value; expected one of
#   agent_toolset_20260401, custom, mcp_toolset
# The equivalent working shape is the Anthropic-hosted agent_toolset
# (which bundles bash, file, web_search, and friends) plus one
# mcp_toolset entry per declared mcp_server, referenced by name.
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

AGENT_ID=$(printf '%s' "$RESPONSE" | jq -r '.id // empty')

if [[ -z "$AGENT_ID" ]]; then
  echo "ERROR: no agent id in response:" >&2
  printf '%s\n' "$RESPONSE" >&2
  exit 1
fi

echo "Agent created."
echo "  name: jdmc-auction-scout"
echo "  id:   $AGENT_ID"
echo
echo "Next steps:"
echo "  export JDMC_AGENT_ID=$AGENT_ID"
echo "  gh secret set JDMC_AGENT_ID --body $AGENT_ID"
