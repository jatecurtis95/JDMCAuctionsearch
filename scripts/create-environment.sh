#!/usr/bin/env bash
# ============================================================================
# scripts/create-environment.sh
# ----------------------------------------------------------------------------
# Creates the jdmc-auction-scout-env Claude Managed Agent environment.
# Brief ref: JDMC_Auction_Agent_Handover_Brief.md section 8.
#
# Usage:
#   export ANTHROPIC_API_KEY=sk-ant-...
#   ./scripts/create-environment.sh
#
# On success prints the environment id. Save it as JDMC_ENV_ID in your
# shell env and as a GitHub Actions repo secret.
#
# Networking is set to 'unrestricted' because the managed container needs
# to reach:
#   * the auction source (USS, TAA, or ASNET)
#   * Supabase (rest + storage + mcp)
#   * Notion MCP
#   * Microsoft 365 MCP (Graph send-mail)
# If the auction source becomes IP sensitive later, narrow this to an
# allowlist.
# ============================================================================

set -euo pipefail

: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"

command -v curl >/dev/null 2>&1 || { echo "ERROR: curl is required" >&2; exit 1; }
command -v jq   >/dev/null 2>&1 || { echo "ERROR: jq is required"   >&2; exit 1; }

RESPONSE=$(curl -sS --fail-with-body \
  https://api.anthropic.com/v1/environments \
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
)

ENV_ID=$(printf '%s' "$RESPONSE" | jq -r '.id // empty')

if [[ -z "$ENV_ID" ]]; then
  echo "ERROR: no environment id in response:" >&2
  printf '%s\n' "$RESPONSE" >&2
  exit 1
fi

echo "Environment created."
echo "  name: jdmc-auction-scout-env"
echo "  id:   $ENV_ID"
echo
echo "Next steps:"
echo "  export JDMC_ENV_ID=$ENV_ID"
echo "  gh secret set JDMC_ENV_ID --body $ENV_ID"
