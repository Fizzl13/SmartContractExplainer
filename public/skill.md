---
name: plaintext
description: Explain in plain language what a wallet's token approvals mean and which are risky, or what an approval, transaction or signature request really does. Paid via x402 or MPP.
---

# PlainText

Explains crypto permissions in plain language, for people. **Check a wallet's approvals** (which apps may spend which tokens, and which are risky) or **explain an approval, transaction or signature** before someone signs it. The verdicts come from presign-guard; PlainText adds the explanation a person can read.

Website: https://plaintext.fizzl.eu · Prices and schemas: https://plaintext.fizzl.eu/openapi.json

## Use it as an MCP server (simplest)

Add the remote MCP server `https://plaintext.fizzl.eu/mcp` (Streamable HTTP) to Claude, Cursor or another MCP client. In Claude Code: `claude mcp add --transport http plaintext https://plaintext.fizzl.eu/mcp`.

| Tool | Price | What it does |
|---|---|---|
| `check_wallet_approvals` | free, 20 MCP calls/hour | A wallet's approvals, explained, with the risky ones |
| `explain_approval` | free, shares the 20/hour | What an approval, transaction or signature does, in plain words |

The MCP tools are free, up to 20 calls an hour. For more, use the paid HTTP API below.

## Or call the HTTP API

| Endpoint | Price (USDC) | What it returns |
|---|---|---|
| `POST /api/check-wallet` | $0.04 | `{"address": "0x…", "chain": "base"}`: the approvals and their risk, explained (`chain`: ethereum, base, arbitrum, optimism, polygon, bsc, avalanche; default ethereum) |
| `POST /api/explain` | $0.03 | A plain-language verdict for an approval, transaction or signature payload |

Examples:

- "Is my wallet safe?": `POST https://plaintext.fizzl.eu/api/check-wallet` with `{"address": "0x…", "chain": "base"}` (max $0.05)
- Agents that only need the verdict and reason codes can use presign-guard directly ($0.01–$0.02): https://presign-guard.fizzl.eu/skill.md

## Free

- The MCP tools (20 calls an hour).
- The website https://plaintext.fizzl.eu has sample scenarios to try in the browser.

## Paying

Paid calls use **x402** (or MPP on the HTTP endpoints): the first request answers `402 Payment Required` with the price, your client pays in USDC and retries. You need one of:

- **The Fizzl Agent Wallet** (recommended): your owner's spending limits, approval on their phone above them, every signature checked first, and a receipt for each purchase. Set it up by following https://wallet.fizzl.eu/skill.md, then call these endpoints with `pay_x402`.
- **Any other x402 client** with its own wallet (for example `@x402/fetch`).
- **An MPP client** with its own wallet (for example `mppx` with `evm.charge` and USDC on Base): the HTTP endpoints also answer with an MPP challenge (`WWW-Authenticate: Payment`, method `evm`, USDC on Base); your client pays it and retries with `Authorization: Payment …`, and the answer carries a `Payment-Receipt`.

Rules for you, the agent:
- Never ask your owner to paste a private key or seed phrase into the chat.
- Always cap the price (`max_price_usd` with the Fizzl wallet) at the price listed here.
- Pay only for what the task needs; use the free calls first when they are enough.

## Feedback

Found a bug or missing something? `POST https://plaintext.fizzl.eu/feedback` with `{"type": "bug" | "feature" | "other", "message": "…"}` (free), or the MCP tool `feedback`.
