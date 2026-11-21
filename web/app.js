// Proof-Gated Payee — read-only by default, writes only via connected wallet.
// No private keys anywhere. Ethers v6 UMD (global `ethers`) via CDN.
(function () {
  'use strict';

  var CONTRACT = '0xCFf720cCb87804a0027941066a5B216CaE0b2467';
  var TOKEN = '0x456569838f1d43009A91ebA4263147Afd7233483';
  var CHAIN_ID = 44005;
  var DEFAULT_RPC = 'https://rpc-test.qday.info';
  var EXPLORER = 'https://explorer-test.qday.info';
  var VENDOR = '0x3Eb09d7A08ACD5dEbC1F0b5ee83a1a344890632F';
  var AGENT = '0x9caCbAaf1d71C5640982Bd4216Ee9FcA11dC91E2';
  var EOA = '0x92eeE1BedeCfD2527c315aB31B08838D1dC215a8';

  // Minimal ABI — signatures copied from out/ProofGatedPayee.sol/ProofGatedPayee.json
  var ABI = [
    'function owner() view returns (address)',
    'function token() view returns (address)',
    'function nextInvoiceId() view returns (uint256)',
    'function payees(address) view returns (string name, bool registered)',
    'function invoices(uint256) view returns (address payer, address payee, uint256 amount, bytes32 purposeHash, uint64 expiry, uint8 status)',
    'function getInvoice(uint256) view returns (tuple(address payer, address payee, uint256 amount, bytes32 purposeHash, uint64 expiry, uint8 status))',
    'function verifyPayee(uint256, address) view returns (bool payeeRegistered, bool notExpired, bool agentAuthorized, bool withinSpendLimit, bool active)',
    'function canRelease(uint256, address) view returns (bool)',
    'function remainingSpend(address) view returns (uint256)',
    'function spendLimits(address) view returns (uint256 cap, uint256 windowSeconds, uint256 spent, uint64 windowStart)',
    'function authorizedAgents(address) view returns (bool)',
    'function registerPayee(string, address)',
    'function authorizeAgent(address, bool)',
    'function setSpendingLimit(address, uint256, uint256)',
    'function createInvoice(address, uint256, bytes32, uint64) returns (uint256)',
    'function release(uint256)',
    'function refund(uint256)',
    'function cancelInvoice(uint256)',
    'function revokePayee(address)'
  ];
  var TOKEN_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address, uint256) returns (bool)'
  ];
  var STATUS = ['Created', 'Released', 'Refunded', 'Cancelled'];

  var $ = function (id) { return document.getElementById(id); };
  var rpcStatus = $('rpcStatus'), errorBox = $('errorBox'), walletStatus = $('walletStatus');
  var provider = null, readContract = null, tokenContract = null;
  var signer = null, writeContract = null, account = null;

  function showError(msg) {
    errorBox.hidden = false;
    errorBox.textContent = msg;
  }
  function clearError() { errorBox.hidden = true; errorBox.textContent = ''; }
  function short(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : '—'; }
  function fmtTusd(v) { return (Number(v) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 }) + ' tUSD8'; }
  function fmtDate(ts) {
    if (!ts) return '—';
    var d = new Date(Number(ts) * 1000);
    return d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
  }
  function explorerAddr(a) { return '<a href="' + EXPLORER + '/address/' + a + '" target="_blank" rel="noopener">' + short(a) + '</a>'; }
  function explorerTx(h) { return '<a href="' + EXPLORER + '/tx/' + h + '" target="_blank" rel="noopener">' + short(h) + '</a>'; }

  function setBadge(li, done, label) {
    var b = li.querySelector('[data-badge]');
    b.textContent = label || (done ? 'DONE' : 'PENDING');
    b.className = 'badge ' + (done ? 'done' : 'pending');
  }

  async function loadState() {
    clearError();
    rpcStatus.textContent = 'RPC: menghubungkan…';
    var rpcUrl = $('rpcUrl').value.trim() || DEFAULT_RPC;
    try {
      provider = new ethers.JsonRpcProvider(rpcUrl);
      var net = await provider.getNetwork();
      if (Number(net.chainId) !== CHAIN_ID) {
        throw new Error('RPC mengembalikan chainId ' + net.chainId + ', diharapkan ' + CHAIN_ID + '.');
      }
      readContract = new ethers.Contract(CONTRACT, ABI, provider);
      tokenContract = new ethers.Contract(TOKEN, TOKEN_ABI, provider);
      var block = await provider.getBlockNumber();
      rpcStatus.textContent = 'RPC: live · chain 44005 · blok ' + block;
      rpcStatus.classList.add('ok');

      var owner = await readContract.owner();
      var nextId = Number(await readContract.nextInvoiceId());
      var vendorPayee = await readContract.payees(VENDOR);
      var agentAuth = await readContract.authorizedAgents(AGENT);
      var limit = await readContract.spendLimits(AGENT);
      var remaining = await readContract.remainingSpend(AGENT);
      var balEscrow = await tokenContract.balanceOf(CONTRACT);
      var balEoa = await tokenContract.balanceOf(EOA);
      var balVendor = await tokenContract.balanceOf(VENDOR);

      $('stOwner').innerHTML = explorerAddr(owner);
      $('stNextId').textContent = nextId;
      $('stEscrow').textContent = fmtTusd(balEscrow);
      $('stEoa').textContent = fmtTusd(balEoa);
      $('stVendor').innerHTML = fmtTusd(balVendor) + ' · ' + explorerAddr(VENDOR);
      $('stAgent').innerHTML = explorerAddr(AGENT) + ' · ' + (agentAuth ? 'authorized' : 'TIDAK authorized');
      $('stRemaining').textContent = fmtTusd(remaining) + ' dari cap ' + fmtTusd(limit.cap);
      $('stLimit').textContent = 'cap ' + fmtTusd(limit.cap) + ' / ' + Number(limit.windowSeconds) / 3600 + ' jam · spent ' + fmtTusd(limit.spent);
      $('stBlock').textContent = String(block);

      // Steps
      var steps = document.querySelectorAll('#steps li');
      setBadge(steps[0], vendorPayee.registered);
      steps[0].querySelector('[data-detail]').textContent = vendorPayee.registered
        ? '“' + vendorPayee.name + '” terdaftar: ' + short(VENDOR) : 'Vendor Kopi belum terdaftar.';
      setBadge(steps[1], agentAuth);
      steps[1].querySelector('[data-detail]').textContent = agentAuth
        ? 'Agen ' + short(AGENT) + ' authorized.' : 'Agen belum authorized.';
      var hasLimit = limit.cap > 0n;
      setBadge(steps[2], hasLimit);
      steps[2].querySelector('[data-detail]').textContent = hasLimit
        ? 'Cap ' + fmtTusd(limit.cap) + ' / ' + (Number(limit.windowSeconds) / 3600) + ' jam.' : 'Belum ada spending limit.';
      var hasInvoices = nextId > 0;
      setBadge(steps[3], hasInvoices);
      steps[3].querySelector('[data-detail]').textContent = hasInvoices
        ? nextId + ' invoice dibuat · escrow ' + fmtTusd(balEscrow) + '.' : 'Belum ada invoice.';
      var released = 0, refunded = 0;
      var tbody = document.querySelector('#invTable tbody');
      tbody.innerHTML = '';
      if (nextId === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="muted">Belum ada invoice.</td></tr>';
      }
      for (var id = 0; id < nextId; id++) {
        var inv = await readContract.getInvoice(id);
        var st = Number(inv.status);
        if (st === 1) released++;
        if (st === 2) refunded++;
        var payeeInfo = await readContract.payees(inv.payee);
        var name = payeeInfo.registered ? ' · ' + payeeInfo.name : ' · (tidak terdaftar)';
        var tr = document.createElement('tr');
        tr.innerHTML = '<td>' + id + '</td><td>' + explorerAddr(inv.payer) + '</td>' +
          '<td>' + explorerAddr(inv.payee) + name + '</td>' +
          '<td>' + fmtTusd(inv.amount) + '</td><td>' + fmtDate(inv.expiry) + '</td>' +
          '<td><span class="st st' + st + '">' + STATUS[st] + '</span></td>' +
          '<td><button type="button" class="mini" data-check="' + id + '">Cek gate</button></td>';
        tbody.appendChild(tr);
      }
      tbody.querySelectorAll('[data-check]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          $('gateId').value = btn.getAttribute('data-check');
          checkGate();
          $('gateResult').scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      });
      var step5done = released > 0 || refunded > 0;
      setBadge(steps[4], step5done);
      steps[4].querySelector('[data-detail]').textContent = step5done
        ? released + ' released · ' + refunded + ' refunded.' : 'Belum ada release/refund.';
    } catch (e) {
      rpcStatus.textContent = 'RPC: GAGAL';
      rpcStatus.classList.remove('ok');
      showError('Gagal membaca state dari RPC (' + rpcUrl + '): ' + (e && e.message ? e.message : e) +
        ' Coba RPC lain di kolom di atas, lalu Refresh. Kemungkinan: RPC mati, CORS diblokir, atau tidak ada internet.');
    }
  }

  var GATE_LABELS = [
    'Payee terdaftar di allowlist',
    'Invoice belum expired',
    'Agen authorized (session key)',
    'Dalam spend limit agen',
    'Invoice aktif (status Created)'
  ];

  async function checkGate() {
    clearError();
    var id = Number($('gateId').value);
    var agent = $('gateAgent').value.trim();
    var box = $('gateResult');
    if (!readContract) { showError('State belum termuat — klik Refresh dulu.'); return; }
    if (!ethers.isAddress(agent)) { showError('Alamat agen tidak valid: ' + agent); return; }
    box.innerHTML = '<p class="muted">Memanggil verifyPayee(' + id + ', ' + short(agent) + ')…</p>';
    try {
      var v = await readContract.verifyPayee(id, agent);
      var can = await readContract.canRelease(id, agent);
      var html = '<div class="verdict ' + (can ? 'pass' : 'fail') + '">Verdict: ' +
        (can ? 'BISA RELEASE' : 'TIDAK BISA RELEASE') + '</div><ul class="gates">';
      for (var i = 0; i < 5; i++) {
        html += '<li class="' + (v[i] ? 'pass' : 'fail') + '">' + (v[i] ? 'PASS' : 'FAIL') +
          ' — ' + GATE_LABELS[i] + '</li>';
      }
      html += '</ul>';
      box.innerHTML = html;
    } catch (e) {
      box.innerHTML = '';
      showError('Gagal memanggil verifyPayee: ' + (e && e.message ? e.message : e));
    }
  }

  async function connectWallet() {
    clearError();
    if (!window.ethereum) {
      showError('Tidak ada wallet terdeteksi (window.ethereum kosong). Pasang MetaMask / wallet EVM di browser ini, lalu muat ulang halaman.');
      return;
    }
    try {
      var accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      account = accounts[0];
      var bp = new ethers.BrowserProvider(window.ethereum);
      var net = await bp.getNetwork();
      if (Number(net.chainId) !== CHAIN_ID) {
        try {
          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: '0x' + CHAIN_ID.toString(16) }]
          });
        } catch (switchErr) {
          if (switchErr && switchErr.code === 4902) {
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [{
                chainId: '0x' + CHAIN_ID.toString(16),
                chainName: 'Aevum Testnet',
                rpcUrls: [$('rpcUrl').value.trim() || DEFAULT_RPC],
                blockExplorerUrls: [EXPLORER],
                nativeCurrency: { name: 'tQDAY', symbol: 'tQDAY', decimals: 18 }
              }]
            });
          } else { throw switchErr; }
        }
        net = await bp.getNetwork();
      }
      signer = await bp.getSigner();
      writeContract = new ethers.Contract(CONTRACT, ABI, signer);
      walletStatus.textContent = 'Terhubung: ' + short(account) + ' · chain ' + Number(net.chainId);
      $('btnConnect').textContent = 'Terhubung ✓';
    } catch (e) {
      showError('Gagal connect wallet: ' + (e && e.message ? e.message : e));
    }
  }

  function logTx(action, preview, resultHtml) {
    var log = $('txLog');
    var div = document.createElement('div');
    div.className = 'tx';
    div.innerHTML = '<b>' + action + '</b><br><code>' + preview + '</code><br>' + resultHtml;
    log.prepend(div);
  }

  function parseTusd(s) {
    var n = Number(s);
    if (!isFinite(n) || n <= 0) throw new Error('Jumlah tUSD8 harus angka > 0.');
    return ethers.parseUnits(String(n), 6);
  }

  async function handleWrite(ev) {
    ev.preventDefault();
    clearError();
    var form = ev.target;
    var action = form.getAttribute('data-action');
    if (!writeContract || !account) {
      showError('Hubungkan wallet dulu (tombol Connect Wallet) — aksi tulis hanya lewat wallet kamu.');
      return;
    }
    var fd = new FormData(form);
    var g = function (k) { return (fd.get(k) || '').toString().trim(); };
    var preview = '', send = null;
    try {
      if (action === 'registerPayee') {
        if (!ethers.isAddress(g('payee'))) throw new Error('Alamat payee tidak valid.');
        preview = 'registerPayee("' + g('name') + '", ' + g('payee') + ')';
        send = function () { return writeContract.registerPayee(g('name'), g('payee')); };
      } else if (action === 'revokePayee') {
        if (!ethers.isAddress(g('payee'))) throw new Error('Alamat payee tidak valid.');
        preview = 'revokePayee(' + g('payee') + ')';
        send = function () { return writeContract.revokePayee(g('payee')); };
      } else if (action === 'authorizeAgent') {
        if (!ethers.isAddress(g('agent'))) throw new Error('Alamat agen tidak valid.');
        preview = 'authorizeAgent(' + g('agent') + ', ' + g('authorized') + ')';
        send = function () { return writeContract.authorizeAgent(g('agent'), g('authorized') === 'true'); };
      } else if (action === 'setSpendingLimit') {
        if (!ethers.isAddress(g('agent'))) throw new Error('Alamat agen tidak valid.');
        var cap = parseTusd(g('cap'));
        preview = 'setSpendingLimit(' + g('agent') + ', ' + cap + ' (' + g('cap') + ' tUSD8), ' + g('windowSeconds') + ' detik)';
        send = function () { return writeContract.setSpendingLimit(g('agent'), cap, BigInt(g('windowSeconds'))); };
      } else if (action === 'approve') {
        var amt = parseTusd(g('amount'));
        preview = 'tUSD8.approve(kontrak, ' + amt + ' = ' + g('amount') + ' tUSD8)';
        var tok = new ethers.Contract(TOKEN, TOKEN_ABI, signer);
        send = function () { return tok.approve(CONTRACT, amt); };
      } else if (action === 'createInvoice') {
        if (!ethers.isAddress(g('payee'))) throw new Error('Alamat payee tidak valid.');
        var amt2 = parseTusd(g('amount'));
        var purpose = ethers.encodeBytes32String(g('purpose').slice(0, 31));
        var expiry = BigInt(Math.floor(Date.now() / 1000) + Number(g('expiryMinutes')) * 60);
        preview = 'createInvoice(' + g('payee') + ', ' + amt2 + ' (' + g('amount') + ' tUSD8), "' + g('purpose') + '" → ' + purpose + ', expiry ' + expiry + ' = ' + fmtDate(expiry) + ') — butuh approve tUSD8 dulu';
        send = function () { return writeContract.createInvoice(g('payee'), amt2, purpose, expiry); };
      } else if (action === 'release' || action === 'refund' || action === 'cancelInvoice') {
        var id = BigInt(g('id'));
        preview = action + '(' + id + ')';
        send = function () { return writeContract[action](id); };
      }
      if (!send) throw new Error('Aksi tidak dikenal: ' + action);
      var gasNote = 'Gas: estimasi otomatis oleh wallet (tQDAY). Nilai tUSD8 yang bergerak: lihat preview di atas.';
      logTx(action, preview, '<span class="muted">Menunggu konfirmasi di wallet… ' + gasNote + '</span>');
      var tx = await send();
      logTx(action, preview, 'Tx dikirim: ' + explorerTx(tx.hash) + ' — menunggu konfirmasi…');
      var receipt = await tx.wait();
      logTx(action, preview, 'Terkirim ✓ blok ' + receipt.blockNumber + ' · ' + explorerTx(tx.hash));
      await loadState();
    } catch (e) {
      var msg = (e && e.message) || String(e);
      if (msg.length > 400) msg = msg.slice(0, 400) + '…';
      logTx(action, preview || '(preview gagal dibuat)', '<span class="error-text">GAGAL: ' + msg + '</span>');
      showError('Tx gagal: ' + msg);
    }
  }

  document.querySelectorAll('form[data-action]').forEach(function (f) {
    f.addEventListener('submit', handleWrite);
  });
  $('btnRefresh').addEventListener('click', loadState);
  $('btnConnect').addEventListener('click', connectWallet);
  $('btnGate').addEventListener('click', checkGate);
  if (window.ethereum) {
    window.ethereum.on && window.ethereum.on('accountsChanged', function () { location.reload(); });
    window.ethereum.on && window.ethereum.on('chainChanged', function () { location.reload(); });
  }
  loadState();
})();
