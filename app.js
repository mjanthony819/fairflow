/* FairFlow UI wiring. Runs only in the browser; engine lives in solver.js + model.js. */
(function () {
  'use strict';
  const model = window.FairFlowModel;
  const scenarios = window.FairFlowScenarios;
  const plan = window.FairFlowPlan;

  const state = {
    scenario: scenarios.clone(scenarios.list[0]),
    customs: [],
    weight: 2,
    solution: null,
    comparison: null,
    overlap: { conflicts: [], unchecked: [] },
  };

  const STORE_KEY = 'fairflow.v1';
  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        v: 1,
        weight: state.weight,
        currentId: state.scenario.id,
        current: state.scenario,
        customs: state.customs,
      }));
    } catch (e) { /* storage unavailable: the app still works for the session */ }
  }
  function restore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  const safeId = (s) => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,60}$/.test(s);
  function isCustom(sc) { return state.customs.some((c) => c.id === sc.id); }
  function uniqueRosterId(base) {
    const taken = {};
    scenarios.list.forEach((s) => { taken[s.id] = true; });
    state.customs.forEach((s) => { taken[s.id] = true; });
    return plan.slugify(base, taken);
  }
  function refreshScenarioOptions() {
    const sel = $('#scenario-select');
    let html = scenarios.list.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join('');
    if (state.customs.length) {
      html += '<optgroup label="My rosters">' +
        state.customs.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join('') + '</optgroup>';
    }
    sel.innerHTML = html;
    sel.value = state.scenario.id;
  }

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pct = (x) => Math.round(x * 100) + '%';

  function resolve() {
    state.solution = model.solve(state.scenario, { fairnessWeight: state.weight });
    state.comparison = null; // computed lazily on the compare tab
  }

  /* ---------- text builders shared by board / audit ---------- */
  function explainUnfilled(u) {
    const parts = [];
    parts.push(`${u.shift.name} (${u.shift.slot}) is short ${u.missing} of ${u.shift.capacity} seat${u.shift.capacity > 1 ? 's' : ''}.`);
    if (u.candidateCount === 0) {
      parts.push(`Nobody is both qualified as ${u.shift.role} and marked available for this slot.`);
    } else {
      const bits = [];
      if (u.atLimit.length > 0) {
        bits.push(`${u.atLimit.map((v) => `${v.name} (${v.load}/${v.maxShifts})`).join(', ')} ${u.atLimit.length === 1 ? 'is' : 'are'} already at ${u.atLimit.length === 1 ? 'a personal' : 'their'} shift limit${u.atLimit.length === 1 ? '' : 's'}`);
      }
      if (u.alreadyHere.length > 0) {
        bits.push(`${u.alreadyHere.map((v) => v.name).join(', ')} already hold${u.alreadyHere.length === 1 ? 's' : ''} a seat on this shift — one person can hold only one`);
      }
      parts.push(`Only ${u.candidateCount} volunteer${u.candidateCount === 1 ? '' : 's'} ${u.candidateCount === 1 ? 'is' : 'are'} qualified and available here: ${bits.join('; ')}.`);
    }
    let reco;
    if (u.candidateCount === 0) {
      reco = `Recruit or mark availability for ${u.missing} more ${u.shift.role} volunteer${u.missing === 1 ? '' : 's'} on this slot.`;
    } else if (u.atLimit.length > 0) {
      reco = `Raise ${u.atLimit[0].name.split(' ')[0]}'s limit by ${u.missing}, or add ${u.missing} more ${u.shift.role} volunteer${u.missing === 1 ? '' : 's'} for this slot, to fill it.`;
    } else {
      reco = `Add ${u.missing} more ${u.shift.role} volunteer${u.missing === 1 ? '' : 's'} for this slot to fill it.`;
    }
    return { text: parts.join(' '), reco };
  }

  function cutSummary(sol) {
    const items = [];
    const byVol = {};
    const byShift = {};
    for (const arc of sol.cutArcs) {
      if (arc.tag && arc.tag.type === 'limit') {
        byVol[arc.tag.vol] = true;
      } else if (arc.tag && arc.tag.type === 'seat') {
        byShift[arc.tag.shift] = true;
      }
    }
    const volsAtLimit = Object.keys(byVol).map((id) => sol.volById[id]).filter(Boolean);
    const fullShifts = Object.keys(byShift).map((id) => sol.shiftById[id]).filter(Boolean);
    if (volsAtLimit.length > 0) {
      items.push({
        title: `${volsAtLimit.length} shift limit${volsAtLimit.length === 1 ? '' : 's'} binding`,
        body: `The minimum cut passes through the personal limits of ${volsAtLimit.map((v) => `${esc(v.name)} (${sol.loads[v.id]}/${v.maxShifts})`).join(', ')}. These caps are what stop more seats from filling.`,
      });
    }
    if (fullShifts.length > 0) {
      items.push({
        title: `${fullShifts.length} shift${fullShifts.length === 1 ? '' : 's'} completely full`,
        body: `${fullShifts.map((s) => esc(s.name)).join(', ')} — every seat taken, no slack left.`,
      });
    }
    if (items.length === 0) {
      items.push({ title: 'No binding bottleneck', body: 'The cut is not pressing on any personal limit: current data leaves real slack.' });
    }
    return items;
  }

  /* ---------- board ---------- */
  function overlapWarnings() {
    const out = [];
    const o = state.overlap;
    if (o.conflicts.length) {
      out.push(`<div class="conflict-card" data-testid="conflict-warnings"><h4>⚠ Time conflict warning (heuristic)</h4>` +
        o.conflicts.map((c) => `<div class="conflict-item" data-testid="conflict-item"><strong>${esc(c.volName)}</strong> is assigned to <strong>${esc(c.a.name)}</strong> (${esc(c.a.slot)}) and <strong>${esc(c.b.name)}</strong> (${esc(c.b.slot)}), whose times overlap. The solver treats times as plain labels and does not prevent clashes — reassign one of these if the times are right.</div>`).join('') +
        `</div>`);
    }
    if (o.unchecked.length) {
      out.push(`<div class="conflict-card unchecked" data-testid="conflict-unchecked"><h4>Some assignments could not be checked for clashes</h4>` +
        o.unchecked.map((c) => `<div class="conflict-item" data-testid="unchecked-item"><strong>${esc(c.volName)}</strong>: ${esc(c.a.name)} (${esc(c.a.slot)}) × ${esc(c.b.name)} (${esc(c.b.slot)}) — ${esc(c.reason)}.</div>`).join('') +
        `<div class="conflict-item">No warning above does not mean no clash: these pairs need a manual check.</div></div>`);
    }
    return out.join('');
  }

  function renderBoard() {
    const sol = state.solution;
    const m = model.metrics(sol);
    state.overlap = plan.overlapCheck(state.scenario, sol.assignments);

    $('#conflicts').innerHTML = overlapWarnings();

    $('#summary-strip').innerHTML = [
      `<div class="stat"><span class="num">${m.filled}/${m.totalSeats}</span><span class="lbl">seats filled (${pct(m.fillRate)})</span></div>`,
      `<div class="stat"><span class="num${m.unfilledCount ? ' warn' : ''}">${m.unfilledCount}</span><span class="lbl">seats unfilled</span></div>`,
      `<div class="stat"><span class="num">${pct(m.preferredRate)}</span><span class="lbl">of assignments preferred</span></div>`,
      `<div class="stat"><span class="num">${m.minLoad}–${m.maxLoad}</span><span class="lbl">shifts per person (Gini ${m.gini.toFixed(2)})</span></div>`,
    ].join('');

    const assignedByShift = {};
    for (const a of sol.assignments) {
      if (!assignedByShift[a.shift]) assignedByShift[a.shift] = [];
      assignedByShift[a.shift].push(a);
    }
    $('#roster').innerHTML = state.scenario.shifts.map((sh) => {
      const got = sol.fill[sh.id];
      const missing = sh.capacity - got;
      const chips = [];
      (assignedByShift[sh.id] || []).forEach((a) => {
        const v = sol.volById[a.vol];
        chips.push(`<span class="chip${a.pref === 'preferred' ? ' pref' : ''}" data-testid="chip-${sh.id}-${a.vol}">${a.pref === 'preferred' ? '<span class="star">★</span> ' : ''}${esc(v.name)}</span>`);
      });
      for (let i = 0; i < missing; i++) chips.push('<span class="chip empty">open seat</span>');
      return `<div class="shift-card${missing ? ' short' : ''}" data-testid="shift-${sh.id}">
        <div class="shift-head"><h3>${esc(sh.name)}</h3><span class="role-tag">${esc(sh.role)}</span></div>
        <div class="shift-meta">${esc(sh.slot)} · ${got}/${sh.capacity} filled</div>
        <div class="fillbar${missing ? ' short' : ''}"><span style="width:${pct(got / sh.capacity)}"></span></div>
        <div class="chips">${chips.join('')}</div>
      </div>`;
    }).join('');

    if (sol.unfilled.length === 0) {
      $('#unfilled').innerHTML = '<div class="all-filled" data-testid="all-filled">Every seat is filled. The solver still checked: no qualified volunteer is idle against a seat they could take.</div>';
    } else {
      $('#unfilled').innerHTML = sol.unfilled.map((u) => {
        const e = explainUnfilled(u);
        return `<div class="unfilled-card" data-testid="unfilled-${u.shift.id}"><h4>${esc(u.shift.name)} — ${u.missing} open</h4><div>${esc(e.text)}</div><div class="reco">${esc(e.reco)}</div></div>`;
      }).join('');
    }

    $('#loads').innerHTML = state.scenario.volunteers.map((v) => {
      const load = sol.loads[v.id];
      const at = load >= v.maxShifts && v.maxShifts > 0;
      return `<div class="load-row${at ? ' atlimit' : ''}" data-testid="load-${v.id}"><span>${esc(v.name)}</span><span class="bar"><span style="width:${v.maxShifts ? pct(load / Math.max(v.maxShifts, 1)) : '0%'}"></span></span><span class="count">${load}/${v.maxShifts}</span></div>`;
    }).join('');
  }

  /* ---------- edit ---------- */
  function renderEdit() {
    const sc = state.scenario;
    $('#people-table tbody').innerHTML = sc.volunteers.map((v, i) => `<tr>
      <td><input data-field="name" data-idx="${i}" value="${esc(v.name)}"></td>
      <td><input data-field="roles" data-idx="${i}" value="${esc(v.roles.join(', '))}"></td>
      <td><input data-field="maxShifts" data-idx="${i}" type="number" min="1" max="10" value="${v.maxShifts}"></td>
      <td><button class="row-del" data-del-person="${i}" title="Remove">×</button></td>
    </tr>`).join('');
    $('#shifts-table tbody').innerHTML = sc.shifts.map((s, i) => `<tr>
      <td><input data-sfield="name" data-idx="${i}" value="${esc(s.name)}"></td>
      <td><input data-sfield="slot" data-idx="${i}" value="${esc(s.slot)}"></td>
      <td><input data-sfield="role" data-idx="${i}" value="${esc(s.role)}"></td>
      <td><input data-sfield="capacity" data-idx="${i}" type="number" min="1" max="12" value="${s.capacity}"></td>
      <td><button class="row-del" data-del-shift="${i}" title="Remove">×</button></td>
    </tr>`).join('');

    let html = '<div class="matrix-wrap"><table class="matrix" data-testid="matrix-table"><thead><tr><th></th>';
    for (const s of sc.shifts) html += `<th>${esc(s.name)}<span class="slot">${esc(s.role)}</span></th>`;
    html += '</tr></thead><tbody>';
    sc.volunteers.forEach((v) => {
      html += `<tr><td class="name">${esc(v.name)} <span style="color:var(--ink-soft)">(${esc(v.roles.join(', '))})</span></td>`;
      sc.shifts.forEach((s) => {
        const qualified = v.roles.indexOf(s.role) !== -1;
        if (!qualified) {
          html += '<td><button class="cell na" data-testid="cell-na" tabindex="-1" title="Not qualified for this role" disabled>·</button></td>';
        } else {
          const av = model.availabilityOf(sc, v.id, s.id);
          const mark = av === 'preferred' ? '★' : av === 'available' ? '✓' : '·';
          html += `<td><button class="cell ${av}" data-cell="${v.id}|${s.id}" data-testid="cell-${v.id}-${s.id}" data-state="${av}" title="${v.name} × ${s.name}: ${av}">${mark}</button></td>`;
        }
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    $('#matrix').innerHTML = html;
  }

  /* ---------- compare ---------- */
  function renderCompare() {
    if (!state.comparison) state.comparison = model.compare(state.scenario, Math.max(1, state.weight));
    const { pref, fair } = state.comparison;
    const rows = [
      ['Seats filled', (m) => `${m.filled}/${m.totalSeats}`],
      ['Assignments on preferred slots', (m) => `${m.preferred} (${pct(m.preferredRate)})`],
      ['Lightest personal load', (m) => String(m.minLoad)],
      ['Heaviest personal load', (m) => String(m.maxLoad)],
      ['Load spread (std dev)', (m) => m.loadStdev.toFixed(2)],
      ['Load inequality (Gini)', (m) => m.gini.toFixed(2)],
      ['People at their limit', (m) => String(m.atLimit)],
      ['Total cost of the plan', (m, s) => String(s.cost)],
    ];
    const head = `<tr><th>Measure</th><th>Preference run (weight 0)</th><th>Fairness run (weight ${Math.max(1, state.weight)})</th></tr>`;
    const body = rows.map(([label, fn]) => {
      const a = fn(pref.metrics, pref.solution);
      const b = fn(fair.metrics, fair.solution);
      return `<tr data-testid="cmp-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}"><td>${label}</td><td class="num">${a}</td><td class="num">${b}</td></tr>`;
    }).join('');
    const moved = fair.solution.assignments.filter((a) => !pref.solution.assignments.some((b) => b.vol === a.vol && b.shift === a.shift));
    const prefDelta = pref.metrics.preferred - fair.metrics.preferred;
    const priceText = prefDelta > 0
      ? `the price is ${prefDelta} fewer preferred-slot assignment${prefDelta === 1 ? '' : 's'}`
      : prefDelta < 0
        ? `and it even gains ${-prefDelta} preferred-slot assignment${-prefDelta === 1 ? '' : 's'}`
        : 'at no cost in preferred-slot assignments';
    const gA = pref.metrics.gini.toFixed(2), gB = fair.metrics.gini.toFixed(2);
    const giniText = fair.metrics.gini < pref.metrics.gini
      ? `Gini falls from ${gA} to ${gB}, a visibly more even spread`
      : fair.metrics.gini > pref.metrics.gini
        ? `Gini rises from ${gA} to ${gB} on this data - the fairness cost encourages spreading but does not guarantee a more even spread in every instance`
        : `Gini unchanged at ${gA}`;
    $('#compare').innerHTML = `<table class="compare-table" data-testid="compare-table">${head}${body}</table>
      <p class="compare-note" data-testid="compare-note">Both runs fill ${fair.metrics.filled} of ${fair.metrics.totalSeats} seats — the fairness weight never sacrifices coverage. ${moved.length} assignment${moved.length === 1 ? '' : 's'} moved between the two plans. ${giniText}; ${priceText}.</p>`;
  }

  /* ---------- flow diagram ---------- */
  function renderFlow() {
    const sol = state.solution;
    const sc = state.scenario;
    const vols = sc.volunteers;
    const shifts = sc.shifts;
    const rowH = 46;
    const H = Math.max(vols.length, shifts.length) * rowH + 60;
    const W = 780;
    const xL = 150, xR = W - 170;
    const vy = {}; const sy = {};
    vols.forEach((v, i) => { vy[v.id] = 30 + i * rowH + ((H - 60 - (vols.length - 1) * rowH) / 2); });
    shifts.forEach((s, j) => { sy[s.id] = 30 + j * rowH + ((H - 60 - (shifts.length - 1) * rowH) / 2); });

    let edges = '';
    for (const a of sol.assignments) {
      const pref = a.pref === 'preferred';
      edges += `<line x1="${xL + 10}" y1="${vy[a.vol]}" x2="${xR - 10}" y2="${sy[a.shift]}" stroke="${pref ? '#14655a' : '#b45309'}" stroke-width="${pref ? 3 : 1.6}" opacity="0.75"/>`;
    }
    let vNodes = '';
    for (const v of vols) {
      const at = sol.loads[v.id] >= v.maxShifts && v.maxShifts > 0;
      vNodes += `<g data-testid="flownode-${v.id}">
        <circle cx="${xL}" cy="${vy[v.id]}" r="14" fill="${at ? '#f3dfc2' : '#dcebe6'}" stroke="#20242b" stroke-width="1.5"/>
        <text x="${xL}" y="${vy[v.id] + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="#20242b">${sol.loads[v.id]}/${v.maxShifts}</text>
        <text x="${xL - 22}" y="${vy[v.id] + 4}" text-anchor="end" font-size="12" fill="#20242b">${esc(v.name)}${at ? ' ▲' : ''}</text>
      </g>`;
    }
    let sNodes = '';
    for (const s of shifts) {
      const got = sol.fill[s.id];
      const short = got < s.capacity;
      sNodes += `<g data-testid="flownode-${s.id}">
        <rect x="${xR - 13}" y="${sy[s.id] - 13}" width="26" height="26" rx="6" fill="${short ? '#fdf6ec' : '#dcebe6'}" stroke="${short ? '#b45309' : '#20242b'}" stroke-width="1.5"/>
        <text x="${xR}" y="${sy[s.id] + 4}" text-anchor="middle" font-size="10" font-weight="700" fill="#20242b">${got}/${s.capacity}</text>
        <text x="${xR + 22}" y="${sy[s.id] + 4}" text-anchor="start" font-size="12" fill="#20242b">${esc(s.name)}</text>
      </g>`;
    }
    $('#flow-diagram').innerHTML = `<div class="flow-svg-wrap"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Assignment flow diagram">${edges}${vNodes}${sNodes}</svg></div>`;

    $('#cut-report').innerHTML = cutSummary(sol).map((it) =>
      `<div class="cut-item"><strong>${esc(it.title)}</strong><br>${it.body}</div>`
    ).join('');
  }

  /* ---------- export ---------- */
  function rosterCsv(sol) {
    const lines = ['shift,slot,role,seat,volunteer,preference'];
    for (const sh of sol.scenario.shifts) {
      const people = sol.assignments.filter((a) => a.shift === sh.id);
      for (let k = 0; k < sh.capacity; k++) {
        const a = people[k];
        lines.push([
          csvq(sh.name), csvq(sh.slot), csvq(sh.role), k + 1,
          a ? csvq(sol.volById[a.vol].name) : '(open)',
          a ? a.pref : '',
        ].join(','));
      }
    }
    return lines.join('\n') + '\n';
  }
  const csvq = (s) => `"${String(s).replace(/"/g, '""')}"`;

  function auditText(sol) {
    const m = model.metrics(sol);
    const L = [];
    L.push(`# FairFlow audit — ${sol.scenario.title}`);
    L.push(`Generated locally in the browser at ${new Date().toISOString()}. No data left this machine.`);
    L.push('');
    L.push(`## Result`);
    L.push(`- Mode: ${sol.fairnessWeight > 0 ? `fairness (weight ${sol.fairnessWeight})` : 'pure preference (weight 0)'}`);
    L.push(`- Seats filled: ${m.filled}/${m.totalSeats} (${pct(m.fillRate)}); unfilled: ${m.unfilledCount}`);
    L.push(`- Preferred-slot share of assignments: ${pct(m.preferredRate)}`);
    L.push(`- Loads per person: ${m.minLoad}–${m.maxLoad}, std dev ${m.loadStdev.toFixed(2)}, Gini ${m.gini.toFixed(3)}`);
    L.push(`- Solver: ${sol.iterations} augmentations, total cost ${sol.cost}`);
    L.push('');
    L.push('## Roster');
    for (const sh of sol.scenario.shifts) {
      const people = sol.assignments.filter((a) => a.shift === sh.id)
        .map((a) => `${sol.volById[a.vol].name}${a.pref === 'preferred' ? ' (preferred)' : ''}`);
      L.push(`- ${sh.name} (${sh.slot}, ${sh.role}, ${sol.fill[sh.id]}/${sh.capacity}): ${people.length ? people.join('; ') : 'nobody assigned'}`);
    }
    L.push('');
    L.push('## Unfilled slots and why');
    if (sol.unfilled.length === 0) L.push('- None. Every seat is filled.');
    for (const u of sol.unfilled) {
      const e = explainUnfilled(u);
      L.push(`- ${e.text}`);
      L.push(`  Recommendation: ${e.reco}`);
    }
    L.push('');
    L.push('## Bottleneck (minimum cut)');
    for (const it of cutSummary(sol)) L.push(`- ${it.title}: ${it.body.replace(/<[^>]+>/g, '')}`);
    L.push('');
    L.push('## Time conflicts (heuristic check)');
    const o = plan.overlapCheck(sol.scenario, sol.assignments);
    if (o.conflicts.length === 0 && o.unchecked.length === 0) {
      L.push('- Every assigned slot label was parsed and no overlapping pair was found. This check reads the text labels only; it is not a guarantee.');
    }
    for (const c of o.conflicts) {
      L.push(`- WARNING: ${c.volName} is assigned to ${c.a.name} (${c.a.slot}) and ${c.b.name} (${c.b.slot}), whose times overlap. The solver does not enforce time clashes; reassign one if the labels are right.`);
    }
    for (const c of o.unchecked) {
      L.push(`- UNCHECKED: ${c.volName}: ${c.a.name} (${c.a.slot}) × ${c.b.name} (${c.b.slot}) — ${c.reason}. Absence of a warning does not mean no clash.`);
    }
    L.push('');
    L.push('## Method note');
    L.push('Assignments come from a min-cost max-flow over: source → volunteer (shift limit), volunteer → shift (qualified + available, cost 0 preferred / 1 available), shift → sink (seats). Solved by successive shortest paths with Johnson potentials; integral and optimal for this stated model. In fairness mode each volunteer limit becomes unit arcs costing w×k for the k-th shift, so spreading work is cheaper than stacking it, while coverage stays maximal.');
    return L.join('\n');
  }

  function renderExport() {
    const diag = model.capacityCheck(state.scenario);
    $('#diagnostics').innerHTML = `<table class="data-table" data-testid="diag-table">
      <thead><tr><th>Role</th><th>Seats demanded</th><th>Max coverable</th><th>Qualified people</th><th>Verdict</th></tr></thead>
      <tbody>${diag.map((d) => `<tr data-testid="diag-${esc(d.role)}">
        <td>${esc(d.role)}</td><td>${d.seats}</td><td>${d.supply}</td><td>${d.qualifiedCount}</td>
        <td>${d.shortage > 0 ? `<strong style="color:var(--danger)">structural shortage of ${d.shortage}</strong>` : '<span style="color:var(--pine-dark)">covered on paper</span>'}</td>
      </tr>`).join('')}</tbody></table>`;
    $('#audit-preview').textContent = auditText(state.solution);
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function importStatus(kind, msg) {
    const el = $('#import-status');
    el.className = 'import-status ' + kind;
    el.textContent = msg;
  }

  /* ---------- print handout ---------- */
  function renderPrint() {
    const sol = state.solution;
    const m = model.metrics(sol);
    const sc = state.scenario;
    const rows = sc.shifts.map((sh) => {
      const people = sol.assignments.filter((a) => a.shift === sh.id)
        .map((a) => sol.volById[a.vol].name + (a.pref === 'preferred' ? ' ★' : ''));
      const missing = sh.capacity - sol.fill[sh.id];
      for (let i = 0; i < missing; i++) people.push('(open seat)');
      return `<tr><td>${esc(sh.name)}</td><td>${esc(sh.slot)}</td><td>${esc(sh.role)}</td><td>${sol.fill[sh.id]}/${sh.capacity}</td><td>${esc(people.join(', '))}</td></tr>`;
    }).join('');
    const o = state.overlap;
    const conflictLines = [];
    for (const c of o.conflicts) conflictLines.push(`<li>WARNING: ${esc(c.volName)} — ${esc(c.a.name)} (${esc(c.a.slot)}) overlaps ${esc(c.b.name)} (${esc(c.b.slot)}). Solver does not enforce clashes.</li>`);
    for (const c of o.unchecked) conflictLines.push(`<li>UNCHECKED: ${esc(c.volName)} — ${esc(c.a.name)} (${esc(c.a.slot)}) × ${esc(c.b.name)} (${esc(c.b.slot)}): ${esc(c.reason)}.</li>`);
    const unfilled = sol.unfilled.map((u) => {
      const e = explainUnfilled(u);
      return `<li><strong>${esc(u.shift.name)} — ${u.missing} open.</strong> ${esc(e.text)} <em>${esc(e.reco)}</em></li>`;
    }).join('');
    const loads = sc.volunteers.map((v) => `${esc(v.name)} ${sol.loads[v.id]}/${v.maxShifts}`).join(' · ');
    $('#print-handout').innerHTML = `
      <h1>FairFlow roster — ${esc(sc.title)}</h1>
      <p class="ph-meta">Generated locally ${new Date().toLocaleString()} · mode: ${sol.fairnessWeight > 0 ? `fairness weight ${sol.fairnessWeight}` : 'pure preference'} · ${m.filled}/${m.totalSeats} seats filled (${pct(m.fillRate)}), ${m.unfilledCount} open · ★ = volunteer preferred this slot</p>
      <table class="ph-table"><thead><tr><th>Shift</th><th>When</th><th>Role</th><th>Filled</th><th>Assigned</th></tr></thead><tbody>${rows}</tbody></table>
      ${conflictLines.length ? `<h2>Time conflict check (heuristic)</h2><ul>${conflictLines.join('')}</ul>` : ''}
      <h2>Open seats and what would fix them</h2>
      ${unfilled ? `<ul>${unfilled}</ul>` : '<p>Every seat is filled.</p>'}
      <h2>Workload per person</h2>
      <p>${loads}</p>
      <p class="ph-note">Produced locally by FairFlow; nothing left this device. The assignment is optimal for the stated model (roles, personal limits, marked availability). The time-conflict check is a heuristic over the text labels and never blocks an assignment.</p>`;
  }

  /* ---------- render all ---------- */
  function render() {
    resolve();
    renderBoard();
    renderEdit();
    renderFlow();
    renderExport();
    renderPrint();
    updateChrome();
    persist();
  }

  function updateChrome() {
    const custom = isCustom(state.scenario);
    $('#reset-scenario').style.display = custom ? 'none' : '';
    $('#delete-roster').style.display = custom ? '' : 'none';
  }

  /* ---------- events ---------- */
  function init() {
    const sel = $('#scenario-select');

    // Restore previous work (custom rosters + the roster being edited).
    const saved = restore();
    if (saved && typeof saved === 'object') {
      if (Array.isArray(saved.customs)) {
        for (const raw of saved.customs) {
          const res = plan.validateScenario(raw);
          if (res.ok) {
            if (safeId(raw.id)) res.scenario.id = raw.id;
            res.scenario.id = uniqueRosterId(res.scenario.id);
            state.customs.push(res.scenario);
          }
        }
      }
      if (saved.current) {
        const res = plan.validateScenario(saved.current);
        if (res.ok) {
          if (safeId(saved.currentId)) res.scenario.id = saved.currentId;
          const known = scenarios.list.some((s) => s.id === res.scenario.id) || state.customs.some((c) => c.id === res.scenario.id);
          if (known) state.scenario = res.scenario;
          else { res.scenario.id = uniqueRosterId(res.scenario.id); state.customs.push(res.scenario); state.scenario = res.scenario; }
        }
      }
      const w = Number(saved.weight);
      if (isFinite(w)) state.weight = Math.max(0, Math.min(4, Math.round(w)));
    }
    $('#weight').value = String(state.weight);
    $('#weight-out').textContent = String(state.weight);

    refreshScenarioOptions();
    sel.addEventListener('change', () => {
      const custom = state.customs.find((c) => c.id === sel.value);
      state.scenario = custom || scenarios.byId(sel.value) || state.scenario;
      render();
    });

    $('#weight').addEventListener('input', (e) => {
      state.weight = Number(e.target.value);
      $('#weight-out').textContent = e.target.value;
      render();
    });

    $('#reset-scenario').addEventListener('click', () => {
      state.scenario = scenarios.byId(state.scenario.id);
      render();
    });

    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => { t.classList.toggle('active', t === tab); t.setAttribute('aria-selected', t === tab ? 'true' : 'false'); });
        document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
        $('#view-' + tab.dataset.tab).classList.add('active');
        if (tab.dataset.tab === 'compare') renderCompare();
      });
    });

    // matrix cycling
    $('#matrix').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cell]');
      if (!btn) return;
      const [volId, shiftId] = btn.dataset.cell.split('|');
      const order = ['off', 'available', 'preferred'];
      const cur = model.availabilityOf(state.scenario, volId, shiftId);
      const next = order[(order.indexOf(cur) + 1) % order.length];
      if (!state.scenario.availability[volId]) state.scenario.availability[volId] = {};
      state.scenario.availability[volId][shiftId] = next;
      render();
    });

    // people table edits
    $('#people-table').addEventListener('input', (e) => {
      const f = e.target.dataset.field;
      if (!f) return;
      const v = state.scenario.volunteers[Number(e.target.dataset.idx)];
      if (f === 'name') v.name = e.target.value;
      if (f === 'roles') v.roles = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
      if (f === 'maxShifts') v.maxShifts = Math.max(1, Math.min(10, Number(e.target.value) || 1));
      resolve();
      renderBoard(); renderFlow(); renderExport(); renderPrint();
      persist();
    });
    $('#people-table').addEventListener('click', (e) => {
      const idx = e.target.dataset.delPerson;
      if (idx === undefined) return;
      const v = state.scenario.volunteers.splice(Number(idx), 1)[0];
      delete state.scenario.availability[v.id];
      render();
    });

    // shift table edits
    $('#shifts-table').addEventListener('input', (e) => {
      const f = e.target.dataset.sfield;
      if (!f) return;
      const s = state.scenario.shifts[Number(e.target.dataset.idx)];
      if (f === 'name') s.name = e.target.value;
      if (f === 'slot') s.slot = e.target.value;
      if (f === 'role') s.role = e.target.value.trim();
      if (f === 'capacity') s.capacity = Math.max(1, Math.min(12, Number(e.target.value) || 1));
      resolve();
      renderBoard(); renderFlow(); renderExport(); renderPrint();
      persist();
    });
    $('#shifts-table').addEventListener('click', (e) => {
      const idx = e.target.dataset.delShift;
      if (idx === undefined) return;
      const s = state.scenario.shifts.splice(Number(idx), 1)[0];
      for (const vid of Object.keys(state.scenario.availability)) delete state.scenario.availability[vid][s.id];
      render();
    });

    $('#add-person').addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const name = String(fd.get('name')).trim();
      const roles = String(fd.get('roles')).split(',').map((s) => s.trim()).filter(Boolean);
      if (!name || roles.length === 0) return;
      let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'vol';
      let base = id, n = 2;
      while (state.scenario.volunteers.some((v) => v.id === id)) id = `${base}-${n++}`;
      state.scenario.volunteers.push({ id, name, roles, maxShifts: Math.max(1, Math.min(10, Number(fd.get('maxShifts')) || 2)) });
      e.target.reset();
      e.target.elements.maxShifts.value = 2;
      render();
    });

    $('#add-shift').addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const name = String(fd.get('name')).trim();
      const role = String(fd.get('role')).trim();
      if (!name || !role) return;
      let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'shift';
      let base = id, n = 2;
      while (state.scenario.shifts.some((s) => s.id === id)) id = `${base}-${n++}`;
      state.scenario.shifts.push({ id, name, slot: String(fd.get('slot')).trim() || 'TBD', role, capacity: Math.max(1, Math.min(12, Number(fd.get('capacity')) || 1)) });
      e.target.reset();
      e.target.elements.capacity.value = 2;
      render();
    });

    // Save the current roster (with edits) as a reusable custom roster.
    $('#save-copy').addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const title = String(fd.get('title')).trim();
      if (!title) return;
      const copy = plan.duplicateRoster(state.scenario, title);
      copy.id = uniqueRosterId(copy.id);
      state.customs.push(copy);
      state.scenario = copy;
      e.target.reset();
      refreshScenarioOptions();
      render();
    });

    $('#delete-roster').addEventListener('click', () => {
      if (!isCustom(state.scenario)) return;
      state.customs = state.customs.filter((c) => c.id !== state.scenario.id);
      state.scenario = scenarios.clone(scenarios.list[0]);
      refreshScenarioOptions();
      render();
    });

    // Import: validate fully before anything changes; keep a recovery copy.
    $('#import-json').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (file.size > 1024 * 1024) { importStatus('error', 'That file is too large (1 MB max). Nothing was changed.'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        let raw;
        try { raw = JSON.parse(String(reader.result)); }
        catch (err) { importStatus('error', 'That file is not valid JSON. Nothing was changed.'); return; }
        const res = plan.validateScenario(raw);
        if (!res.ok) { importStatus('error', 'Import rejected — nothing was changed. ' + res.errors.join(' ')); return; }
        // Recovery path: if the current roster is an edited bundled one, keep a copy.
        let recoveredTitle = null;
        if (!isCustom(state.scenario)) {
          const pristine = scenarios.byId(state.scenario.id);
          if (pristine && JSON.stringify(state.scenario) !== JSON.stringify(pristine)) {
            const rec = plan.duplicateRoster(state.scenario, 'Recovered ' + state.scenario.title);
            rec.id = uniqueRosterId(rec.id);
            state.customs.push(rec);
            recoveredTitle = rec.title;
          }
        }
        const imported = res.scenario;
        imported.id = uniqueRosterId(imported.id);
        state.customs.push(imported);
        state.scenario = imported;
        refreshScenarioOptions();
        render();
        let msg = `Imported "${imported.title}" (${imported.volunteers.length} volunteers, ${imported.shifts.length} shifts) into My rosters.`;
        if (res.warnings.length) msg += ' Repaired on the way in: ' + res.warnings.join(' ');
        if (recoveredTitle) msg += ` Your previous work was kept as "${recoveredTitle}" under My rosters.`;
        importStatus('ok', msg);
      };
      reader.readAsText(file);
    });

    $('#print-handout-btn').addEventListener('click', () => window.print());

    $('#export-csv').addEventListener('click', () => download(`fairflow-roster-${state.scenario.id}.csv`, rosterCsv(state.solution), 'text/csv'));
    $('#export-audit').addEventListener('click', () => download(`fairflow-audit-${state.scenario.id}.md`, auditText(state.solution), 'text/markdown'));
    $('#export-json').addEventListener('click', () => download(`fairflow-scenario-${state.scenario.id}.json`, JSON.stringify(state.scenario, null, 2), 'application/json'));

    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
