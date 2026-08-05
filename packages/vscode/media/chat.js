/*
 * AskSQL panel - rendering only. It posts questions to the extension host and
 * renders what comes back; it never sees a credential or builds SQL.
 *
 * Invariant: no innerHTML here - every value goes in via textContent.
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
  /** The last rendered query block and its turn, so a corrected query can replace it. */
  let lastSqlBlock = null;
  /** In-flight plan requests, mapped to the turn whose button asked for them. */
  const planTurns = new Map();
  let planSeq = 0;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // Inline markdown (**bold**, __bold__, `code`) as DOM nodes appended via textContent, never innerHTML.
  function mdInline(parent, text) {
    const re = /\*\*(.+?)\*\*|(?<!\w)__(.+?)__(?!\w)|`([^`]+)`/gsu;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[3] !== undefined) parent.appendChild(el('code', null, m[3]));
      else parent.appendChild(el('b', null, m[1] !== undefined ? m[1] : m[2]));
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  // A block of explanation text: strip a leading "Explanation:", render "- "/"* " lines as bullets.
  function renderMarkdown(cls, text) {
    const box = el('div', cls);
    const body = text.replace(/^\s*(\*\*|__)?\s*Explanation\s*(\*\*|__)?\s*:\s*/iu, '');
    const lines = body.split('\n');
    let i = 0;
    while (i < lines.length) {
      // Fenced code block (```sql ... ```): render as a <pre>, not literal backticks.
      if (/^\s*```/u.test(lines[i])) {
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```/u.test(lines[i])) code.push(lines[i++]);
        i++; // skip the closing fence
        const pre = el('pre', 'md-code');
        pre.textContent = code.join('\n');
        box.appendChild(pre);
        continue;
      }
      const bullet = /^\s*[-*]\s+/u.test(lines[i]);
      const row = el('div', bullet ? 'md-bullet' : null);
      mdInline(row, bullet ? lines[i].replace(/^\s*[-*]\s+/u, '') : lines[i]);
      box.appendChild(row);
      i++;
    }
    return box;
  }

  // A copy glyph, built as an SVG element (theme-coloured via currentColor, no innerHTML).
  function copyIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('aria-hidden', 'true');
    for (const [x, y] of [
      [3, 3],
      [5.5, 5.5],
    ]) {
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
  // Soft scroll: follow new content only when the user is already at the bottom.
  const scroll = () => {
    if (nearBottom()) $log.scrollTop = $log.scrollHeight;
  };
  const scrollForce = () => {
    $log.scrollTop = $log.scrollHeight;
  };

  // The textarea stays editable during a turn; the picker freezes so a switch cannot re-target the answer.
  function applyLock() {
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
    for (const c of columns) {
      const th = el('th', null, c);
      th.setAttribute('scope', 'col');
      hrow.appendChild(th);
    }
    thead.appendChild(hrow);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const row of rows) {
      const tr = el('tr');
      // null (database NULL) renders as a muted 'null'; an empty string renders as an empty cell.
      for (const v of row) tr.appendChild(el('td', v === null ? 'null' : null, v === null ? 'null' : v));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  // --- Chart ------------------------------------------------------------
  // Same rule as the React package's chart.ts: a label plus a numeric column is a bar, a date label a line.

  const CHART_MAX_ROWS = 50;
  const CHART_MAX_SERIES = 4;

  const asNumber = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v));
    return Number.isFinite(n) ? n : null;
  };

  // totalRows is the result's real size; the host sends only the first INLINE_ROWS.
  function inferChart(columns, kinds, rows, totalRows) {
    const size = typeof totalRows === 'number' ? totalRows : rows.length;
    if (!rows.length || columns.length < 2 || size > CHART_MAX_ROWS) return null;
    const numeric = [];
    for (let i = 0; i < columns.length; i++) {
      const kind = kinds && kinds[i];
      if (kind === 'number' || kind === 'bigint' || kind === 'decimal') {
        numeric.push(i);
        continue;
      }
      // A driver reporting NUMERIC as text still charts, as long as the values parse.
      const sample = rows.slice(0, 20);
      const seen = sample.some((r) => r[i] !== null && asNumber(r[i]) !== null);
      if (seen && sample.every((r) => r[i] === null || asNumber(r[i]) !== null)) numeric.push(i);
    }
    if (!numeric.length) return null;
    let labelIdx = columns.findIndex((_, i) => !numeric.includes(i));
    if (labelIdx === -1) labelIdx = 0;
    const valueIdx = numeric.filter((i) => i !== labelIdx);
    if (!valueIdx.length) return null;
    const labelKind = kinds && kinds[labelIdx];
    return {
      kind: labelKind === 'date' || labelKind === 'timestamp' ? 'line' : 'bar',
      series: valueIdx.slice(0, CHART_MAX_SERIES).map((ci) => ({
        name: columns[ci],
        points: rows.map((r) => ({
          label: r[labelIdx] === null ? '∅' : String(r[labelIdx]),
          value: asNumber(r[ci]) ?? 0,
        })),
      })),
    };
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) n.setAttribute(k, String(attrs[k]));
    return n;
  };

  /** Inline SVG rather than a charting library: the webview ships no dependencies and loads no CDN. */
  function renderChart(spec) {
    const width = 460;
    const height = 220;
    const left = 44;
    const bottom = height - 28;
    const top = spec.series.length > 1 ? 22 : 8;
    const right = width - 8;
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart', role: 'img' });

    const values = spec.series.flatMap((s) => s.points.map((p) => p.value));
    const upper = Math.max(0, ...values);
    const lower = Math.min(0, ...values);
    const span = upper - lower || 1;
    const yFor = (v) => bottom - ((v - lower) / span) * (bottom - top);

    // The axis includes zero: a floating baseline makes a 2% difference look like tenfold.
    for (let t = 0; t <= 4; t++) {
      const value = lower + (span * t) / 4;
      const y = yFor(value);
      svg.appendChild(svgEl('line', { x1: left, y1: y, x2: right, y2: y, class: 'chart-grid' }));
      const text = svgEl('text', { x: left - 6, y: y + 4, class: 'chart-tick', 'text-anchor': 'end' });
      text.textContent = span >= 10 ? String(Math.round(value)) : String(Math.round(value * 100) / 100);
      svg.appendChild(text);
    }

    const points = spec.series[0].points.length;
    if (spec.kind === 'bar') {
      const slot = (right - left) / points;
      const group = slot * 0.72;
      const barWidth = Math.max(1, group / spec.series.length);
      const zero = yFor(0);
      spec.series.forEach((series, si) => {
        series.points.forEach((p, pi) => {
          const y = yFor(p.value);
          const bar = svgEl('rect', {
            x: left + slot * pi + (slot - group) / 2 + barWidth * si,
            y: Math.min(y, zero),
            width: Math.max(1, barWidth - 1),
            // A zero-height bar reads as missing data rather than as a zero.
            height: Math.max(1, Math.abs(y - zero)),
            class: `chart-s${si % CHART_MAX_SERIES}`,
          });
          bar.appendChild(svgEl('title')).textContent = `${p.label}: ${p.value}`;
          svg.appendChild(bar);
        });
      });
    } else {
      const step = points === 1 ? 0 : (right - left) / (points - 1);
      spec.series.forEach((series, si) => {
        const d = series.points.map((p, pi) => `${pi ? 'L' : 'M'}${left + step * pi} ${yFor(p.value)}`).join(' ');
        svg.appendChild(svgEl('path', { d, fill: 'none', class: `chart-line chart-stroke${si % CHART_MAX_SERIES}` }));
        series.points.forEach((p, pi) => {
          const dot = svgEl('circle', {
            cx: left + step * pi,
            cy: yFor(p.value),
            r: 2.5,
            class: `chart-s${si % CHART_MAX_SERIES}`,
          });
          dot.appendChild(svgEl('title')).textContent = `${p.label}: ${p.value}`;
          svg.appendChild(dot);
        });
      });
    }

    // Labels are drawn only while they fit; past that every nth, because crowded text reads as noise.
    const slot = (right - left) / points;
    const stride = Math.max(1, Math.ceil(46 / slot));
    spec.series[0].points.forEach((p, pi) => {
      if (pi % stride !== 0) return;
      const x =
        spec.kind === 'bar'
          ? left + slot * pi + slot / 2
          : left + (points === 1 ? 0 : ((right - left) / (points - 1)) * pi);
      const text = svgEl('text', { x, y: bottom + 14, class: 'chart-tick', 'text-anchor': 'middle' });
      text.textContent = p.label.length > 10 ? p.label.slice(0, 9) + '…' : p.label;
      svg.appendChild(text);
    });

    if (spec.series.length > 1) {
      let x = left;
      spec.series.forEach((series, si) => {
        svg.appendChild(svgEl('rect', { x, y: 6, width: 8, height: 8, class: `chart-s${si % CHART_MAX_SERIES}` }));
        const text = svgEl('text', { x: x + 12, y: 14, class: 'chart-tick' });
        text.textContent = series.name;
        svg.appendChild(text);
        x += 12 + series.name.length * 6 + 12;
      });
    }

    const wrap = el('div', 'chartwrap');
    wrap.appendChild(svg);
    return wrap;
  }

  /** The SQL block, its explanation, and the Open-in-editor action. */
  function renderSql(m) {
    // Capture this turn's SQL, connection, and element now, so the buttons act on this turn.
    const sql = m.sql;
    // The host says which connection this SQL ran against; the live dropdown is only a fallback.
    const connId = m.connectionId || $conn.value || undefined;
    const myTurn = turn;
    // One element for the whole query block, so a later correction can replace it wholesale.
    const block = el('div', 'sqlblock');
    turn.appendChild(block);
    lastSqlBlock = { turn: myTurn, el: block };
    block.appendChild(el('pre', 'sql', sql));
    if (m.explanation) block.appendChild(renderMarkdown('explain', m.explanation));
    if (m.autoLimited) block.appendChild(el('div', 'note', 'A row limit was added automatically.'));
    const actions = el('div', 'actions');
    const open = el('button', 'secondary', 'Open SQL in editor');
    open.addEventListener('click', () => vscode.postMessage({ type: 'openSql', sql }));
    actions.appendChild(open);
    // A query plan comes from the database, not the model, so it is a button rather than a question.
    const plan = el('button', 'secondary', 'Explain plan');
    plan.addEventListener('click', () => {
      const planId = 'plan-' + ++planSeq;
      planTurns.set(planId, myTurn);
      vscode.postMessage({ type: 'plan', sql, connectionId: connId, planId });
    });
    actions.appendChild(plan);
    block.appendChild(actions);
    if (m.needsApproval) {
      // Echo the host's approvalId so an old turn's buttons cannot approve the current turn's SQL.
      const approvalId = m.approvalId;
      const appr = el('div', 'actions approval');
      const run = el('button', null, 'Run');
      run.addEventListener('click', () => {
        vscode.postMessage({ type: 'approve', ok: true, approvalId });
        appr.remove();
      });
      const no = el('button', 'secondary', "Don't run");
      no.addEventListener('click', () => {
        vscode.postMessage({ type: 'approve', ok: false, approvalId });
        appr.remove();
      });
      appr.appendChild(run);
      appr.appendChild(no);
      block.appendChild(appr);
    }
  }

  function newTurn(question, connection) {
    $empty.classList.add('hidden');
    turn = el('div', 'turn');
    turn.appendChild(el('div', 'role', 'You'));
    turn.appendChild(el('div', 'q', question));
    // With several databases configured, attribute the answer to its connection.
    if (connection) turn.appendChild(el('div', 'against', connection));
    // Everything appended after this (SQL, result, explanation) is the answer.
    turn.appendChild(el('div', 'role assistant', 'AskSQL'));
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
    // Lock immediately, not after the host round-trips 'turnStart' back.
    setBusy(true);
    vscode.postMessage({ type: 'ask', text: q, connectionId: $conn.value || undefined });
  }

  function autosize() {
    $q.style.height = 'auto';
    $q.style.height = Math.min($q.scrollHeight, 128) + 'px';
  }

  // Enter sends, Shift+Enter is a newline, isComposing guards IME input; a running turn swallows Enter.
  $q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!busy) ask();
    }
  });
  // Escape cancels a running turn from anywhere in the panel.
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
      // Mirror the selected option's tooltip onto the select (native macOS popups ignore option titles).
      const reflectTitle = () => {
        $conn.title = ($conn.selectedOptions[0] && $conn.selectedOptions[0].title) || '';
      };
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
      if (btn) {
        btn.classList.add('ok');
        setTimeout(() => btn.classList.remove('ok'), 1000);
      }
      return;
    }

    if (m.type === 'prefill') {
      $q.value = String(m.text ?? '');
      $q.focus();
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
      // Never lose the SQL: show it now if the turn ended before the result rendered it.
      if (pendingSql && turn) {
        renderSql(pendingSql);
        pendingSql = null;
      }
      // The turn is over: any approval buttons still in the log are stale.
      for (const a of $log.querySelectorAll('.approval')) a.remove();
      setBusy(false);
      $q.focus();
      scroll();
      return;
    }

    if (!turn) return;

    if (m.type === 'progress') {
      // Plan progress renders in the turn whose button was clicked; a stale planId is dropped, never re-homed.
      let t = turn;
      if (m.planId) {
        t = planTurns.get(m.planId);
        if (!t) return;
      }
      const p = t.querySelector('.progress');
      if (p) p.remove();
      t.appendChild(el('div', 'progress', m.label));
      scroll();
      return;
    }

    if (m.type === 'sql') {
      clearProgress();
      if (m.placement === 'after') {
        pendingSql = m;
        return;
      }
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
        const tableEl = renderTable(m.columns, m.rows);
        turn.appendChild(tableEl);
        // Table stays the default; the button only appears when inferChart finds something to draw.
        let chartSpec = inferChart(m.columns, m.columnKinds, m.rows, m.rowCount);
        let chartEl = null;
        if (m.warnings) for (const w of m.warnings) turn.appendChild(el('div', 'warn', w));
        if (m.note) {
          // A catalog answer: say so, and do not offer CSV of a schema listing.
          turn.appendChild(el('div', 'note', m.note));
        } else {
          const bits = [`${m.rowCount} row${m.rowCount === 1 ? '' : 's'} in ${m.durationMs} ms`];
          if (m.rowCount > m.shown) bits.push(`showing the first ${m.shown}`);
          if (m.truncated) bits.push('truncated by the row cap');
          turn.appendChild(el('div', 'note', bits.join(', ') + '.'));

          const actions = el('div', 'actions');
          // Bind this turn's result id, so the buttons act on this turn's rows.
          const rid = m.resultId;
          const copy = el('button', 'secondary iconbtn');
          copy.title = 'Copy table with headers';
          copy.setAttribute('aria-label', 'Copy table with headers');
          copy.dataset.result = rid;
          copy.appendChild(copyIcon());
          // Flash success only on the host's 'copied' ack, never optimistically.
          copy.addEventListener('click', () => vscode.postMessage({ type: 'copy', resultId: rid }));
          actions.appendChild(copy);
          // The panel shows only the first rows; this opens every row that came back.
          const openRes = el('button', 'secondary', 'Open results in editor');
          openRes.addEventListener('click', () => vscode.postMessage({ type: 'openResult', resultId: rid }));
          actions.appendChild(openRes);
          const csv = el('button', 'secondary', 'Export CSV');
          csv.addEventListener('click', () => vscode.postMessage({ type: 'exportCsv', resultId: rid }));
          actions.appendChild(csv);
          if (chartSpec) {
            const toggle = el('button', 'secondary', 'Chart');
            toggle.addEventListener('click', () => {
              const showChart = toggle.textContent === 'Chart';
              if (showChart) {
                if (!chartEl) chartEl = renderChart(chartSpec);
                tableEl.replaceWith(chartEl);
              } else {
                chartEl.replaceWith(tableEl);
              }
              toggle.textContent = showChart ? 'Table' : 'Chart';
            });
            actions.appendChild(toggle);
          }
          turn.appendChild(actions);
        }
      }
      if (pendingSql) {
        renderSql(pendingSql);
        pendingSql = null;
      }
      scroll();
      return;
    }

    if (m.type === 'plan') {
      // Render into the turn whose button was clicked; a stale planId is dropped.
      let t = turn;
      if (m.planId) {
        t = planTurns.get(m.planId);
        planTurns.delete(m.planId);
        if (!t) return;
      }
      const p = t.querySelector('.progress');
      if (p) p.remove();
      t.appendChild(el('div', 'note', 'Query plan, straight from the database:'));
      t.appendChild(renderTable(m.columns, m.rows));
      if (m.rowCount > m.shown)
        t.appendChild(el('div', 'note', `Plan has ${m.rowCount} lines, showing the first ${m.shown}.`));
      scroll();
      return;
    }

    if (m.type === 'schemaAnswer') {
      clearProgress();
      turn.appendChild(renderMarkdown('explain', m.answer));
      if (m.unknownReferences && m.unknownReferences.length) {
        const names = m.unknownReferences.join(', ');
        turn.appendChild(
          el(
            'div',
            'note',
            m.isSchemaChange
              ? 'Proposed names not in your current schema: ' + names + '. AskSQL is read-only and ran nothing.'
              : 'Heads up: this mentioned names not in your schema (' + names + '), so treat those with caution.',
          ),
        );
      }
      // The query in a prose answer is the same artifact as a generated one, so it gets the same action.
      if (m.proposedSql) {
        const actions = el('div', 'actions');
        const open = el('button', 'secondary', 'Open SQL in editor');
        open.addEventListener('click', () => vscode.postMessage({ type: 'openSql', sql: m.proposedSql }));
        actions.appendChild(open);
        turn.appendChild(actions);
      }
      turn.appendChild(
        el('div', 'note', 'Generated from your schema by the model - no query was run, so treat it as guidance.'),
      );
      scroll();
      return;
    }

    // A plan failure belongs to the turn that asked for the plan, and must not flush pendingSql.
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
      // A correction replaces the rejected query; without one, the failed query is shown above the error.
      if (m.suggestedSql) {
        pendingSql = null;
        if (lastSqlBlock && lastSqlBlock.turn === turn) lastSqlBlock.el.remove();
      } else if (pendingSql) {
        renderSql(pendingSql);
        pendingSql = null;
      }
      lastSqlBlock = null;
      const box = el('div', m.guard ? 'err guard' : 'err', m.message);
      turn.appendChild(box);
      if (m.guard) {
        turn.appendChild(
          el('div', 'note', 'AskSQL only runs read-only queries, so this was refused before it reached the database.'),
        );
      }
      if (m.suggestedSql) {
        turn.appendChild(el('div', 'note', 'Corrected to match your schema:'));
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
