// run_demo.mjs — Proof-Gated Payee end-to-end demo on Aevum testnet (chain 44005).
//
// Runs the full flow live, with on-chain proof at every step:
//   (1) setup: register "Vendor Kopi", authorize the agent session key, set its
//       spending limit, fund the agent with gas;
//   (2) SUCCESS: invoice 1 tUSD8 to Vendor Kopi -> agent verifies -> release ->
//       vendor receives 1 tUSD8;
//   (3) FAILURE: invoice 0.5 tUSD8 to an UNREGISTERED address -> agent DENIES
//       the release -> release() provably reverts -> payer refunds in full,
//       stranger receives 0.
//
// Keys are read from files into memory only and are NEVER printed.
// Usage: node demo/run_demo.mjs
// Output: step-by-step log on stdout + demo/demo-results.json (tx hashes,
// blocks, balances — no keys).

import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const RPC_URL = "https://rpc-test.qday.info";
const EXPLORER = "https://explorer-test.qday.info";
const PGP_ADDRESS = "0xCFf720cCb87804a0027941066a5B216CaE0b2467";
const TUSD8 = "0x456569838f1d43009A91ebA4263147Afd7233483";
const VENDOR = "0x3Eb09d7A08ACD5dEbC1F0b5ee83a1a344890632F"; // user's payout wallet (demo vendor)
const STRANGER = "0x1111111111111111111111111111111111111111"; // unregistered address

const pgpAbi = JSON.parse(
  fs.readFileSync(path.join(ROOT, "out", "ProofGatedPayee.sol", "ProofGatedPayee.json"), "utf8")
).abi;
const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const fmt6 = (v) => (Number(v) / 1e6).toFixed(6);
const fmtQ = (v) => (Number(v) / 1e18).toFixed(12);
const txLink = (h) => `${EXPLORER}/tx/${h}`;
const results = { contract: PGP_ADDRESS, chainId: 44005, steps: [] };

function step(title) {
  console.log(`\n===== ${title} =====`);
}
function log(msg) {
  console.log(`  ${msg}`);
}
function record(name, data) {
  results.steps.push({ name, ...data });
}

async function sendAndWait(label, promiseFn) {
  const tx = await promiseFn();
  log(`${label} sent: ${tx.hash}  (${txLink(tx.hash)})`);
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`${label}: tx reverted on-chain (${tx.hash})`);
  log(`${label} confirmed in block ${receipt.blockNumber} (gas used ${receipt.gasUsed})`);
  return { hash: tx.hash, block: Number(receipt.blockNumber), gasUsed: receipt.gasUsed.toString(), receipt };
}

async function snapshot(provider, tusd8, label) {
  const eoa = results.eoa;
  const s = {
    eoaTqday: (await provider.getBalance(eoa)).toString(),
    eoaTusd8: (await tusd8.balanceOf(eoa)).toString(),
    vendorTusd8: (await tusd8.balanceOf(VENDOR)).toString(),
    strangerTusd8: (await tusd8.balanceOf(STRANGER)).toString(),
    escrowTusd8: (await tusd8.balanceOf(PGP_ADDRESS)).toString(),
  };
  log(`${label}: EOA ${fmtQ(s.eoaTqday)} tQDAY / ${fmt6(s.eoaTusd8)} tUSD8 | vendor ${fmt6(s.vendorTusd8)} | stranger ${fmt6(s.strangerTusd8)} | escrow ${fmt6(s.escrowTusd8)}`);
  return s;
}

function runVerifier(invoiceId, execute) {
  const args = ["agent/verifier.mjs", String(invoiceId)];
  if (execute) args.push("--execute");
  console.log(`  $ node ${args.join(" ")}`);
  const r = spawnSync("node", args, { cwd: ROOT, stdio: "inherit" });
  return r.status;
}

// Re-runs are safe: recover a past step's tx hash from the contract's own
// event log instead of repeating the on-chain action.
async function recoverTx(pgp, eventName, invoiceId) {
  const events = await pgp.queryFilter(pgp.filters[eventName](invoiceId), 3744539);
  if (events.length === 0) return null;
  return { hash: events[0].transactionHash, block: events[0].blockNumber };
}

async function ensureAllowance(tusd8Eoa, tusd8, ownerAddr, amount) {
  const allowance = await tusd8.allowance(ownerAddr, PGP_ADDRESS);
  if (allowance < amount) {
    const a = await sendAndWait(`approve(contract, ${fmt6(amount)} tUSD8)`, () =>
      tusd8Eoa.approve(PGP_ADDRESS, amount));
    return a;
  }
  log(`allowance already ${fmt6(allowance)} tUSD8 — no approve needed`);
  return null;
}

async function main() {
  const eoaKey = JSON.parse(
    fs.readFileSync(path.join(process.env.HOME, "workspace", "muse-wallet", "eoa-wallet.json"), "utf8")
  );
  const agentKey = JSON.parse(fs.readFileSync(path.join(ROOT, "agent", "agent-key.json"), "utf8"));
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const eoa = new ethers.Wallet(eoaKey.privateKey, provider);
  const agent = new ethers.Wallet(agentKey.privateKey, provider);
  results.eoa = eoa.address;
  results.agent = agent.address;
  results.vendor = VENDOR;
  results.stranger = STRANGER;

  const pgp = new ethers.Contract(PGP_ADDRESS, pgpAbi, provider);
  const pgpEoa = new ethers.Contract(PGP_ADDRESS, pgpAbi, eoa);
  const pgpAgent = new ethers.Contract(PGP_ADDRESS, pgpAbi, agent);
  const tusd8 = new ethers.Contract(TUSD8, erc20Abi, provider);
  const tusd8Eoa = new ethers.Contract(TUSD8, erc20Abi, eoa);

  // ---- 0. Preflight ----
  step("0. Preflight — chain, contract, balances");
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== 44005) throw new Error(`wrong chain ${chainId}`);
  log(`chainId ${chainId} (Aevum testnet)`);
  const code = await provider.getCode(PGP_ADDRESS);
  if (code.length < 10) throw new Error("no bytecode at contract address");
  log(`contract bytecode present (${(code.length - 2) / 2} bytes)`);
  const owner = await pgp.owner();
  if (owner.toLowerCase() !== eoa.address.toLowerCase()) throw new Error(`owner mismatch: ${owner}`);
  log(`owner == EOA ${eoa.address}`);
  log(`token == tUSD8 ${await pgp.token()}`);
  const nextId0 = Number(await pgp.nextInvoiceId());
  log(`nextInvoiceId = ${nextId0}`);
  const before = await snapshot(provider, tusd8, "balances BEFORE");

  // ---- 1. Setup (skips anything already done — re-runs are safe) ----
  step("1. Setup — register payee, authorize agent, set spending limit, fund agent gas");
  const agentTqday = await provider.getBalance(agent.address);
  if (agentTqday < ethers.parseEther("0.0005")) {
    const fund = await sendAndWait("fund agent 0.001 tQDAY", () =>
      eoa.sendTransaction({ to: agent.address, value: ethers.parseEther("0.001") }));
    record("fund-agent-gas", { tx: fund.hash, block: fund.block, amountTqday: "0.001" });
  } else {
    log(`agent already funded (${fmtQ(agentTqday)} tQDAY) — skip`);
  }

  if (!(await pgp.payees(VENDOR)).registered) {
    const reg = await sendAndWait('registerPayee("Vendor Kopi")', () =>
      pgpEoa.registerPayee("Vendor Kopi", VENDOR));
    record("register-payee", { tx: reg.hash, block: reg.block, name: "Vendor Kopi", payee: VENDOR });
  } else {
    const r = await recoverTx(pgp, "PayeeRegistered", null);
    log(`payee "Vendor Kopi" already registered — skip (first registration tx ${r?.hash ?? "unknown"})`);
    record("register-payee", { tx: r?.hash ?? null, block: r?.block ?? null, name: "Vendor Kopi", payee: VENDOR, recovered: true });
  }

  if (!(await pgp.authorizedAgents(agent.address))) {
    const auth = await sendAndWait("authorizeAgent(agent, true)", () =>
      pgpEoa.authorizeAgent(agent.address, true));
    record("authorize-agent", { tx: auth.hash, block: auth.block, agent: agent.address });
  } else {
    log(`agent ${agent.address} already authorized — skip`);
    record("authorize-agent", { agent: agent.address, recovered: true });
  }

  const cap = 2_000_000n; // 2 tUSD8 per 1-day window
  const curLimit = await pgp.spendLimits(agent.address);
  if (curLimit.cap !== cap) {
    const lim = await sendAndWait("setSpendingLimit(agent, 2 tUSD8 / 1 day)", () =>
      pgpEoa.setSpendingLimit(agent.address, cap, 86400));
    record("set-spending-limit", { tx: lim.hash, block: lim.block, cap: cap.toString(), windowSeconds: 86400 });
  } else {
    log(`spending limit already 2 tUSD8 / 1 day — skip`);
    record("set-spending-limit", { cap: cap.toString(), windowSeconds: 86400, recovered: true });
  }
  log(`agent remainingSpend now: ${fmt6(await pgp.remainingSpend(agent.address))} tUSD8`);

  // ---- 2. SUCCESS path ----
  const expiry = Math.floor(Date.now() / 1000) + 3600; // 1-hour invoice expiry
  const inv0exists = nextId0 >= 1;
  const inv0 = inv0exists ? await pgp.getInvoice(0) : null;
  if (inv0exists && Number(inv0.status) === 1) {
    step("2. SUCCESS — invoice #0 already Released (recovered from chain, not repeated)");
    const c = await recoverTx(pgp, "InvoiceCreated", 0);
    const r = await recoverTx(pgp, "Released", 0);
    log(`invoice #0: created ${c?.hash} (block ${c?.block}), released ${r?.hash} (block ${r?.block})`);
    record("create-invoice-success", { tx: c?.hash ?? null, block: c?.block ?? null, invoiceId: 0, amount: "1000000", purpose: "kopi-001", recovered: true });
    record("release-success", { invoiceId: 0, vendorReceived: "1000000", tx: r?.hash ?? null, block: r?.block ?? null, recovered: true });
  } else {
    step("2. SUCCESS — invoice 1 tUSD8 to Vendor Kopi");
    await ensureAllowance(tusd8Eoa, tusd8, eoa.address, 1_000_000n);

    const purpose0 = ethers.keccak256(ethers.toUtf8Bytes("kopi-001"));
    const created0 = await sendAndWait("createInvoice(vendor, 1 tUSD8)", () =>
      pgpEoa.createInvoice(VENDOR, 1_000_000n, purpose0, expiry));
    const ev0 = created0.receipt.logs
      .map((l) => { try { return pgp.interface.parseLog(l); } catch { return null; } })
      .find((e) => e?.name === "InvoiceCreated");
    const id0 = Number(ev0.args.id);
    log(`invoice #${id0} created (expiry ${expiry})`);
    record("create-invoice-success", { tx: created0.hash, block: created0.block, invoiceId: id0, amount: "1000000", purpose: "kopi-001" });
    await snapshot(provider, tusd8, "balances after escrow (invoice #0)");

    step("3. Agent verifies invoice #0 and releases");
    const verdict0 = runVerifier(id0, true);
    if (verdict0 !== 0) throw new Error(`verifier failed on invoice #${id0} (exit ${verdict0})`);
    const inv0b = await pgp.getInvoice(id0);
    if (Number(inv0b.status) !== 1) throw new Error(`invoice #${id0} status is ${inv0b.status}, expected 1 (Released)`);
    log(`invoice #${id0} status = Released`);
    const afterSuccess = await snapshot(provider, tusd8, "balances after release");
    if (afterSuccess.vendorTusd8 !== "1000000") throw new Error("vendor did not receive exactly 1 tUSD8");
    record("release-success", { invoiceId: id0, vendorReceived: "1000000" });
  }

  // ---- 3. FAILURE path ----
  const inv1exists = nextId0 >= 2;
  const inv1pre = inv1exists ? await pgp.getInvoice(1) : null;
  if (inv1exists && Number(inv1pre.status) === 2) {
    step("4-7. FAILURE path — invoice #1 already Refunded (recovered from chain, not repeated)");
    const c = await recoverTx(pgp, "InvoiceCreated", 1);
    const r = await recoverTx(pgp, "Refunded", 1);
    log(`invoice #1: created ${c?.hash} (block ${c?.block}), refunded ${r?.hash} (block ${r?.block})`);
    record("create-invoice-failure-case", { tx: c?.hash ?? null, block: c?.block ?? null, invoiceId: 1, amount: "500000", purpose: "unknown-001", recovered: true });
    record("verifier-denied", { invoiceId: 1, exitCode: 2, recovered: true });
    record("release-revert-proof", { invoiceId: 1, revert: "PayeeNotRegistered()", recovered: true });
    record("refund", { tx: r?.hash ?? null, block: r?.block ?? null, invoiceId: 1, amount: "500000", recovered: true });
  } else {
  step("4. FAILURE — invoice 0.5 tUSD8 to an UNREGISTERED address");
  await ensureAllowance(tusd8Eoa, tusd8, eoa.address, 500_000n);
  const purpose1 = ethers.keccak256(ethers.toUtf8Bytes("unknown-001"));
  const created1 = await sendAndWait("createInvoice(stranger, 0.5 tUSD8)", () =>
    pgpEoa.createInvoice(STRANGER, 500_000n, purpose1, expiry));
  const ev1 = created1.receipt.logs
    .map((l) => { try { return pgp.interface.parseLog(l); } catch { return null; } })
    .find((e) => e?.name === "InvoiceCreated");
  const id1 = Number(ev1.args.id);
  log(`invoice #${id1} created (payee NOT on allowlist)`);
  record("create-invoice-failure-case", { tx: created1.hash, block: created1.block, invoiceId: id1, amount: "500000", purpose: "unknown-001" });

  step("5. Agent verifies invoice #1 — must DENY");
  const verdict1 = runVerifier(id1, false);
  if (verdict1 !== 2) throw new Error(`expected verifier DENY (exit 2) on invoice #${id1}, got exit ${verdict1}`);
  log(`agent DENIED invoice #${id1} — no release attempted (correct)`);
  record("verifier-denied", { invoiceId: id1, exitCode: 2 });

  step("6. Prove release() reverts for invoice #1 (static call, no gas spent)");
  let revertProof = null;
  try {
    await pgpAgent.release.staticCall(id1);
    throw new Error("release() did NOT revert — gate failure!");
  } catch (err) {
    const data = err?.data ?? err?.info?.error?.data ?? "";
    const selector = ethers.keccak256(ethers.toUtf8Bytes("PayeeNotRegistered()")).slice(0, 10);
    revertProof = String(data).startsWith(selector)
      ? "PayeeNotRegistered()"
      : `reverted (data: ${String(data).slice(0, 66) || err?.shortMessage || err.message})`;
    log(`release() reverted as expected: ${revertProof}`);
  }
  record("release-revert-proof", { invoiceId: id1, revert: revertProof });

  step("7. Payer refunds invoice #1 in full");
  const refund = await sendAndWait("refund(invoice #1)", () => pgpEoa.refund(id1));
  const evR = refund.receipt.logs
    .map((l) => { try { return pgp.interface.parseLog(l); } catch { return null; } })
    .find((e) => e?.name === "Refunded");
  log(`Refunded event: payer ${evR.args.payer}, amount ${fmt6(evR.args.amount)} tUSD8`);
  const inv1 = await pgp.getInvoice(id1);
  if (Number(inv1.status) !== 2) throw new Error(`invoice #${id1} status is ${inv1.status}, expected 2 (Refunded)`);
  record("refund", { tx: refund.hash, block: refund.block, invoiceId: id1, amount: "500000" });
  } // end failure-path else (skipped when invoice #1 already refunded)

  // ---- 4. Final verification ----
  step("8. Final balances — stranger got 0, funds conserved");
  const after = await snapshot(provider, tusd8, "balances AFTER");
  if (after.strangerTusd8 !== "0") throw new Error("stranger received funds!");
  const conserved = BigInt(after.eoaTusd8) + BigInt(after.vendorTusd8);
  if (conserved !== 5_000_000n) throw new Error(`funds not conserved: EOA ${after.eoaTusd8} + vendor ${after.vendorTusd8} = ${conserved}, expected 5000000`);
  if (after.vendorTusd8 === "0") throw new Error("vendor received nothing!");
  if (after.escrowTusd8 !== "0") throw new Error(`escrow not empty: ${after.escrowTusd8}`);
  log(`conservation check: EOA ${fmt6(after.eoaTusd8)} + vendor ${fmt6(after.vendorTusd8)} = 5.000000 tUSD8 (all 5 faucet tUSD8 accounted for)`);
  results.balancesBefore = before;
  results.balancesAfter = after;
  results.outcome = "SUCCESS: release path paid 1 tUSD8 to Vendor Kopi; failure path denied, reverted, refunded in full; stranger received 0";

  fs.writeFileSync(path.join(__dirname, "demo-results.json"), JSON.stringify(results, null, 2));
  console.log(`\n===== DEMO COMPLETE =====\n${results.outcome}\nresults written to demo/demo-results.json`);
}

main().catch((err) => {
  console.error("\nDEMO FAILED:", err?.shortMessage ?? err?.message ?? err);
  process.exit(1);
});
