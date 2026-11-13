(() => {
  'use strict';
  // All DOM is built with textContent / createTextNode: server data is never parsed as HTML.
  const h = (tag, props, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const k of kids.flat()) { if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k))); }
    return e;
  };
  const state = { token: sessionStorage.getItem('ll_token'), user: null, accounts: [], selected: null, tab: 'accounts' };

  async function api(path, { method = 'GET', body, key } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    if (key) headers['Idempotency-Key'] = key;
    let res;
    try { res = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
    catch { return { networkError: true }; }
    let data = null; try { data = await res.json(); } catch { /* none */ }
    if (res.status === 401 && path !== '/auth/login') logout();
    return { status: res.status, data, replay: res.headers.get('Idempotent-Replay') === 'true' };
  }

  // Integer paise <-> rupee strings, no floating point anywhere.
  const fmt = (p) => {
    const s = String(p), neg = s.startsWith('-'), d = s.replace('-', '').padStart(3, '0');
    return (neg ? '-' : '') + '\u20B9' + d.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + d.slice(-2);
  };
  const toPaise = (txt) => {
    const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(String(txt).trim());
    if (!m) return null;
    const v = (m[1] + (m[2] || '').padEnd(2, '0')).replace(/^0+(?=\d)/, '');
    return v === '0' ? null : v;
  };

  function logout() { state.token = null; state.user = null; sessionStorage.removeItem('ll_token'); render(); }

  async function boot() {
    if (state.token) {
      const r = await api('/me');
      if (r.status === 200) state.user = r.data.user; else state.token = null;
    }
    await render();
  }

  async function render() {
    const app = document.getElementById('app');
    const who = document.getElementById('who');
    app.replaceChildren(); who.replaceChildren();
    if (!state.user) return app.append(loginView());
    who.append(h('span', { class: 'muted' }, `${state.user.email} (${state.user.role}) `), h('button', { class: 'secondary', onclick: logout }, 'Log out'));
    const tabs = h('div', { class: 'tabs' }, h('button', { class: 'secondary', onclick: () => { state.tab = 'accounts'; render(); } }, 'Accounts'));
    if (state.user.role !== 'holder') tabs.append(h('button', { class: 'secondary', onclick: () => { state.tab = 'oversight'; render(); } }, 'Audit & reconciliation'));
    app.append(tabs);
    if (state.tab === 'oversight' && state.user.role !== 'holder') app.append(...(await oversightView()));
    else app.append(...(await accountsView()));
  }

  function loginView() {
    const msg = h('div', { class: 'msg bad' });
    const email = h('input', { type: 'email', required: 'required', autocomplete: 'username' });
    const pw = h('input', { type: 'password', required: 'required', autocomplete: 'current-password' });
    return h('form', {
      class: 'card', onsubmit: async (e) => {
        e.preventDefault();
        const r = await api('/auth/login', { method: 'POST', body: { email: email.value, password: pw.value } });
        if (r.status !== 200) { msg.textContent = r.networkError ? 'Network error' : r.data.error.message; return; }
        state.token = r.data.token; state.user = r.data.user; sessionStorage.setItem('ll_token', state.token); render();
      },
    }, h('h2', {}, 'Sign in'), h('div', { class: 'row' }, h('label', {}, 'Email', email), h('label', {}, 'Password', pw), h('button', {}, 'Sign in')), msg);
  }

  async function accountsView() {
    const r = await api('/accounts');
    state.accounts = r.data?.accounts || [];
    const real = state.accounts.filter((a) => !a.isSystem);
    const out = [];

    const rows = real.map((a) => h('tr', {},
      h('td', {}, a.id), h('td', {}, a.name), h('td', { class: 'num' }, fmt(a.balance)), h('td', {}, a.status),
      h('td', { class: 'row' },
        h('button', { class: 'secondary', onclick: () => { state.selected = a.id; render(); } }, 'Statement'),
        state.user.role === 'admin' ? h('button', { class: 'secondary', onclick: async () => { await api(`/accounts/${a.id}/${a.status === 'active' ? 'freeze' : 'unfreeze'}`, { method: 'POST' }); render(); } }, a.status === 'active' ? 'Freeze' : 'Unfreeze') : null)));
    out.push(h('div', { class: 'card' }, h('h2', {}, 'Accounts'),
      h('table', {}, h('thead', {}, h('tr', {}, ['ID', 'Name', 'Balance', 'Status', ''].map((x) => h('th', {}, x)))), h('tbody', {}, rows))));

    if (state.user.role === 'holder') {
      out.push(h('div', { class: 'grid2' }, moneyForm('deposit'), moneyForm('withdrawal'), moneyForm('transfer')));
    } else if (state.user.role === 'admin') {
      out.push(h('div', { class: 'grid2' }, moneyForm('deposit'), adminForms()));
    }
    if (state.selected) out.push(await statementView(state.selected));
    return out;
  }

  // Idempotency in the client: a key is bound to the exact request. If the network fails or the server answers 5xx
  // we do NOT know whether it was applied, so pressing submit again re-sends the SAME key (safe). Any definite answer clears it.
  function moneyForm(kind) {
    const mine = state.accounts.filter((a) => !a.isSystem);
    const sel = (name) => h('select', { name, required: 'required' }, mine.map((a) => h('option', { value: a.id }, `#${a.id} ${a.name}`)));
    const amount = h('input', { name: 'amount', inputmode: 'decimal', placeholder: '0.00', required: 'required', size: '10' });
    const msg = h('div', { class: 'msg' });
    const account = sel('account');
    const to = h('input', { name: 'to', inputmode: 'numeric', placeholder: 'account id', required: 'required', size: '10' });
    let pending = null;
    const title = { deposit: 'Deposit', withdrawal: 'Withdraw', transfer: 'Transfer' }[kind];
    return h('form', {
      class: 'card', onsubmit: async (e) => {
        e.preventDefault();
        const paise = toPaise(amount.value);
        if (!paise) { msg.className = 'msg bad'; msg.textContent = 'Enter a positive amount, e.g. 250.00'; return; }
        const body = kind === 'transfer' ? { fromAccountId: account.value, toAccountId: to.value.trim(), amount: paise }
          : { accountId: account.value, amount: paise };
        const fp = JSON.stringify([kind, body]);
        if (!pending || pending.fp !== fp) pending = { fp, key: crypto.randomUUID() };
        const path = { deposit: '/deposits', withdrawal: '/withdrawals', transfer: '/transfers' }[kind];
        const r = await api(path, { method: 'POST', body, key: pending.key });
        if (r.networkError || r.status >= 500) { msg.className = 'msg bad'; msg.textContent = 'No definite answer. Press again to retry safely (same idempotency key).'; return; }
        pending = null;
        if (r.status === 201) { msg.className = 'msg good'; msg.textContent = `Posted transaction #${r.data.transaction.id}${r.replay ? ' (replayed)' : ''}`; amount.value = ''; render(); }
        else { msg.className = 'msg bad'; msg.textContent = r.data?.error?.message || `Error ${r.status}`; }
      },
    }, h('h2', {}, title),
    h('div', { class: 'row' }, h('label', {}, kind === 'transfer' ? 'From' : 'Account', account),
      kind === 'transfer' ? h('label', {}, 'To (id)', to) : null, h('label', {}, 'Amount (\u20B9)', amount), h('button', {}, title)), msg);
  }

  function adminForms() {
    const msg = h('div', { class: 'msg' });
    const name = h('input', { required: 'required', maxlength: '80' });
    const owner = h('input', { type: 'email', placeholder: 'holder email (optional)' });
    const memberAcct = h('input', { inputmode: 'numeric', size: '6', required: 'required' });
    const memberEmail = h('input', { type: 'email', required: 'required' });
    const show = (r) => { msg.className = r.status < 300 ? 'msg good' : 'msg bad'; msg.textContent = r.status < 300 ? 'Done' : (r.data?.error?.message || 'Error'); if (r.status < 300) render(); };
    return h('div', { class: 'card' }, h('h2', {}, 'Admin'),
      h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault(); show(await api('/accounts', { method: 'POST', body: { name: name.value, ownerEmail: owner.value || undefined } })); } },
        h('label', {}, 'New account name', name), h('label', {}, 'Owner', owner), h('button', {}, 'Create')),
      h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault(); show(await api(`/accounts/${encodeURIComponent(memberAcct.value)}/members`, { method: 'POST', body: { email: memberEmail.value } })); } },
        h('label', {}, 'Account id', memberAcct), h('label', {}, 'Add member', memberEmail), h('button', {}, 'Add')), msg);
  }

  async function statementView(id) {
    const r = await api(`/accounts/${id}/statement?limit=100`);
    const e = r.data?.entries || [];
    return h('div', { class: 'card' }, h('h2', {}, `Statement for account #${id}`),
      h('table', {}, h('thead', {}, h('tr', {}, ['Txn', 'When', 'Kind', 'Status', 'Amount', 'Balance after', 'By'].map((x) => h('th', {}, x)))),
        h('tbody', {}, e.map((x) => h('tr', {},
          h('td', {}, x.transactionId), h('td', {}, new Date(x.createdAt).toLocaleString()), h('td', {}, x.kind),
          h('td', { class: x.status === 'refused' ? 'bad' : '' }, x.status === 'refused' ? `refused: ${x.refusalReason}` : 'posted'),
          h('td', { class: 'num' }, fmt(x.amount)), h('td', { class: 'num' }, x.balanceAfter === null ? '\u2014' : fmt(x.balanceAfter)), h('td', {}, x.initiatedBy))))));
  }

  async function oversightView() {
    const [rec, audit, hits] = await Promise.all([api('/reconciliation'), api('/audit?limit=50'), api('/idempotency-hits?limit=50')]);
    const d = rec.data || {};
    return [
      h('div', { class: 'card' }, h('h2', {}, 'Reconciliation'),
        h('p', { class: d.ok ? 'good' : 'bad' }, d.ok ? `Books balance (${d.checkedEntries} entries checked)` : 'PROBLEMS FOUND'),
        h('p', { class: 'muted' }, `Ledger digest: ${d.ledgerDigest || ''}`),
        h('pre', {}, d.problems && d.problems.length ? JSON.stringify(d.problems, null, 2) : '')),
      h('div', { class: 'card' }, h('h2', {}, 'Duplicate requests answered from stored results'),
        h('table', {}, h('thead', {}, h('tr', {}, ['Txn', 'Kind', 'Status', 'Seen', 'Request'].map((x) => h('th', {}, x)))),
          h('tbody', {}, (hits.data?.hits || []).map((x) => h('tr', {}, h('td', {}, x.transaction_id), h('td', {}, x.kind), h('td', {}, x.status), h('td', {}, new Date(x.seen_at).toLocaleString()), h('td', {}, x.request_id)))))),
      h('div', { class: 'card' }, h('h2', {}, 'Audit log (latest 50)'),
        h('table', {}, h('thead', {}, h('tr', {}, ['#', 'When', 'Actor', 'Action', 'Detail'].map((x) => h('th', {}, x)))),
          h('tbody', {}, (audit.data?.events || []).map((x) => h('tr', {}, h('td', {}, x.id), h('td', {}, new Date(x.created_at).toLocaleString()), h('td', {}, x.actor_id ?? '\u2014'), h('td', { class: x.action === 'flag' || x.action === 'denied' ? 'bad' : '' }, x.action), h('td', {}, JSON.stringify(x.detail))))))),
    ];
  }

  boot();
})();
