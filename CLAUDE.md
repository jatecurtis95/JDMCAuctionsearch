# CLAUDE.md

## Resume here (open issue, blocking first run)

The launcher creates a session successfully but cannot send the kickoff event. Six dispatched runs as of 2026-04-17 evening confirm:

- `POST /v1/sessions` accepts `{agent, environment_id, title}`. Inline `mcp_servers` is rejected (`Extra inputs are not permitted`).
- `POST /v1/sessions/:id/events` rejects every body shape probed: `{type:"user_message", content}` (the brief's shape), `{type, message:{role,content[]}}`, `{type, message:{role,content}}`, `{type, text}`, `{type, input}`, `{type, body}`, `{type, value}`, `{type:"message", role, content}`, `{input:{role,content}}`. All return HTTP 400 with "X: Extra inputs are not permitted".
- `POST /v1/sessions/:id/messages` returns HTTP 404 (path does not exist).
- `PATCH /v1/agents/:id` returns HTTP 404, the agent is immutable post-create. MCP auth flows through vaults instead per [docs](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/managed-agents-overview.md).

To resume: open `node_modules/@anthropic-ai/sdk/` and find the `sessions.events.create` (or equivalent) implementation, or check the official Anthropic API reference in the Console. Once the correct body shape is known, replace the stub in `sendKickoff` in `src/launch-session.ts` and uncomment the schedule block in `.github/workflows/auction-scout.yml`.

Once the kickoff works, the next architectural cleanup is to migrate the three credentials (Supabase PAT, Notion integration secret, Microsoft Graph) from the kickoff-message smuggle pattern to the proper Anthropic vault pattern (`POST /v1/vaults`, `POST /v1/vaults/:id/credentials`, attach via `vault_ids` on session create). That re-enables the hosted MCP tools so the agent can use `supabase_query` / `notion_append_block` / `m365_send_mail` instead of bash + curl.



Context and rules for any Claude session (Claude Code, Cursor, Cowork) working on this repo.

## Project

**jdmc-auction-scout** is an autonomous auction monitoring agent built on Anthropic Managed Agents. It runs once daily at 09:00 AWST, pulls the previous 24 hours of Japanese car auction listings from one configured source, translates each auction sheet, checks SEVS and MRE eligibility, estimates landed cost and margin, scores the opportunity, and writes qualified hits to Supabase and a Notion "Auction Scout" database. A summary email goes to `jate@jdmconnect.com.au` via Microsoft 365.

## Owner

Jate Curtis, JDM Connect Pty Ltd (Perth, WA).
Contact: `jate@jdmconnect.com.au`.
Also operates Teefinder, which is unrelated to this repo.

## Source of truth

The canonical spec is [`JDMC_Auction_Agent_Handover_Brief.md`](./JDMC_Auction_Agent_Handover_Brief.md) at repo root. When in doubt, read the brief. Section references used in commits and file headers point back into it:

- Section 4: Supabase schema, see `supabase/migrations/20260417_auction_scout.sql`
- Section 6: agent definition, see `scripts/create-agent.sh`
- Section 7: agent system prompt, see `agent/system-prompt.md`
- Section 8: environment config, see `scripts/create-environment.sh`
- Section 9: session launcher and cron workflow, see `src/launch-session.ts` and `.github/workflows/auction-scout.yml`
- Section 14: handover checklist, the out of band console items tracked in the scaffolding PR

Do not paraphrase the brief into other files. If something needs to change, change the brief first, then the code, in that order.

## House rules

1. **No em dashes anywhere.** Not in code, comments, commit messages, PR descriptions, email copy, agent outputs, or chat replies. Use commas, colons, parentheses, or split the sentence. This applies to U+2014 (em) and U+2013 (en). Hyphen-minus (`-`) is fine. A quick scan before commit: `grep -RnP "[\x{2013}\x{2014}]" .`.
2. **No secrets in the repo.** All credentials live in env vars or GitHub Actions secrets. `.gitignore` excludes `.env`, `.env.*` (except `.env.example`), and the session-local `.gh_pat` stash. If you see a token in a diff, stop and rewrite.
3. **One task per turn, push as you go.** Long multi-task sessions have timed out in the past. Commit and push after each logical chunk. Prefer new commits over amends.
4. **Idempotency first.** The unique constraint `auction_hits(source, source_listing_id)` is the dedup anchor. The agent upserts, never blind-inserts. Migrations use `if not exists`. Re-running scripts should not create dupes.
5. **Ask before architectural changes.** Swapping the auction source, changing the scoring rubric, adding v2 features from brief section 13, or replacing an MCP server all require sign-off from Jate first.

## Repo layout

```
.
  JDMC_Auction_Agent_Handover_Brief.md   canonical spec
  CLAUDE.md                              this file
  README.md                              human-facing overview
  agent/
    system-prompt.md                     verbatim from brief section 7
  scripts/
    create-agent.sh                      POST /v1/agents, run once
    create-environment.sh                POST /v1/environments, run once
  src/
    launch-session.ts                    runs on the cron
  supabase/
    migrations/
      20260417_auction_scout.sql         auction_hits, auction_photos, buckets
  .github/
    workflows/
      auction-scout.yml                  daily cron launcher
  package.json, package-lock.json, tsconfig.json, .gitignore
```

## Out of band console steps

These are intentionally not automated. The scripts that exist are one-shot helpers, they are not invoked by CI.

1. Create the Supabase project (or run the migration against existing `jdm-connect`).
2. Create the Notion "Auction Scout" database with the properties listed in brief section 5, and connect the `jdmc-auction-scout` Notion integration to it (`...` menu > Connections > Add).
3. Create the M365 Graph API app registration for the `imports@jdmconnect.com.au` mailbox. Application permission: `Mail.Send`. Tenant admin consent required. Apply an `ApplicationAccessPolicy` scoped to `imports@` so the client secret cannot be used to send as any other mailbox.
4. Run `./scripts/create-agent.sh` once, save the returned id as `JDMC_AGENT_ID`.
5. Run `./scripts/create-environment.sh` once, save the returned id as `JDMC_ENV_ID`.
6. Generate a Supabase Personal Access Token at `https://supabase.com/dashboard/account/tokens` (never expires).
7. Generate a Notion Internal Integration Secret at `https://www.notion.so/profile/integrations`.
8. Set all GitHub Actions secrets.

Full checklist in brief section 14.

## GitHub Actions secrets

Required for the cron to run. All are set at `Settings > Secrets and variables > Actions`.

Plumbing:
- `ANTHROPIC_API_KEY` Anthropic Console API key.
- `JDMC_AGENT_ID` returned by `scripts/create-agent.sh`.
- `JDMC_ENV_ID` returned by `scripts/create-environment.sh`.

MCP authorization tokens, read by `src/launch-session.ts` and stamped into the agent's `mcp_servers` list on each run:
- `SUPABASE_PAT` Supabase Personal Access Token, starts with `sbp_`.
- `NOTION_INTEGRATION_SECRET` Notion internal integration secret, starts with `ntn_`.
- `M365_TENANT_ID` Directory (tenant) UUID from the Azure app registration.
- `M365_CLIENT_ID` Application (client) UUID from the Azure app registration.
- `M365_CLIENT_SECRET` the Value field (not the Secret ID) from Certificates & secrets. The launcher exchanges this for a fresh Graph bearer at each run.

Optional (launcher has safe defaults wired to the currently-provisioned resources):
- `NOTION_DATABASE_ID` Auction Scout database UUID (default: `f08e1ac7-f179-4407-9e1f-8b3c232f10d1`).
- `SUPABASE_PROJECT_ID` Supabase project ref (default: `rrvuxgajwaxadwwolgox`).
- `ALERT_EMAIL` where summary emails go (default: `jate@jdmconnect.com.au`).
- `ALERT_FROM_MAILBOX` from address for summary emails (default: `imports@jdmconnect.com.au`).

Rotation is a secret change, not an agent recreate. The launcher repatches `mcp_servers` every run.

## Local development

```
npm ci             # install pinned deps
npm run typecheck  # strict tsc --noEmit
npm run launch     # invoke the launcher locally, requires env
```

The launcher needs `ANTHROPIC_API_KEY`, `JDMC_AGENT_ID`, `JDMC_ENV_ID`, optionally `AUCTION_SOURCE` (defaults to `USS`).

## Commit conventions

Conventional commits, concise subject under ~70 chars, body explains the why. Examples in the current git log:

```
docs: add JDMC Auction Agent handover brief
feat(db): add auction_hits and auction_photos migration
feat(agent): add agent and environment creation scripts
feat(launcher): add TypeScript session launcher
ci: add auction-scout daily workflow
```

Scopes in use: `db`, `agent`, `launcher`, `ci`, `docs`. Keep them stable.

## What not to do

- Do not hardcode an auction source credential, API key, or tenant id.
- Do not relax the `(source, source_listing_id)` unique constraint.
- Do not add multi-source scraping in v1 (brief section 13 is explicit).
- Do not add automated bidding. Ever. Human in the loop is a product requirement, not an implementation detail.
- Do not resize, recompress, or filter auction photos on the agent side. Store what the source exposes.
- Do not promise "HD" photos in any output copy. The auction sources only expose roughly 1000px images.
- Do not send email if the Supabase write failed. Order matters: Supabase, then Notion, then email.
