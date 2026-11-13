/*
 * FairFlow engine tests (Node, no dependencies).
 *   node tests/run-tests.mjs
 * Covers: solver unit tests on known networks, model invariants on the
 * bundled scenarios, a brute-force oracle on random tiny instances, metrics
 * on known vectors, and determinism. Exits non-zero on the first failure
 * count > 0.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const solver = require('./solver.js');
const model = require('./model.js');
const scenarios = require('./scenarios.js');
const plan = require('./plan.js');

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; }
  else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); }
}
function eq(name, a, b) { check(name, a === b, `expected ${b}, got ${a}`); }

// ---------- 1. Solver: single path -------------------------------------------
{
  const net = solver.createNetwork(3);
  solver.addArc(net, 0, 1, 2, 5);
  solver.addArc(net, 1, 2, 2, 7);
  const r = solver.minCostMaxFlow(net, 0, 2);
  eq('solver.single.flow', r.flow, 2);
  eq('solver.single.cost', r.cost, 24);
}

// ---------- 2. Solver: picks the cheaper of two paths ------------------------
{
  // s->a->t costs 1, s->b->t costs 3, each capacity 1, demand 2.
  const net = solver.createNetwork(4);
  solver.addArc(net, 0, 1, 1, 0); solver.addArc(net, 1, 3, 1, 1);
  solver.addArc(net, 0, 2, 1, 0); solver.addArc(net, 2, 3, 1, 3);
  const r = solver.minCostMaxFlow(net, 0, 3);
  eq('solver.twopath.flow', r.flow, 2);
  eq('solver.twopath.cost', r.cost, 4);
}

// ---------- 3. Solver: rerouting beats greedy ---------------------------------
{
  // Classic: cheap arc a->b shared. s->a(1,0), a->t(1,0), s->b(1,0),
  // b->t(1,10), a->b(1,1). Max flow 2, min cost 0+1+10 = 11? No:
  // best is a->t (0) and s->b->t (10) = 10, vs a->b->t (1+10) + a->t(0) = 11.
  const net = solver.createNetwork(4); // 0=s,1=a,2=b,3=t
  solver.addArc(net, 0, 1, 1, 0); solver.addArc(net, 1, 3, 1, 0);
  solver.addArc(net, 0, 2, 1, 0); solver.addArc(net, 2, 3, 1, 10);
  solver.addArc(net, 1, 2, 1, 1);
  const r = solver.minCostMaxFlow(net, 0, 3);
  eq('solver.reroute.flow', r.flow, 2);
  eq('solver.reroute.cost', r.cost, 10);
}

// ---------- 4. Solver: convex unit arcs price rising load ----------------------
{
  const net = solver.createNetwork(3);
  for (let k = 1; k <= 3; k++) solver.addArc(net, 0, 1, 1, 10 * k);
  solver.addArc(net, 1, 2, 5, 0);
  const r = solver.minCostMaxFlow(net, 0, 2);
  eq('solver.convex.flow', r.flow, 3);
  eq('solver.convex.cost', r.cost, 10 * (1 + 2 + 3));
}

// ---------- 5. Solver: residual reachable set matches a known cut --------------
{
  const net = solver.createNetwork(4);
  solver.addArc(net, 0, 1, 1, 0); solver.addArc(net, 1, 3, 1, 0);
  solver.addArc(net, 0, 2, 1, 0); solver.addArc(net, 2, 3, 1, 0);
  solver.minCostMaxFlow(net, 0, 3);
  const reach = solver.residualReachable(net, 0);
  eq('solver.cut.sourceReachable', reach[0], true);
  eq('solver.cut.sinkBlocked', reach[3], false);
}

// ---------- 6. Model: bundled scenarios respect every hard constraint ----------
for (const sc of scenarios.list) {
  for (const w of [0, 2]) {
    const sol = model.solve(sc, { fairnessWeight: w });
    const name = `model.${sc.id}.w${w}`;
    // role match + availability on every assignment
    let ok = true;
    for (const a of sol.assignments) {
      const v = sol.volById[a.vol]; const s = sol.shiftById[a.shift];
      if (!v || !s) ok = false;
      else if (v.roles.indexOf(s.role) === -1) ok = false;
      else if (model.availabilityOf(sc, v.id, s.id) === 'off') ok = false;
    }
    check(`${name}.assignmentsLegal`, ok);
    // per-volunteer limits
    for (const v of sc.volunteers) check(`${name}.limit.${v.id}`, sol.loads[v.id] <= v.maxShifts);
    // per-shift capacity
    for (const s of sc.shifts) check(`${name}.cap.${s.id}`, sol.fill[s.id] <= s.capacity);
    // assignment count bookkeeping
    eq(`${name}.filled`, sol.filled, sol.assignments.length);
  }
  // fairness mode must never fill fewer seats (capacities are identical)
  const a = model.solve(sc, { fairnessWeight: 0 });
  const b = model.solve(sc, { fairnessWeight: 3 });
  eq(`model.${sc.id}.fairKeepsFill`, b.filled, a.filled);
}

// ---------- 7. Model: unfilled-shift bottleneck invariant -----------------------
for (const sc of scenarios.list) {
  const sol = model.solve(sc, { fairnessWeight: 0 });
  for (const u of sol.unfilled) {
    // If a seat is empty, every qualified, available volunteer must be at
    // their personal limit, or an augmenting path would still exist.
    eq(`model.${sc.id}.unfilledBound.${u.shift.id}`, u.fullyBound, true);
    eq(`model.${sc.id}.unfilledSpare.${u.shift.id}`, u.spareCount, 0);
  }
}
// The conference scenario deliberately leaves the late desk short.
{
  const sol = model.solve(scenarios.byId('conference'), { fairnessWeight: 0 });
  const late = sol.unfilled.find((u) => u.shift.id === 'sat-late');
  check('model.conference.lateShort', !!late && late.missing >= 1);
  if (late) eq('model.conference.lateCandidates', late.candidateCount, 1); // only hugo marked the late slot
}

// ---------- 8. Oracle: brute force on random tiny instances --------------------
function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; }

function oracle(scenario, fairnessWeight) {
  const vols = scenario.volunteers;
  const shifts = scenario.shifts;
  const cand = vols.map((v) => shifts.filter(
    (s) => v.roles.indexOf(s.role) !== -1 && model.availabilityOf(scenario, v.id, s.id) !== 'off'
  ).map((s) => s.id));
  let best = { fill: -1, cost: Infinity };
  const loadCost = (l) => fairnessWeight * (l * (l + 1)) / 2;
  const chosen = new Array(vols.length);
  const used = {}; shifts.forEach((s) => { used[s.id] = 0; });
  function edgeCost(vi, shiftId) {
    return model.availabilityOf(scenario, vols[vi].id, shiftId) === 'preferred' ? 0 : 1;
  }
  function rec(i, fill, cost) {
    if (i === vols.length) {
      if (fill > best.fill || (fill === best.fill && cost < best.cost)) best = { fill, cost };
      return;
    }
    if (cost > best.cost && best.fill >= 0) { /* still must explore: fill may rise */ }
    const options = [[]];
    for (const sid of cand[i]) {
      const add = [];
      for (const o of options) if (o.length < vols[i].maxShifts) add.push(o.concat([sid]));
      options.push(...add);
    }
    for (const opt of options) {
      let ok = true;
      for (const sid of opt) if (used[sid] >= shifts.find((s) => s.id === sid).capacity) { ok = false; break; }
      if (!ok) continue;
      let c = cost + loadCost(opt.length) + opt.reduce((a, sid) => a + edgeCost(i, sid), 0);
      for (const sid of opt) used[sid]++;
      rec(i + 1, fill + opt.length, c);
      for (const sid of opt) used[sid]--;
    }
  }
  rec(0, 0, 0);
  return best;
}

{
  const rand = rng(20261113);
  const N = 400;
  let agree = 0;
  for (let it = 0; it < N; it++) {
    const roles = ['x', 'y'];
    const nV = 2 + Math.floor(rand() * 3);      // 2..4 volunteers
    const nS = 1 + Math.floor(rand() * 3);      // 1..3 shifts
    const vols = [];
    for (let i = 0; i < nV; i++) {
      const r1 = roles[Math.floor(rand() * 2)];
      const rset = rand() < 0.3 ? roles : [r1];
      vols.push({ id: 'v' + i, name: 'v' + i, roles: rset, maxShifts: 1 + Math.floor(rand() * 2) });
    }
    const shifts = [];
    for (let j = 0; j < nS; j++) {
      shifts.push({ id: 's' + j, name: 's' + j, slot: 't', role: roles[Math.floor(rand() * 2)], capacity: 1 + Math.floor(rand() * 2) });
    }
    const availability = {};
    for (const v of vols) {
      availability[v.id] = {};
      for (const s of shifts) {
        const u = rand();
        availability[v.id][s.id] = u < 0.25 ? 'preferred' : u < 0.65 ? 'available' : 'off';
      }
    }
    const sc = { id: 'rand', title: 'rand', blurb: '', volunteers: vols, shifts, availability };
    for (const w of [0, 2]) {
      const sol = model.solve(sc, { fairnessWeight: w });
      const best = oracle(sc, w);
      if (!(sol.filled === best.fill && sol.cost === best.cost)) {
        check('oracle.mismatch', false, `it=${it} w=${w} solver=${sol.filled}/${sol.cost} oracle=${best.fill}/${best.cost}`);
        it = N; break;
      }
      // invariants on the random instance too
      let legal = true;
      for (const a2 of sol.assignments) {
        const v = sol.volById[a2.vol]; const s = sol.shiftById[a2.shift];
        if (v.roles.indexOf(s.role) === -1) legal = false;
        if (model.availabilityOf(sc, v.id, s.id) === 'off') legal = false;
      }
      for (const u of sol.unfilled) if (!u.fullyBound && u.candidateCount > 0) legal = false;
      if (!legal) { check('oracle.invariants', false, `it=${it} w=${w}`); it = N; break; }
      agree++;
    }
  }
  eq('oracle.agreements', agree, N * 2);
}

// ---------- 9. Metrics on known vectors ---------------------------------------
{
  const g = model.gini([0, 0, 0, 0]);
  eq('metrics.giniEqual', g, 0);
  const g2 = model.gini([0, 0, 0, 9]);
  check('metrics.giniConcentrated', Math.abs(g2 - 0.75) < 1e-9, 'gini=' + g2);
  eq('metrics.stdevConst', model.stdev([2, 2, 2]), 0);
  check('metrics.stdevKnown', Math.abs(model.stdev([1, 3]) - 1) < 1e-9);
}

// ---------- 10. Determinism + comparison coherence -----------------------------
{
  const sc = scenarios.byId('shelter');
  const a = model.solve(sc, { fairnessWeight: 0 });
  const b = model.solve(sc, { fairnessWeight: 0 });
  eq('determinism.fill', a.filled, b.filled);
  eq('determinism.cost', a.cost, b.cost);
  const cmp = model.compare(sc, 2);
  eq('compare.fillsMatch', cmp.pref.metrics.filled, cmp.fair.metrics.filled);
  check('compare.fairNotWorseGini', cmp.fair.metrics.gini <= cmp.pref.metrics.gini + 1e-9,
    `pref=${cmp.pref.metrics.gini} fair=${cmp.fair.metrics.gini}`);
  // cost formula: fairness cost = assignment costs + convex workload costs
  const w = 2;
  const sol = model.solve(sc, { fairnessWeight: w });
  let expect = 0;
  for (const asg of sol.assignments) expect += asg.pref === 'preferred' ? 0 : 1;
  for (const v of sc.volunteers) { const l = sol.loads[v.id]; expect += w * (l * (l + 1)) / 2; }
  eq('compare.costFormula', sol.cost, expect);
}

// ---------- 11. Capacity check diagnostics -------------------------------------
{
  const sc = scenarios.byId('shelter');
  const diag = model.capacityCheck(sc);
  const handler = diag.find((d) => d.role === 'handler');
  eq('diag.handlerShortage', handler.shortage, 1);
  const kitchen = model.capacityCheck(scenarios.byId('kitchen'));
  eq('diag.kitchenRoles', kitchen.length, 4);
}


// ---------- 12. Plan: slot-label parsing ---------------------------------------
{
  const p1 = plan.parseSlot('Sat 08:00–12:00');
  eq('plan.parse.sat.day', p1.day, 5);
  eq('plan.parse.sat.start', p1.start, 480);
  eq('plan.parse.sat.end', p1.end, 720);
  eq('plan.parse.sat.overnight', p1.overnight, false);
  eq('plan.parse.fullname.day', plan.parseSlot('Sunday 09:00 to 13:00').day, 6);
  const p2 = plan.parseSlot('9am–12pm');
  eq('plan.parse.ampm.day', p2.day, null);
  eq('plan.parse.ampm.start', p2.start, 540);
  eq('plan.parse.ampm.end', p2.end, 720);
  const p3 = plan.parseSlot('9:30 PM – 11:45 pm');
  eq('plan.parse.ampm2.start', p3.start, 21 * 60 + 30);
  eq('plan.parse.ampm2.end', p3.end, 23 * 60 + 45);
  const p4 = plan.parseSlot('Sat 22:00–02:00');
  eq('plan.parse.overnight.flag', p4.overnight, true);
  eq('plan.parse.overnight.end', p4.end, 1560);
  for (const bad of ['morning', 'TBD', '', 'Sat', 'Sat 25:00–26:00', 'Fri 9:99–10:00', 42, null]) {
    eq(`plan.parse.bad.${String(bad)}`, plan.parseSlot(bad), null);
  }
}

// ---------- 13. Plan: slot comparison ------------------------------------------
{
  const S = plan.parseSlot;
  eq('plan.cmp.sameDayOverlap', plan.compareSlots(S('Sat 08:00–12:00'), S('Sat 11:00–15:00')).overlap, true);
  eq('plan.cmp.touchingNoOverlap', plan.compareSlots(S('Sat 08:00–12:00'), S('Sat 12:00–15:00')).overlap, false);
  eq('plan.cmp.diffDays', plan.compareSlots(S('Sat 08:00–12:00'), S('Sun 08:00–12:00')).overlap, false);
  eq('plan.cmp.overnightCrossDay', plan.compareSlots(S('Sat 22:00–02:00'), S('Sun 01:00–03:00')).overlap, true);
  eq('plan.cmp.overnightNoClash', plan.compareSlots(S('Sat 22:00–02:00'), S('Sun 03:00–05:00')).overlap, false);
  const dayVsNone = plan.compareSlots(S('Sat 08:00–12:00'), S('08:00–12:00'));
  eq('plan.cmp.dayVsNone.unknown', dayVsNone.overlap, null);
  check('plan.cmp.dayVsNone.reason', !!dayVsNone.reason);
  const noDayOvernight = plan.compareSlots(S('22:00–02:00'), S('01:00–03:00'));
  eq('plan.cmp.noDayOvernight.unknown', noDayOvernight.overlap, null);
  eq('plan.cmp.noDayPairOverlap', plan.compareSlots(S('08:00–12:00'), S('11:00–13:00')).overlap, true);
  eq('plan.cmp.unparseable.unknown', plan.compareSlots(S('morning'), S('Sat 08:00–12:00')).overlap, null);
}

// ---------- 14. Plan: overlapCheck separates conflicts from unchecked ----------
{
  const sc = {
    id: 't', title: 'T',
    volunteers: [{ id: 'a', name: 'A Person', roles: ['r'], maxShifts: 5 }],
    shifts: [
      { id: 's1', name: 'One', slot: 'Sat 08:00–12:00', role: 'r', capacity: 1 },
      { id: 's2', name: 'Two', slot: 'Sat 10:00–14:00', role: 'r', capacity: 1 },
      { id: 's3', name: 'Three', slot: 'whenever', role: 'r', capacity: 1 },
    ],
    availability: {},
  };
  const res = plan.overlapCheck(sc, [{ vol: 'a', shift: 's1' }, { vol: 'a', shift: 's2' }, { vol: 'a', shift: 's3' }]);
  eq('plan.overlap.conflictCount', res.conflicts.length, 1);
  eq('plan.overlap.uncheckedCount', res.unchecked.length, 2);
  eq('plan.overlap.conflictVol', res.conflicts[0].volName, 'A Person');
  // A single-assignment volunteer produces no pairs at all.
  const res2 = plan.overlapCheck(sc, [{ vol: 'a', shift: 's1' }]);
  eq('plan.overlap.singleEmpty', res2.conflicts.length + res2.unchecked.length, 0);
  // Unparseable labels must never read as conflict-free: they land in unchecked.
  const res3 = plan.overlapCheck(sc, [{ vol: 'a', shift: 's1' }, { vol: 'a', shift: 's3' }]);
  eq('plan.overlap.unparseableIsUnchecked', res3.unchecked.length, 1);
  eq('plan.overlap.unparseableNotConflict', res3.conflicts.length, 0);
}

// ---------- 15. Plan: scenario validation (import) ------------------------------
{
  // Round-trip: every bundled scenario must survive export -> validate unchanged.
  for (const sc of scenarios.list) {
    const copy = JSON.parse(JSON.stringify(sc));
    const res = plan.validateScenario(copy);
    eq(`plan.import.${sc.id}.ok`, res.ok, true);
    if (res.ok) {
      eq(`plan.import.${sc.id}.vols`, res.scenario.volunteers.length, sc.volunteers.length);
      eq(`plan.import.${sc.id}.shifts`, res.scenario.shifts.length, sc.shifts.length);
      const marks = (o) => Object.values(o).reduce((n, row) => n + Object.keys(row).length, 0);
      eq(`plan.import.${sc.id}.marks`, marks(res.scenario.availability), marks(sc.availability));
      // and the imported scenario still solves to the same coverage
      const a = model.solve(sc, { fairnessWeight: 0 });
      const b = model.solve(res.scenario, { fairnessWeight: 0 });
      eq(`plan.import.${sc.id}.sameFill`, b.filled, a.filled);
    }
  }
  eq('plan.import.notObject', plan.validateScenario([1, 2]).ok, false);
  eq('plan.import.noVols', plan.validateScenario({ shifts: [] }).ok, false);
  const noName = plan.validateScenario({ volunteers: [{ roles: ['r'] }], shifts: [] });
  eq('plan.import.noName', noName.ok, false);
  check('plan.import.noNameMsg', /volunteer 1/.test(noName.errors[0]), noName.errors[0]);
  eq('plan.import.noRoles', plan.validateScenario({ volunteers: [{ name: 'X', roles: [] }], shifts: [] }).ok, false);
  const messy = plan.validateScenario({
    title: '  Messy  ',
    volunteers: [{ name: 'A', roles: ['r'], maxShifts: 99 }],
    shifts: [{ name: 'S', role: 'r', capacity: 99 }],
    availability: { __proto__: { s: 'preferred' }, a: { s: 'preferred', junk: 'preferred', nope: 'sometimes' } },
  });
  eq('plan.import.messy.ok', messy.ok, true);
  eq('plan.import.messy.clampLimit', messy.scenario.volunteers[0].maxShifts, 10);
  eq('plan.import.messy.clampCap', messy.scenario.shifts[0].capacity, 12);
  eq('plan.import.messy.title', messy.scenario.title, 'Messy');
  check('plan.import.messy.warns', messy.warnings.length >= 2, messy.warnings.join('; '));
  const proto = plan.validateScenario({
    volunteers: [{ name: 'A', roles: ['r'] }],
    shifts: [{ name: 'S', role: 'r' }],
    availability: JSON.parse('{"__proto__": {"polluted": "yes"}}'),
  });
  eq('plan.import.protoSafe', ({}).polluted, undefined);
  eq('plan.import.protoOk', proto.ok, true);
}

// ---------- 16. Plan: roster duplication ----------------------------------------
{
  const src = scenarios.byId('kitchen');
  const copy = plan.duplicateRoster(src, 'Kitchen week 2');
  eq('plan.dupe.title', copy.title, 'Kitchen week 2');
  check('plan.dupe.newId', copy.id !== src.id);
  eq('plan.dupe.samePeople', copy.volunteers.length, src.volunteers.length);
  copy.volunteers[0].name = 'Changed';
  check('plan.dupe.deep', src.volunteers[0].name !== 'Changed');
  eq('plan.dupe.defaultTitle', plan.duplicateRoster(src, '   ').title, src.title + ' (copy)');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log(' - ' + f)); }
process.exit(failed === 0 ? 0 : 1);
