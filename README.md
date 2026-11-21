# Proof-Gated Payee — Aevum Builder Challenge #1

**Track:** Confirmation of Payee (DoraHacks) · **Chain:** Aevum testnet (44005) · **Token:** tUSD8 (`0x456569838f1d43009A91ebA4263147Afd7233483`, 6 decimals)

An autonomous agent verifies the payee **before** stablecoins move. A payer locks
tUSD8 into escrow against an invoice; funds only release to the payee when an
authorized verification agent calls `release()` after the on-chain gate passes:
payee is on the allowlist, the invoice is active and unexpired, and the release
fits the agent's spending limit for the current window. Every step emits an event,
so the full audit trail is visible on the explorer. If verification fails, the
funds stay safe in escrow and the payer can refund them.

This is the continuation of the **Proof Gatekeeper** concept (Agent Games zkVerify)
applied to tUSD8 payments. The contract was written fresh from
`DESIGN.md` — no starter-kit code was used as a base.

## The problem

Stablecoin payments today are blind to *who* receives them: one mistyped address,
one wrong party, one scammer wallet, and the funds are gone with no way back.
Autonomous AI agents that pay on their own (agentic commerce) make this worse —
an agent can be tricked by prompt injection or a fake address into paying the
wrong recipient. What is needed is a **machine-verifiable confirmation of payee**
before money moves — not just a manual check in a UI.

## How it works (5 steps)

1. **Invoice on-chain** — the payer calls `createInvoice(payee, amount,
   purposeHash, expiry)` and locks tUSD8 into escrow. `InvoiceCreated` is emitted.
2. **Agent verifies** — the off-chain verification agent checks the allowlist
   on-chain, amount + purpose hash against the invoice, expiry, and remaining
   spend cap (all readable via `verifyPayee()` / `canRelease()`).
3. **Proof-gated release** — only if every check passes, the agent (holding a
   scoped session key) calls `release()`. `PayeeVerified` + `Released` are emitted.
4. **Fail = funds safe** — unverified payee / amount mismatch / limit exceeded
   → `release()` reverts, funds stay in escrow.
5. **Refund** — the payer calls `refund()` once the invoice expired, the payee
   was revoked, or the invoice was cancelled. `Refunded` is emitted.

## Contract API

| Function | Who | What it does |
|---|---|---|
| `createInvoice(payee, amount, purposeHash, expiry)` | payer | Locks tUSD8 into escrow, issues an invoice id |
| `registerPayee(name, addr)` / `revokePayee(addr)` | owner | Allowlist / identity registry |
| `authorizeAgent(agent, allowed)` | owner | Grant/revoke a session key (release-only) |
| `setSpendingLimit(agent, cap, windowSeconds)` | owner | Spend cap per agent per window |
| `verifyPayee(invoiceId, agent)` (view) | anyone | Reports every gate condition |
| `canRelease(invoiceId, agent)` (view) | anyone | True only when all gates pass |
| `remainingSpend(agent)` (view) | anyone | tUSD8 the agent may still release this window |
| `release(invoiceId)` | authorized agent | Releases escrowed tUSD8 to the payee |
| `refund(invoiceId)` | payer | Takes funds back (expired / revoked / cancelled) |
| `cancelInvoice(invoiceId)` | payer | Cancels an unreleased invoice |

Events (audit trail): `InvoiceCreated`, `PayeeRegistered`, `PayeeRevoked`,
`AgentAuthorized`, `SpendingLimitSet`, `PayeeVerified`, `Released`, `Refunded`,
`InvoiceCancelled`.

## Safety model

- **Least privilege:** a session key can only `release()` verified invoices — it can
  never withdraw escrowed funds to an arbitrary address.
- **Spend caps:** per-agent cap per time window, with automatic window rollover.
  An agent with no cap set has cap 0 and cannot release anything.
- **Expiry:** every invoice carries an expiry; expired invoices cannot release.
- **No owner backdoor over funds:** the owner manages the registry, agents and
  limits only. Escrowed funds can only go to the invoice's payee (release) or
  back to its payer (refund).
- **Checks-Effects-Interactions** ordering throughout; custom errors (no
  revert strings).

## Setup

```bash
# Foundry (forge 1.10.0+)
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Build + test (local, no network needed)
forge build
forge test
```

## Deployed (Aevum testnet) — LIVE

- **Contract:** [`0xCFf720cCb87804a0027941066a5B216CaE0b2467`](https://explorer-test.qday.info/address/0xCFf720cCb87804a0027941066a5B216CaE0b2467)
- **Deploy tx:** [`0xac69d16933eb3744dfea907dff9e3aa2c8d25a67f68f655d6a5208e96427c2a1`](https://explorer-test.qday.info/tx/0xac69d16933eb3744dfea907dff9e3aa2c8d25a67f68f655d6a5208e96427c2a1) (block 3744539, 21 Nov 2026)
- **Owner:** Muse EOA `0x92eeE1BedeCfD2527c315aB31B08838D1dC215a8` · **Token:** tUSD8 (6 decimals)

```bash
# Dry run (simulation, no broadcast)
forge script script/Deploy.s.sol --rpc-url aevum

# Real deploy — only with an explicit order; NEVER commit a real key
PRIVATE_KEY=0x... forge script script/Deploy.s.sol --rpc-url aevum --broadcast
```

## Demo (testnet, LIVE — full log in [DEMO.md](DEMO.md))

Run it yourself (needs the deploy wallet key + tUSD8; the driver re-detects
on-chain progress and is safe to re-run):

```bash
node demo/run_demo.mjs   # full flow: setup → success → failure → refund
node demo/verify.mjs     # independent re-verification (receipts + state + balances)
node agent/verifier.mjs <invoiceId> [--execute]   # the agent alone
```

**What the live demo proved (21 Nov 2026, all txs on-chain):**

1. Setup: "Vendor Kopi" registered, agent session key authorized, spending
   limit 2 tUSD8 / 1 day.
2. SUCCESS: invoice #0 — 1 tUSD8 to Vendor Kopi. The agent verified all 5 gates
   (allowlist ✓, unexpired ✓, authorized ✓, within spend cap ✓, active ✓) and
   released; the vendor received exactly 1 tUSD8.
3. FAILURE: invoice #1 — 0.5 tUSD8 to an **unregistered** address. The agent
   DENIED the release (payeeRegistered FAIL), `release()` provably reverts with
   `PayeeNotRegistered()`, and the payer refunded in full — the stranger got 0.
4. Final balances: EOA 4 tUSD8 · vendor 1 tUSD8 · stranger 0 · escrow 0
   (all 5 faucet tUSD8 accounted for).

## Project layout

```
src/ProofGatedPayee.sol      main contract (fresh, from DESIGN.md)
test/ProofGatedPayee.t.sol   Foundry tests + MockTUSD8 (6 decimals)
script/Deploy.s.sol          deploy script (Aevum testnet, chain 44005)
agent/verifier.mjs           off-chain verification agent (Node + ethers v6)
agent/agent-key.json         testnet-only session key (chmod 600, NOT in git)
demo/run_demo.mjs            end-to-end CLI demo (live on testnet, re-runnable)
demo/verify.mjs              independent verification (receipts + state + balances)
demo/demo-results.json       machine-readable demo record (tx hashes, blocks, balances)
DEMO.md                      full demo log with explorer links
web/                         minimal web UI (static, live on-chain state + gate verdicts + write actions)
pitch-deck/                  pitch deck (HTML slides + PDF)
video/proof-gated-payee-demo.mp4   demo video, 150 s (no audio, captioned)
foundry.toml                 solc 0.8.24, EVM Shanghai, rpc endpoint `aevum`
```

## Status

- [x] Contract + full test suite (local, all passing — 23/23)
- [x] Deploy to Aevum testnet — [`0xCFf720cCb87804a0027941066a5B216CaE0b2467`](https://explorer-test.qday.info/address/0xCFf720cCb87804a0027941066a5B216CaE0b2467)
- [x] Verification agent (off-chain) + CLI demo end-to-end — LIVE, both paths proven ([DEMO.md](DEMO.md))
- [x] Minimal web UI — [`web/`](web/) (live state, 5-step flow, gate verdicts, wallet writes)
- [x] Pitch deck + demo video (150 s) — [`pitch-deck/`](pitch-deck/) + [`video/proof-gated-payee-demo.mp4`](video/proof-gated-payee-demo.mp4)
- [ ] Submit Build on DoraHacks before **11 Dec 2026 15:00 WIB**

## License

MIT — see `LICENSE`.
