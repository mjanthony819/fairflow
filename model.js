/*
 * FairFlow model: turns a roster scenario into a flow network, solves it,
 * and derives explanations, metrics and diagnostics from the result.
 *
 * Network shape (classic assignment formulation):
 *   source -> volunteer   capacity = shift limit (unit arcs with rising
 *                         cost in fairness mode, one flat arc otherwise)
 *   volunteer -> shift    capacity 1, cost 0 for a preferred slot,
 *                         cost 1 for an available one; the arc exists only
 *                         when the volunteer is qualified and not marked off
 *   shift -> sink         capacity = seats to fill
 *
 * Because assignment costs are non-negative, running the solver to
 * exhaustion yields the maximum number of filled seats and, among all
 * assignments filling that many seats, one of minimum total cost.
 *
 * Runs in the browser (window.FairFlowModel) and in Node (module.exports).
 */
(function (root, factory) {
  const solver = (typeof module !== 'undefined' && module.exports)
    ? require('./solver.js')
    : root.FairFlowSolver;
  const api = factory(solver);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FairFlowModel = api;
})(typeof self !== 'undefined' ? self : globalThis, function (solver) {
  'use strict';

  const PREF_COST = 0;   // volunteer marked this slot "preferred"
  const AVAIL_COST = 1;  // volunteer marked this slot "available"

  function isQualified(vol, shift) {
    return vol.roles.indexOf(shift.role) !== -1;
  }
  function availabilityOf(scenario, volId, shiftId) {
    const row = scenario.availability[volId];
    if (!row) return 'off';
    return row[shiftId] || 'off';
  }

  // --- Pre-solve structural diagnostics -------------------------------------
  // Per role: seats demanded vs the most its qualified volunteers could ever
  // cover (their shift limits, capped by how many slots they actually marked).
  function capacityCheck(scenario) {
    const roles = [];
    for (const shift of scenario.shifts) if (roles.indexOf(shift.role) === -1) roles.push(shift.role);
    return roles.map((role) => {
      const roleShifts = scenario.shifts.filter((s) => s.role === role);
      const seats = roleShifts.reduce((a, s) => a + s.capacity, 0);
      const qualified = scenario.volunteers.filter((v) => v.roles.indexOf(role) !== -1);
      let supply = 0;
      const detail = qualified.map((v) => {
        const marked = roleShifts.filter(
          (s) => availabilityOf(scenario, v.id, s.id) !== 'off'
        ).length;
        const cap = Math.min(v.maxShifts, marked);
        supply += cap;
        return { id: v.id, name: v.name, usable: cap };
      });
      return {
        role,
        seats,
        supply,
        shortage: Math.max(0, seats - supply),
        qualifiedCount: qualified.length,
        detail,
      };
    });
  }

  // --- Network construction --------------------------------------------------
  function buildNetwork(scenario, opts) {
    const options = opts || {};
    const fairnessWeight = Math.max(0, options.fairnessWeight || 0);
    const vols = scenario.volunteers;
    const shifts = scenario.shifts;
    const nV = vols.length;
    const nS = shifts.length;
    const S = 0;
    const T = nV + nS + 1;
    const net = solver.createNetwork(nV + nS + 2);
    const volNode = (i) => 1 + i;
    const shiftNode = (j) => 1 + nV + j;

    vols.forEach((v, i) => {
      if (fairnessWeight > 0) {
        // Convex workload cost: the k-th shift handed to one person costs
        // fairnessWeight * k, so the solver prefers spreading work before
        // stacking it, while still filling every seat it can.
        for (let k = 1; k <= v.maxShifts; k++) {
          solver.addArc(net, S, volNode(i), 1, fairnessWeight * k, { type: 'limit', vol: v.id, unit: k });
        }
      } else {
        solver.addArc(net, S, volNode(i), v.maxShifts, 0, { type: 'limit', vol: v.id });
      }
    });

    vols.forEach((v, i) => {
      shifts.forEach((sh, j) => {
        if (!isQualified(v, sh)) return;
        const avail = availabilityOf(scenario, v.id, sh.id);
        if (avail === 'off') return;
        const cost = avail === 'preferred' ? PREF_COST : AVAIL_COST;
        solver.addArc(net, volNode(i), shiftNode(j), 1, cost, { type: 'assign', vol: v.id, shift: sh.id, pref: avail });
      });
    });

    shifts.forEach((sh, j) => {
      solver.addArc(net, shiftNode(j), T, sh.capacity, 0, { type: 'seat', shift: sh.id });
    });

    return { net, S, T, volNode, shiftNode, fairnessWeight };
  }

  // --- Solve + analysis --------------------------------------------------------
  function solve(scenario, opts) {
    const built = buildNetwork(scenario, opts);
    const result = solver.minCostMaxFlow(built.net, built.S, built.T);
    const reachable = solver.residualReachable(built.net, built.S);

    const vols = scenario.volunteers;
    const shifts = scenario.shifts;
    const volById = {}; vols.forEach((v) => { volById[v.id] = v; });
    const shiftById = {}; shifts.forEach((s) => { shiftById[s.id] = s; });

    const assignments = [];
    const loads = {}; vols.forEach((v) => { loads[v.id] = 0; });
    const fill = {}; shifts.forEach((s) => { fill[s.id] = 0; });
    for (const arc of built.net.arcs) {
      if (arc.tag && arc.tag.type === 'assign' && arc.flow > 0) {
        assignments.push({ vol: arc.tag.vol, shift: arc.tag.shift, pref: arc.tag.pref });
        loads[arc.tag.vol] += arc.flow;
        fill[arc.tag.shift] += arc.flow;
      }
    }

    const totalSeats = shifts.reduce((a, s) => a + s.capacity, 0);
    const filled = assignments.length;

    // Min cut: saturated forward arcs from the reachable side to the far side.
    const cutArcs = built.net.arcs.filter(
      (arc) => reachable[arc.from] && !reachable[arc.to] && arc.cap > 0 && arc.flow === arc.cap
    );

    // Explanation for each under-filled shift. Invariant (checked by tests):
    // every qualified, available volunteer for an under-filled shift is
    // either at their personal shift limit or already holds a seat on this
    // very shift — otherwise an augmenting path would still exist.
    const assignedHere = {};
    for (const a of assignments) {
      if (!assignedHere[a.shift]) assignedHere[a.shift] = new Set();
      assignedHere[a.shift].add(a.vol);
    }
    const unfilled = [];
    for (const sh of shifts) {
      const missing = sh.capacity - fill[sh.id];
      if (missing <= 0) continue;
      const here = assignedHere[sh.id] || new Set();
      const candidates = vols.filter(
        (v) => isQualified(v, sh) && availabilityOf(scenario, v.id, sh.id) !== 'off'
      );
      const atLimit = candidates.filter((v) => loads[v.id] >= v.maxShifts && !here.has(v.id));
      const alreadyHere = candidates.filter((v) => here.has(v.id));
      const spare = candidates.filter((v) => loads[v.id] < v.maxShifts && !here.has(v.id));
      const qualifiedElsewhere = vols.filter((v) => v.roles.indexOf(sh.role) !== -1).length;
      unfilled.push({
        shift: sh,
        missing,
        candidateCount: candidates.length,
        atLimit: atLimit.map((v) => ({ id: v.id, name: v.name, load: loads[v.id], maxShifts: v.maxShifts })),
        alreadyHere: alreadyHere.map((v) => ({ id: v.id, name: v.name })),
        spareCount: spare.length,
        qualifiedElsewhere,
        fullyBound: spare.length === 0 && candidates.length > 0,
      });
    }

    return {
      scenario,
      fairnessWeight: built.fairnessWeight,
      flow: result.flow,
      cost: result.cost,
      iterations: result.iterations,
      assignments,
      loads,
      fill,
      totalSeats,
      filled,
      unfilled,
      cutArcs,
      reachableNodes: reachable,
      nodeFor: { vol: built.volNode, shift: built.shiftNode, S: built.S, T: built.T },
      volById,
      shiftById,
    };
  }

  // --- Metrics -----------------------------------------------------------------
  function gini(values) {
    const xs = values.slice().sort((a, b) => a - b);
    const n = xs.length;
    if (n === 0) return 0;
    const sum = xs.reduce((a, b) => a + b, 0);
    if (sum === 0) return 0;
    let acc = 0;
    xs.forEach((x, i) => { acc += (i + 1) * x; });
    return (2 * acc) / (n * sum) - (n + 1) / n;
  }
  function stdev(values) {
    const n = values.length;
    if (n === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const v = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
    return Math.sqrt(v);
  }

  function metrics(solution) {
    const loads = solution.scenario.volunteers.map((v) => solution.loads[v.id]);
    const assigned = solution.assignments.length;
    const preferred = solution.assignments.filter((a) => a.pref === 'preferred').length;
    return {
      filled: solution.filled,
      totalSeats: solution.totalSeats,
      fillRate: solution.totalSeats === 0 ? 1 : solution.filled / solution.totalSeats,
      assigned,
      preferred,
      preferredRate: assigned === 0 ? 0 : preferred / assigned,
      minLoad: loads.length ? Math.min.apply(null, loads) : 0,
      maxLoad: loads.length ? Math.max.apply(null, loads) : 0,
      loadStdev: stdev(loads),
      gini: gini(loads),
      atLimit: solution.scenario.volunteers.filter((v) => solution.loads[v.id] >= v.maxShifts && v.maxShifts > 0).length,
      unfilledCount: solution.unfilled.reduce((a, u) => a + u.missing, 0),
    };
  }

  // Preference run vs fairness run, side by side.
  function compare(scenario, fairnessWeight) {
    const pref = solve(scenario, { fairnessWeight: 0 });
    const fair = solve(scenario, { fairnessWeight });
    return {
      pref: { solution: pref, metrics: metrics(pref) },
      fair: { solution: fair, metrics: metrics(fair) },
    };
  }

  return { PREF_COST, AVAIL_COST, isQualified, availabilityOf, capacityCheck, buildNetwork, solve, metrics, compare, gini, stdev };
});
