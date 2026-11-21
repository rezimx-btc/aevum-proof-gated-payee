// Independent verification of the demo (reads chain state only — no keys).
// Usage: node /tmp/verify-demo.mjs
import { ethers } from "ethers";
import fs from "fs";

const RPC_URL = "https://rpc-test.qday.info";
const PGP = "0xCFf720cCb87804a0027941066a5B216CaE0b2467";
const TUSD8 = "0x456569838f1d43009A91ebA4263147Afd7233483";
const EOA = "0x92eeE1BedeCfD2527c315aB31B08838D1dC215a8";
const VENDOR = "0x3Eb09d7A08ACD5dEbC1F0b5ee83a1a344890632F";
const STRANGER = "0x1111111111111111111111111111111111111111";
const AGENT = "0x9caCbAaf1d71C5640982Bd4216Ee9FcA11dC91E2";

const TXS = {
  "fund agent #1 (run 1)": "0x248acae56b4aa8ef67bea7b342ff7d3a1a5eb6cde892b919257bfb3d907ddc2a",
  "fund agent #2": "0x6a610c6e53bc24bd5240f7a2b7a99989ba2aa469dd72fd45105d0227cf4f13c3",
  "registerPayee Vendor Kopi": "0x1eb14d8ba07c1e0213c62bed60781fe345b662e5059ff39a4e5e0293f6991c41",
  "authorizeAgent": "0x0b77f210120a26d71853dc802f205c2043811c2e40a93d54b1116d777dc71cc2",
  "setSpendingLimit 2 tUSD8/1d": "0x6fc006dc0c05a9939813cbbb2d6e273355d92dca198a075c9af2e7b3a7869174",
  "approve 1 tUSD8": "0x84e61d513018b53c42556bcdf7d554e456930e98833a257cc911e4586caa5447",
  "createInvoice #0 (1 tUSD8)": "0x57e1141d0856c2f5d53e84f5580ef1b0b0f9a0931f1bcb38b540c1f4e1c8b97d",
  "release #0 (agent)": "0x70617e01cd45ec9f2e33835ca10524c68758854684f8a7b6e8545a4db9808892",
  "approve 0.5 tUSD8": "0xcedea17e28f610311c6df6236fd4fe054ae4d773269c090e6ff4e77b9e33aa4a",
  "createInvoice #1 (0.5 tUSD8)": "0x21d0a070f1e6f4c2ce0dac387e4de382fce3b16a5bb64ddbd6910213f99937b5",
  "refund #1": "0xfa78093b1e469549e433943ce72ffdeeaa85bb75058bc5d5920c513a82fae2dc",
};

import { fileURLToPath } from "url";
import path from "path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const abi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "out", "ProofGatedPayee.sol", "ProofGatedPayee.json"), "utf8")).abi;
const erc20 = ["function balanceOf(address) view returns (uint256)"];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const pgp = new ethers.Contract(PGP, abi, provider);
const t = new ethers.Contract(TUSD8, erc20, provider);

console.log("=== receipts (all must be status 1) ===");
let ok = true;
for (const [label, hash] of Object.entries(TXS)) {
  const r = await provider.getTransactionReceipt(hash);
  const s = r ? `status ${r.status} block ${r.blockNumber} gas ${r.gasUsed}` : "NOT FOUND";
  if (!r || r.status !== 1) ok = false;
  console.log(`  ${r?.status === 1 ? "OK " : "BAD"} ${label}: ${s}`);
}

console.log("\n=== contract state ===");
const inv0 = await pgp.getInvoice(0);
const inv1 = await pgp.getInvoice(1);
console.log(`  invoice #0: payer ${inv0.payer.slice(0, 10)}… payee ${inv0.payee.slice(0, 10)}… amount ${inv0.amount} status ${inv0.status} (1=Released)`);
console.log(`  invoice #1: payer ${inv1.payer.slice(0, 10)}… payee ${inv1.payee} amount ${inv1.amount} status ${inv1.status} (2=Refunded)`);
console.log(`  payee Vendor Kopi registered: ${(await pgp.payees(VENDOR)).registered} name="${(await pgp.payees(VENDOR)).name}"`);
console.log(`  agent authorized: ${await pgp.authorizedAgents(AGENT)}`);
console.log(`  spendLimit agent: cap ${ (await pgp.spendLimits(AGENT)).cap } spent ${(await pgp.spendLimits(AGENT)).spent} remaining ${await pgp.remainingSpend(AGENT)}`);
console.log(`  canRelease(#0): ${await pgp.canRelease(0, AGENT)} (false now — already released, correct)`);
console.log(`  canRelease(#1): ${await pgp.canRelease(1, AGENT)} (false — refunded, correct)`);
console.log(`  nextInvoiceId: ${await pgp.nextInvoiceId()}`);

console.log("\n=== balances (tUSD8, 6 decimals) ===");
const b = async (a) => Number(await t.balanceOf(a)) / 1e6;
console.log(`  EOA: ${await b(EOA)} | vendor: ${await b(VENDOR)} | stranger: ${await b(STRANGER)} | escrow: ${await b(PGP)} | agent tQDAY: ${Number(await provider.getBalance(AGENT)) / 1e18}`);
console.log(`\nALL RECEIPTS OK: ${ok}`);
