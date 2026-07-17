/*
 * AskSQL panel - rendering only.
 *
 * This script never sees a credential, never touches a database, and never
 * builds SQL. It posts a question to the extension host and renders what comes
 * back.
 *
 * Every value from the database or the model is written with textContent, never
 * innerHTML. Row data is untrusted by definition (it is whatever is in the
 * user's tables), and a cell containing markup must render as text, not as
 * markup. There is no innerHTML in this file on purpose.
 */

(function () {
  const vscode = acquireVsCodeApi();

  const $log = document.getElementById('log');
  const $empty = document.getElementById('empty');
  const $q = document.getElementById('q');
  const $send = document.getElementById('send');
  const $conn = document.getElementById('conn');

  let turn = null;
  let busy = false;
  /** How many databases are configured, so the picker locks correctly. */
  let connCount = 0;
  /** SQL held back when the user wants results first. Rendered after the result. */
  let pendingSql = null;
  /** In-flight plan requests, mapped to the turn whose button asked for them. */
  const planTurns = new Map();
  let planSeq = 0;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // A copy glyph, built as an SVG element (theme-coloured via currentColor, no innerHTML).
  function copyIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('aria-hidden', 'true');
    for (const [x, y] of [[3, 3], [5.5, 5.5]]) {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', x);
      r.setAttribute('y', y);
      r.setAttribute('width', '7.5');
      r.setAttribute('height', '7.5');
      r.setAttribute('rx', '1.5');
      r.setAttribute('fill', 'none');
      r.setAttribute('stroke', 'currentColor');
      r.setAttribute('stroke-width', '1.2');
      svg.appendChild(r);
    }
    return svg;
  }

  const nearBottom = () => $log.scrollHeight - $log.scrollTop - $log.clientHeight < 80;
  // Soft scroll: follow new content only when the user is already at the bottom,
  // so incoming results do not yank them away from something they scrolled up to read.
  const scroll = () => { if (nearBottom()) $log.scrollTop = $log.scrollHeight; };
  const scrollForce = () => { $log.scrollTop = $log.scrollHeight; };

  /**
   * One button. While a turn runs it IS the cancel button - red, and the only
   * thing you can press. A live "Ask" during processing invites a second
   * question that would silently cancel the first.
   */
  /**
   * Lock the inputs that must not change mid-turn. Switching the database or the
   * model while a question is running would answer against something the user is
   * no longer looking at, so both pickers are frozen until the turn ends. The
   * database picker also stays disabled when there is only one database to pick.
   */
  function applyLock() {
    $q.disabled = busy;
    $conn.disabled = busy || connCount <= 1;
  }

  function setBusy(on) {
    busy = on;
    $send.textContent = on ? 'Cancel' : 'Ask';
    $send.classList.toggle('danger', on);
    $send.title = on ? 'Cancel this question' : 'Ask';
    applyLock();
  }

  /** Drop the transient progress line once real content arrives. */
  function clearProgress() {
    if (!turn) return;
    const p = turn.querySelector('.progress');
    if (p) p.remove();
  }

  /** A result grid. Every cell goes in as textContent - never markup. */
  function renderTable(columns, rows) {
    const wrap = el('div', 'tablewrap');
    const table = el('table');
    const thead = el('thead');
    const hrow = el('tr');
    for (const c of columns) hrow.appendChild(el('th', null, c));
    thead.appendChild(hrow);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const row of rows) {
      const tr = el('tr');
      // null (database NULL) renders as a muted 'null'; an empty string is a real
      // value and renders as an empty cell.
      for (const v of row) tr.appendChild(el('td', v === null ? 'null' : null, v === null ? 'null' : v));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  /** The SQL block, its explanation, and the Open-in-editor action. */
  function renderSql(m) {
    // Capture THIS turn's SQL, connection, and element now, so the buttons act
    // on this turn even after later turns change lastSql or the selected database.
    const sql = m.sql;
    // The host says which connection this SQL ran against; the live dropdown is
    // only a fallback and can be re-pointed by a mid-turn state refresh.
    const connId = m.connectionId || ($conn.value || undefined);
    const myTurn = turn;
    turn.appendChild(el('pre', 'sql', sql));
    if (m.explanation) turn.appendChild(el('div', 'explain', m.explanation));
    if (m.autoLimited) turn.appendChild(el('div', 'note', 'A row limit was added automatically.'));
    const actions = el('div', 'actions');
    const open = el('button', 'secondary', 'Open SQL in editor');
    open.addEventListener('click', () => vscode.postMessage({ type: 'openSql', sql }));
    actions.appendChild(open);
    // A query plan comes from the database, not the model. Asking for one in
    // English cannot work; a button can.
    const plan = el('button', 'secondary', 'Explain plan');
    plan.addEventListener('click', () => {
      const planId = 'plan-' + (++planSeq);
      planTurns.set(planId, myTurn);
      vscode.postMessage({ type: 'plan', sql, connectionId: connId, planId });
    });
    actions.appendChild(plan);
    turn.appendChild(actions);
    if (m.needsApproval) {
      // Echo the host's approvalId so an old turn's buttons cannot approve the
      // current turn's SQL.
      const approvalId = m.approvalId;
      const appr = el('div', 'actions approval');
      const run = el('button', null, 'Run');
      run.addEventListener('click', () => { vscode.postMessage({ type: 'approve', ok: true, approvalId }); appr.remove(); });
      const no = el('button', 'secondary', "Don't run");
      no.addEventListener('click', () => { vscode.postMessage({ type: 'approve', ok: false, approvalId }); appr.remove(); });
      appr.appendChild(run);
      appr.appendChild(no);
      turn.appendChild(appr);
    }
  }

  function newTurn(question, connection) {
    $empty.classList.add('hidden');
    turn = el('div', 'turn');
    turn.appendChild(el('div', 'q', question));
    // With several databases configured, an answer with no attribution is a
    // trap: it reads as if it came from whichever one you had in mind.
    if (connection) turn.appendChild(el('div', 'against', connection));
    $log.appendChild(turn);
    // Cap the log so a long session does not grow the DOM without bound.
    while ($log.children.length > 60) $log.removeChild($log.firstChild);
    scrollForce();
  }

  function ask(text) {
    const q = (text !== undefined ? text : $q.value).trim();
    if (!q || busy) return;
    $q.value = '';
    autosize();
    // Lock immediately, not after the host round-trips 'turnStart' back. Otherwise
    // a fast second Enter fires a second ask that silently cancels the first.
    setBusy(true);
    vscode.postMessage({ type: 'ask', text: q, connectionId: $conn.value || undefined });
  }

  function autosize() {
    $q.style.height = 'auto';
    $q.style.height = Math.min($q.scrollHeight, 128) + 'px';
  }

  // Enter sends, Shift+Enter is a newline. isComposing guards IME input (a Japanese
  // or Chinese composition ends on Enter and must not fire the question).
  $q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      ask();
    }
  });
  // Escape cancels; on window because the textarea is disabled while busy and
  // disabled controls receive no key events.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && busy) {
      e.preventDefault();
      vscode.postMessage({ type: 'stop' });
    }
  });
  $q.addEventListener('input', autosize);
  $send.addEventListener('click', () => {
    if (busy) vscode.postMessage({ type: 'stop' });
    else ask();
  });
  for (const b of document.querySelectorAll('.sample')) {
    b.addEventListener('click', () => ask(b.textContent));
  }

  window.addEventListener('message', (event) => {
    const m = event.data;

    if (m.type === 'state') {
      const keep = $conn.value;
      $conn.replaceChildren();
      if (m.connections.length === 0) {
        // A blank, greyed-out select reads as broken. Say what to do instead.
        const o = el('option', null, 'No databases - use Add Connection');
        o.disabled = true;
        $conn.appendChild(o);
      }
      for (const c of m.connections) {
        const o = el('option', null, c.label || c.name);
        o.value = c.id;
        if (c.title) o.title = c.title;
        $conn.appendChild(o);
      }
      if (keep && m.connections.some((c) => c.id === keep)) $conn.value = keep;
      connCount = m.connections.length;
      // Mirror the selected option's tooltip onto the select, so the endpoint shows
      // on the closed control (native macOS select popups ignore option titles).
      const reflectTitle = () => { $conn.title = ($conn.selectedOptions[0] && $conn.selectedOptions[0].title) || ''; };
      reflectTitle();
      $conn.onchange = reflectTitle;
      applyLock();
      return;
    }

    if (m.type === 'clear') {
      $log.replaceChildren();
      $empty.classList.remove('hidden');
      turn = null;
      planTurns.clear();
      return;
    }

    if (m.type === 'copied') {
      const btn = $log.querySelector('button.iconbtn[data-result="' + m.resultId + '"]');
      if (btn) { btn.classList.add('ok'); setTimeout(() => btn.classList.remove('ok'), 1000); }
      return;
    }

    if (m.type === 'turnStart') {
      pendingSql = null;
      newTurn(m.question, m.connection);
      setBusy(true);
      return;
    }

    if (m.type === 'cancelled') {
      clearProgress();
      if (turn) turn.appendChild(el('div', 'note', 'Cancelled.'));
      return;
    }

    if (m.type === 'turnEnd') {
      clearProgress();
      // Never lose the SQL: if the turn ended before the result rendered it
      // (an error, a refusal, a stop), show it now.
      if (pendingSql && turn) { renderSql(pendingSql); pendingSql = null; }
      // The turn is over: any approval buttons still in the log are stale.
      for (const a of $log.querySelectorAll('.approval')) a.remove();
      setBusy(false);
      $q.focus();
      scroll();
      return;
    }

    if (!turn) return;

    if (m.type === 'progress') {
      // Plan progress renders in the turn whose button was clicked. A planId with
      // no mapping is stale (the conversation was cleared) - drop it, never fall
      // back to the live turn, or a cleared plan attaches to an unrelated question.
      let t = turn;
      if (m.planId) { t = planTurns.get(m.planId); if (!t) return; }
      const p = t.querySelector('.progress');
      if (p) p.remove();
      t.appendChild(el('div', 'progress', m.label));
      scroll();
      return;
    }

    if (m.type === 'sql') {
      clearProgress();
      if (m.placement === 'after') { pendingSql = m; return; }
      renderSql(m);
      scroll();
      return;
    }

    if (m.type === 'notRun') {
      clearProgress();
      turn.appendChild(el('div', 'note', 'Not run. The query is above if you want to inspect it.'));
      scroll();
      return;
    }

    if (m.type === 'result') {
      clearProgress();
      if (m.rowCount === 0) {
        turn.appendChild(el('div', 'note', 'No rows matched.'));
      } else {
        turn.appendChild(renderTable(m.columns, m.rows));
        if (m.note) {
          // A catalog answer: say so, and do not offer CSV of a schema listing.
          turn.appendChild(el('div', 'note', m.note));
        } else {
          const bits = [`${m.rowCount} row${m.rowCount === 1 ? '' : 's'} in ${m.durationMs} ms`];
          if (m.rowCount > m.shown) bits.push(`showing the first ${m.shown}`);
          if (m.truncated) bits.push('truncated by the row cap');
          turn.appendChild(el('div', 'note', bits.join(', ') + '.'));

          const actions = el('div', 'actions');
          // Bind THIS turn's result id, so the buttons act on this turn's rows.
          const rid = m.resultId;
          const copy = el('button', 'secondary iconbtn');
          copy.title = 'Copy table with headers';
          copy.setAttribute('aria-label', 'Copy table with headers');
          copy.dataset.result = rid;
          copy.appendChild(copyIcon());
          // Flash success only on the host's 'copied' ack, not optimistically - a
          // result evicted from memory must not report a copy that did not happen.
          copy.addEventListener('click', () => vscode.postMessage({ type: 'copy', resultId: rid }));
          actions.appendChild(copy);
          // The panel shows only the first rows; this opens every row that came back.
          const openRes = el('button', 'secondary', 'Open results in editor');
          openRes.addEventListener('click', () => vscode.postMessage({ type: 'openResult', resultId: rid }));
          actions.appendChild(openRes);
          const csv = el('button', 'secondary', 'Export CSV');
          csv.addEventListener('click', () => vscode.postMessage({ type: 'exportCsv', resultId: rid }));
          actions.appendChild(csv);
          turn.appendChild(actions);
        }
      }
      if (pendingSql) { renderSql(pendingSql); pendingSql = null; }
      scroll();
      return;
    }

    if (m.type === 'plan') {
      // Render into the turn whose button was clicked. A stale planId (conversation
      // cleared) is dropped, not attached to the current turn.
      let t = turn;
      if (m.planId) { t = planTurns.get(m.planId); planTurns.delete(m.planId); if (!t) return; }
      const p = t.querySelector('.progress');
      if (p) p.remove();
      t.appendChild(el('div', 'note', 'Query plan, straight from the database:'));
      t.appendChild(renderTable(m.columns, m.rows));
      if (m.rowCount > m.shown) t.appendChild(el('div', 'note', `Plan has ${m.rowCount} lines, showing the first ${m.shown}.`));
      scroll();
      return;
    }

    // A plan failure belongs to the turn that asked for the plan, and must not
    // flush pendingSql - that SQL belongs to the live turn.
    if (m.type === 'error' && m.planId) {
      const t = planTurns.get(m.planId);
      planTurns.delete(m.planId);
      if (!t) return;
      const p = t.querySelector('.progress');
      if (p) p.remove();
      t.appendChild(el('div', 'err', m.message));
      scroll();
      return;
    }

    if (m.type === 'error') {
      clearProgress();
      // Show the query that failed above the failure, not below it.
      if (pendingSql) { renderSql(pendingSql); pendingSql = null; }
      const box = el('div', m.guard ? 'err guard' : 'err', m.message);
      turn.appendChild(box);
      if (m.guard) {
        turn.appendChild(el('div', 'note', 'AskSQL only runs read-only queries, so this was refused before it reached the database.'));
      }
      if (m.suggestedSql) {
        turn.appendChild(el('div', 'note', 'A corrected query is suggested:'));
        turn.appendChild(el('pre', 'sql', m.suggestedSql));
        const acts = el('div', 'actions');
        const open = el('button', 'secondary', 'Open SQL in editor');
        const sql = m.suggestedSql;
        open.addEventListener('click', () => vscode.postMessage({ type: 'openSql', sql }));
        acts.appendChild(open);
        turn.appendChild(acts);
      }
      if (m.action) {
        const actions = el('div', 'actions');
        const b = el('button', null, m.actionLabel || 'Fix this');
        b.addEventListener('click', () => vscode.postMessage({ type: 'command', id: m.action }));
        actions.appendChild(b);
        turn.appendChild(actions);
      }
      scroll();
    }
  });

  vscode.postMessage({ type: 'ready' });
  $q.focus();
})();
