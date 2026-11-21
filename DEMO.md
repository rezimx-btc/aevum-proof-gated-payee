# Demo end-to-end — Proof-Gated Payee (LIVE, Aevum testnet)

**Run:** 21 Nov 2026 ~18:49–18:52 WIB · **Chain:** Aevum testnet (44005) · **RPC:** https://rpc-test.qday.info
**Contract:** [`0xCFf720cCb87804a0027941066a5B216CaE0b2467`](https://explorer-test.qday.info/address/0xCFf720cCb87804a0027941066a5B216CaE0b2467)
**Deploy tx:** [`0xac69d16933eb3744dfea907dff9e3aa2c8d25a67f68f655d6a5208e96427c2a1`](https://explorer-test.qday.info/tx/0xac69d16933eb3744dfea907dff9e3aa2c8d25a67f68f655d6a5208e96427c2a1) (block 3744539)
**Token:** tUSD8 `0x456569838f1d43009A91ebA4263147Afd7233483` (6 decimals)
**Payer / owner:** Muse EOA `0x92eeE1BedeCfD2527c315aB31B08838D1dC215a8`
**Agent (session key):** `0x9caCbAaf1d71C5640982Bd4216Ee9FcA11dC91E2` — fresh testnet-only key, `agent/agent-key.json` (chmod 600). It can ONLY call `release()` on verified invoices; it cannot withdraw escrowed funds anywhere else.
**Vendor ("Vendor Kopi"):** `0x3Eb09d7A08ACD5dEbC1F0b5ee83a1a344890632F` (user's payout wallet — the released testnet tUSD8 lands in the user's own wallet)
**Stranger (unregistered):** `0x1111111111111111111111111111111111111111`

All 11 transactions were independently re-verified after the run (receipt status `0x1`, on-chain state, balances) with `demo/verify.mjs`. Machine-readable record: `demo/demo-results.json`.

## Commands

```bash
# from the project root (forge + node; ethers is a project dependency)
node demo/run_demo.mjs        # full flow, live on testnet (safe to re-run: it
                              # detects on-chain progress and skips finished steps)
node demo/verify.mjs          # independent re-verification (receipts + state + balances)

# the agent alone (verdict only, or verdict + release):
node agent/verifier.mjs <invoiceId> [--execute]
```

## Flow — what happened, step by step

### 0. Preflight

| Check | Result |
|---|---|
| chainId | 44005 (Aevum testnet) |
| contract bytecode | present (6,411 bytes) |
| owner | == Muse EOA |
| token | == tUSD8 |
| nextInvoiceId | 0 |
| Balances BEFORE | EOA 0.999999999988 tQDAY / 5.000000 tUSD8 · vendor 0 · stranger 0 · escrow 0 |

### 1. Setup (owner calls)

| Step | Tx | Block |
|---|---|---|
| Fund agent 0.001 tQDAY (gas for release) | [`0x248acae5…907ddc2a`](https://explorer-test.qday.info/tx/0x248acae56b4aa8ef67bea7b342ff7d3a1a5eb6cde892b919257bfb3d907ddc2a) | 3744958 |
| Fund agent 0.001 tQDAY again (2nd driver run) | [`0x6a610c6e…4f13c3`](https://explorer-test.qday.info/tx/0x6a610c6e53bc24bd5240f7a2b7a99989ba2aa469dd72fd45105d0227cf4f13c3) | 3744996 |
| `registerPayee("Vendor Kopi", 0x3Eb0…632F)` | [`0x1eb14d8b…991c41`](https://explorer-test.qday.info/tx/0x1eb14d8ba07c1e0213c62bed60781fe345b662e5059ff39a4e5e0293f6991c41) | 3745000 |
| `authorizeAgent(agent, true)` | [`0x0b77f210…c71cc2`](https://explorer-test.qday.info/tx/0x0b77f210120a26d71853dc802f205c2043811c2e40a93d54b1116d777dc71cc2) | 3745007 |
| `setSpendingLimit(agent, 2 tUSD8 / 1 day)` | [`0x6fc006dc…869174`](https://explorer-test.qday.info/tx/0x6fc006dc0c05a9939813cbbb2d6e273355d92dca198a075c9af2e7b3a7869174) | 3745014 |

After setup: `remainingSpend(agent)` = 2.000000 tUSD8.

### 2. SUCCESS — invoice 1 tUSD8 to Vendor Kopi

| Step | Tx | Block |
|---|---|---|
| `approve(contract, 1 tUSD8)` | [`0x84e61d51…aa5447`](https://explorer-test.qday.info/tx/0x84e61d513018b53c42556bcdf7d554e456930e98833a257cc911e4586caa5447) | 3745022 |
| `createInvoice(vendor, 1 tUSD8, keccak("kopi-001"), expiry +1h)` → invoice **#0** | [`0x57e1141d…1c8b97d`](https://explorer-test.qday.info/tx/0x57e1141d0856c2f5d53e84f5580ef1b0b0f9a0931f1bcb38b540c1f4e1c8b97d) | 3745029 |

After escrow: EOA 4.000000 tUSD8 · escrow 1.000000 · vendor 0.

### 3. Agent verifies invoice #0 and releases

```
$ node agent/verifier.mjs 0 --execute
  [PASS] payeeRegistered — payee 0x3Eb0…632F registered=true (name: "Vendor Kopi")
  [PASS] notExpired — expiry 1795265498
  [PASS] agentAuthorized — agent 0x9caC…91E2 authorized=true
  [PASS] withinSpendLimit — amount 1000000 vs remaining 2000000
  [PASS] active — status 0 (Created)
  VERDICT: APPROVED — release is safe
  release() sent: 0x70617e01…808892
  release() confirmed in block 3745041 — events: PayeeVerified, Released
```

| Step | Tx | Block |
|---|---|---|
| `release(0)` (signed by the agent session key) | [`0x70617e01…808892`](https://explorer-test.qday.info/tx/0x70617e01cd45ec9f2e33835ca10524c68758854684f8a7b6e8545a4db9808892) | 3745041 |

After release: invoice #0 status = **Released** · vendor **1.000000 tUSD8** · escrow 0.

### 4. FAILURE — invoice 0.5 tUSD8 to an UNREGISTERED address

| Step | Tx | Block |
|---|---|---|
| `approve(contract, 0.5 tUSD8)` | [`0xcedea17e…33aa4a`](https://explorer-test.qday.info/tx/0xcedea17e28f610311c6df6236fd4fe054ae4d773269c090e6ff4e77b9e33aa4a) | 3745118 |
| `createInvoice(0x1111…1111, 0.5 tUSD8, keccak("unknown-001"), expiry +1h)` → invoice **#1** | [`0x21d0a070…9937b5`](https://explorer-test.qday.info/tx/0x21d0a070f1e6f4c2ce0dac387e4de382fce3b16a5bb64ddbd6910213f99937b5) | 3745125 |

### 5. Agent verifies invoice #1 — DENIED

```
$ node agent/verifier.mjs 1
  [FAIL] payeeRegistered — payee 0x1111…1111 registered=false (name: "(none)")
  [PASS] notExpired
  [PASS] agentAuthorized
  [PASS] withinSpendLimit — amount 500000 vs remaining 1000000
  [PASS] active
  VERDICT: DENIED — release refused
```

The agent attempted **no** release (exit code 2).

### 6. Proof that release() reverts (static call, no gas spent)

```
release() reverted as expected: PayeeNotRegistered()
```

### 7. Payer refunds invoice #1 in full

| Step | Tx | Block |
|---|---|---|
| `refund(1)` — `Refunded` event: payer 0x92ee…15a8, amount 0.500000 tUSD8 | [`0xfa78093b…fae2dc`](https://explorer-test.qday.info/tx/0xfa78093b1e469549e433943ce72ffdeeaa85bb75058bc5d5920c513a82fae2dc) | 3745135 |

After refund: invoice #1 status = **Refunded** · stranger **0** tUSD8.

### 8. Final balances (independently verified)

| Holder | tUSD8 | tQDAY |
|---|---|---|
| EOA (payer/owner) | 4.000000 | 0.997025490788 |
| Vendor Kopi (user wallet) | 1.000000 | — |
| Stranger | 0.000000 | — |
| Escrow (contract) | 0.000000 | — |
| Agent (session key) | — | 0.0018665108 |

**Conservation:** EOA 4 + vendor 1 = 5.000000 tUSD8 — all 5 faucet tUSD8 accounted for.
Contract state after the demo: `nextInvoiceId` = 2 · agent spend limit cap 2,000,000, spent 1,000,000, remaining 1,000,000 · `canRelease(#0)` = false (already released) · `canRelease(#1)` = false (refunded).

## Notes for the judges / re-running

- The demo is deterministic and re-runnable: `node demo/run_demo.mjs` detects
  on-chain progress (registered payee, authorized agent, released/refunded
  invoices) and skips finished steps, recovering their tx hashes from the
  contract's event log. A fresh run after this one would create new invoices
  (#2, #3, …) with the same two paths.
- Total gas cost of the whole demo: ~0.003 tQDAY (testnet gas ~1.2 gwei).
- The first driver run stopped early on a driver-side bug (`receipt.status`
  compared as bigint in ethers v6 — the tx itself had succeeded on-chain);
  the bug was fixed and the second run resumed from on-chain state.
  Both funding txs are listed above; nothing was lost.
- Keys: the EOA key stays only in `~/workspace/muse-wallet/eoa-wallet.json`
  (chmod 600, never in the repo); the agent session key is in
  `agent/agent-key.json` (chmod 600, testnet-only). Neither is printed by any
  script in this repo.
