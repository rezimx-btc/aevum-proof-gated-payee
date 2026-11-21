# Proof-Gated Payee — Web UI

Satu halaman statis untuk entry **Proof-Gated Payee** (Aevum Builder Challenge #1,
track Confirmation of Payee). Tanpa build step, tanpa backend, tanpa private key.

## Menjalankan

Lokal:

```bash
cd ~/workspace/aevum-proof-gated-payee/web
python3 -m http.server 8000
# buka http://localhost:8000
```

Deploy statis: upload `index.html`, `app.js`, `style.css` apa adanya ke host statis
mana pun (GitHub Pages, Vercel Static, Netlify, IPFS gateway, dsb). Halaman juga
jalan dari `file://`, selama CDN ethers bisa dijangkau.

## Yang ditampilkan

- **Mode baca (default, tanpa wallet):** state live dari RPC publik Aevum testnet —
  owner, `nextInvoiceId`, saldo tUSD8 (EOA / Vendor Kopi / escrow kontrak),
  agen session key + `remainingSpend` + spend limit, daftar invoice, dan status
  5 langkah alur (Register payee → Authorize agent → Set spending limit →
  Create invoice/escrow → Verifikasi → release/refund).
- **Panel verdict gate:** input invoice id + alamat agen → `verifyPayee` +
  `canRelease` live, 5 gate PASS/FAIL (urutan sesuai `src/ProofGatedPayee.sol`:
  payee terdaftar, belum expired, agen authorized, dalam spend limit, invoice aktif).
- **Aksi tulis (butuh Connect Wallet):** registerPayee, revokePayee,
  authorizeAgent, setSpendingLimit, approve tUSD8, createInvoice, release,
  refund, cancelInvoice. Tiap form menampilkan preview call persis sebelum
  dikirim; hasil menampilkan tx hash + link explorer. Semua tulis hanya lewat
  wallet user (`window.ethereum`); halaman tidak pernah meminta/menyimpan
  private key. Connect otomatis meminta switch/tambah chain 44005.

## CORS RPC — hasil cek (21 Nov 2026)

`curl` ke `https://rpc-test.qday.info` dengan header `Origin: https://example.com`
mengembalikan:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, HEAD, POST, DELETE, PUT, OPTIONS
```

Jadi RPC publik **bisa dipanggil langsung dari browser** — mode baca jalan tanpa
proxy. Kalau suatu saat RPC memblokir CORS / mati, halaman tetap menampilkan
pesan error yang jelas, dan ada kolom **RPC URL** di atas halaman: isi RPC lain
(mis. RPC pribadi / node sendiri) lalu klik Refresh. Tidak ada fallback
tersembunyi.

## State live saat verifikasi (21 Nov 2026 ~19:00 WIB)

- `nextInvoiceId` = **2**
- Invoice **#0 Released** — 1 tUSD8 ke Vendor Kopi
  (`0x3Eb09d7A08ACD5dEbC1F0b5ee83a1a344890632F`)
- Invoice **#1 Refunded** — 0,5 tUSD8 ke `0x1111…1111` (payee tak terdaftar),
  refund penuh ke payer
- Agen `0x9caCbAaf1d71C5640982Bd4216Ee9FcA11dC91E2`: authorized, cap 2 tUSD8 /
  24 jam, spent 1, **remainingSpend 1 tUSD8**
- Saldo tUSD8: EOA 4 · Vendor Kopi 1 · escrow kontrak 0
- `verifyPayee(0, agen)` = semua gate true kecuali `active` (sudah Released) →
  `canRelease` false; `verifyPayee(1, agen)` = `payeeRegistered` false dan
  `active` false → `canRelease` false. Konsisten dengan status on-chain.

## Kontrak

- ProofGatedPayee: `0xCFf720cCb87804a0027941066a5B216CaE0b2467`
  ([explorer](https://explorer-test.qday.info/address/0xCFf720cCb87804a0027941066a5B216CaE0b2467))
- tUSD8: `0x456569838f1d43009A91ebA4263147Afd7233483` (6 desimal)
- Chain: Aevum testnet, chain ID 44005, RPC `https://rpc-test.qday.info`
- ABI di `app.js` disalin dari `out/ProofGatedPayee.sol/ProofGatedPayee.json`
  (jangan edit manual tanpa re-check ke artifact tersebut).
- Ethers v6 via CDN: `https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js`
  (UMD, tag `<script>` biasa — bukan ES module).
