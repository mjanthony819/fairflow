/*
 * FairFlow solver: min-cost max-flow over a small bipartite assignment network.
 *
 * Method: successive shortest augmenting paths with Johnson potentials
 * (Dijkstra on reduced costs). Every arc cost in this app is non-negative,
 * so zero initial potentials are valid. Each augmentation keeps the flow
 * min-cost for its value; when no augmenting path remains the flow is a
 * max flow and min-cost among max flows. All capacities are integral, so
 * the resulting flow is integral (0/1 on assignment arcs).
 *
 * This file runs both in the browser (window.FairFlowSolver) and in Node
 * (module.exports) so the same code is exercised by the test suite.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FairFlowSolver = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function createNetwork(numNodes) {
    return {
      numNodes,
      arcs: [], // forward arcs only, in insertion order
      adj: Array.from({ length: numNodes }, () => []),
    };
  }

  // cap and cost must be non-negative; tag carries app-level meaning.
  function addArc(net, from, to, cap, cost, tag) {
    if (!Number.isInteger(cap) || cap < 0) throw new Error('arc capacity must be a non-negative integer');
    if (typeof cost !== 'number' || !(cost >= 0)) throw new Error('arc cost must be non-negative');
    const fwd = { from, to, cap, cost, flow: 0, tag: tag || null, rev: null };
    const rev = { from: to, to: from, cap: 0, cost: -cost, flow: 0, tag: null, rev: null };
    fwd.rev = rev;
    rev.rev = fwd;
    net.adj[from].push(fwd);
    net.adj[to].push(rev);
    net.arcs.push(fwd);
    return fwd;
  }

  // Binary min-heap of [distance, node].
  function heapPush(heap, item) {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      const tmp = heap[p]; heap[p] = heap[i]; heap[i] = tmp;
      i = p;
    }
  }
  function heapPop(heap) {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        const tmp = heap[m]; heap[m] = heap[i]; heap[i] = tmp;
        i = m;
      }
    }
    return top;
  }

  // Runs SSP to exhaustion: maximum flow, min total cost among max flows.
  // Returns { flow, cost, iterations } and leaves flows on the network arcs.
  function minCostMaxFlow(net, s, t) {
    const n = net.numNodes;
    const potential = new Array(n).fill(0);
    const dist = new Array(n);
    const prevArc = new Array(n);
    let totalFlow = 0;
    let totalCost = 0;
    let iterations = 0;

    for (;;) {
      dist.fill(Infinity);
      prevArc.fill(null);
      dist[s] = 0;
      const heap = [[0, s]];
      while (heap.length > 0) {
        const [d, u] = heapPop(heap);
        if (d !== dist[u]) continue;
        for (const e of net.adj[u]) {
          if (e.cap - e.flow <= 0) continue;
          const rc = e.cost + potential[u] - potential[e.to];
          const nd = d + rc;
          if (nd < dist[e.to] - 1e-12) {
            dist[e.to] = nd;
            prevArc[e.to] = e;
            heapPush(heap, [nd, e.to]);
          }
        }
      }
      if (!prevArc[t]) break;

      for (let v = 0; v < n; v++) {
        if (dist[v] < Infinity) potential[v] += dist[v];
      }

      let aug = Infinity;
      for (let v = t; v !== s; v = prevArc[v].from) {
        aug = Math.min(aug, prevArc[v].cap - prevArc[v].flow);
      }
      let pathCost = 0;
      for (let v = t; v !== s; v = prevArc[v].from) {
        const e = prevArc[v];
        e.flow += aug;
        e.rev.flow -= aug;
        pathCost += e.cost;
      }
      totalFlow += aug;
      totalCost += aug * pathCost;
      iterations++;
      if (iterations > 100000) throw new Error('solver iteration guard tripped');
    }
    return { flow: totalFlow, cost: totalCost, iterations };
  }

  // Nodes reachable from s along arcs with residual capacity (forward or
  // backward). Used for min-cut / bottleneck analysis after a solve.
  function residualReachable(net, s) {
    const seen = new Array(net.numNodes).fill(false);
    const stack = [s];
    seen[s] = true;
    while (stack.length > 0) {
      const u = stack.pop();
      for (const e of net.adj[u]) {
        if (e.cap - e.flow > 0 && !seen[e.to]) {
          seen[e.to] = true;
          stack.push(e.to);
        }
      }
    }
    return seen;
  }

  return { createNetwork, addArc, minCostMaxFlow, residualReachable };
});
