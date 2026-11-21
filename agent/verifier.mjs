// verifier.mjs — off-chain verification agent for ProofGatedPayee (Aevum testnet).
//
// The agent is the AI component of the entry: it reads the on-chain gate for an
// invoice (allowlist + expiry + session key + spending limit + active status),
// DECIDES whether the release is safe, and only then signs release() with its
// least-privilege session key. A denied invoice is never released by this agent.
//
// Usage:
//   node verifier.mjs <invoiceId> [--execute] [--json]
//   --execute : when the verdict is APPROVED, actually send release().
//               Without it, the agent only reports the verdict (dry run).
//   --json    : print the verdict as a single JSON object (for the demo driver).
//
// Exit codes: 0 = APPROVED (and released, if --execute)
//             2 = DENIED (one or more gates failed — no release attempted)
//             1 = error (invoice not found, RPC failure, tx failure, ...)
// The agent private key is read from ./agent-key.json (chmod 600, testnet only)
// and is never printed or written anywhere else.

import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.AEVUM_RPC_URL ?? "https://rpc-test.qday.info";
const CONTRACT = process.env.PGP_ADDRESS ?? "0xCFf720cCb87804a0027941066a5B216CaE0b2467";
const EXPLORER = "https://explorer-test.qday.info";

const abi = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "out", "ProofGatedPayee.sol", "ProofGatedPayee.json"), "utf8")
).abi;

function parseArgs(argv) {
  const args = { invoiceId: null, execute: false, json: false };
  for (const a of argv.slice(2)) {
    if (a === "--execute") args.execute = true;
    else if (a === "--json") args.json = true;
    else if (args.invoiceId === null) args.invoiceId = BigInt(a);
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (args.invoiceId === null) throw new Error("usage: node verifier.mjs <invoiceId> [--execute] [--json]");
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const key = JSON.parse(fs.readFileSync(path.join(__dirname, "agent-key.json"), "utf8"));
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const agent = new ethers.Wallet(key.privateKey, provider);
  const pgp = new ethers.Contract(CONTRACT, abi, provider);

  const inv = await pgp.getInvoice(args.invoiceId);
  if (inv.payer === ethers.ZeroAddress) {
    console.error(`invoice ${args.invoiceId} not found`);
    process.exit(1);
  }
  const [payeeRegistered, notExpired, agentAuthorized, withinSpendLimit, active] =
    await pgp.verifyPayee(args.invoiceId, agent.address);
  const canRelease = await pgp.canRelease(args.invoiceId, agent.address);
  const remaining = await pgp.remainingSpend(agent.address);
  const payeeInfo = await pgp.payees(inv.payee);

  const gates = [
    { name: "payeeRegistered", pass: payeeRegistered, detail: `payee ${inv.payee} registered=${payeeRegistered} (name: "${payeeInfo.name || "(none)"}")` },
    { name: "notExpired", pass: notExpired, detail: `expiry ${inv.expiry} (now ~${Math.floor(Date.now() / 1000)})` },
    { name: "agentAuthorized", pass: agentAuthorized, detail: `agent ${agent.address} authorized=${agentAuthorized}` },
    { name: "withinSpendLimit", pass: withinSpendLimit, detail: `amount ${inv.amount} vs remaining ${remaining}` },
    { name: "active", pass: active, detail: `status ${inv.status} (0=Created)` },
  ];
  const approved = canRelease && gates.every((g) => g.pass);

  const verdict = {
    invoiceId: args.invoiceId.toString(),
    payer: inv.payer,
    payee: inv.payee,
    payeeName: payeeInfo.name,
    amount: inv.amount.toString(),
    amountTusd8: Number(inv.amount) / 1e6,
    purposeHash: inv.purposeHash,
    expiry: inv.expiry.toString(),
    status: Number(inv.status),
    agent: agent.address,
    gates: gates.map((g) => ({ name: g.name, pass: g.pass, detail: g.detail })),
    canRelease,
    remainingSpend: remaining.toString(),
    verdict: approved ? "APPROVED" : "DENIED",
  };

  if (args.json) {
    console.log(JSON.stringify(verdict, null, 2));
  } else {
    console.log(`\n=== Verification agent verdict — invoice #${args.invoiceId} ===`);
    console.log(`payer  : ${inv.payer}`);
    console.log(`payee  : ${inv.payee} ("${payeeInfo.name || "(unregistered)"}")`);
    console.log(`amount : ${Number(inv.amount) / 1e6} tUSD8`);
    for (const g of gates) console.log(`  [${g.pass ? "PASS" : "FAIL"}] ${g.name} — ${g.detail}`);
    console.log(`VERDICT: ${approved ? "APPROVED — release is safe" : "DENIED — release refused"}`);
  }

  if (!approved) process.exit(2);
  if (!args.execute) process.exit(0);

  // APPROVED + --execute: sign release() with the session key.
  const pgpAgent = new ethers.Contract(CONTRACT, abi, agent);
  const tx = await pgpAgent.release(args.invoiceId);
  if (!args.json) console.log(`release() sent: ${tx.hash}\n  ${EXPLORER}/tx/${tx.hash}`);
  const receipt = await tx.wait();
  if (receipt.status !== 1) {
    console.error("release() tx reverted on-chain");
    process.exit(1);
  }
  const released = receipt.logs
    .map((l) => { try { return pgp.interface.parseLog(l); } catch { return null; } })
    .filter(Boolean)
    .map((e) => e.name);
  verdict.releaseTx = tx.hash;
  verdict.releaseBlock = receipt.blockNumber;
  verdict.releaseEvents = released;
  if (args.json) {
    console.log(JSON.stringify({ ...verdict, released: true }, null, 2));
  } else {
    console.log(`release() confirmed in block ${receipt.blockNumber} — events: ${released.join(", ")}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("verifier error:", err?.shortMessage ?? err?.message ?? err);
  process.exit(1);
});
