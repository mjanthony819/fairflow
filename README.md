# FairFlow — volunteer shift assignment, solved and explained

FairFlow is a browser-local workbench for the recurring headache of volunteer
coordinators: who should cover which shift? You enter volunteers (roles,
personal shift limits), shifts (role needed, seats), and each person's
availability and preferences. FairFlow computes an assignment that fills as
many seats as physically possible and, among those, the best one for your
chosen priority — then **explains every seat it could not fill** instead of
silently leaving gaps.

Everything runs in the browser. No account, no server, no build step, no
runtime dependencies. Open `index.html` or visit the deployed page and it
works, including offline.

## What it does

- **Optimal rostering** — a min-cost max-flow solver (successive shortest
  paths with Johnson potentials, written from scratch in ~200 lines) assigns
  volunteers to shifts under role requirements, one-seat-per-person-per-shift,
  and personal shift limits.
- **Preference vs fairness** — run the same data in pure preference mode or
  with a fairness weight. In fairness mode each volunteer's limit becomes
  unit arcs costing `w×k` for their k-th shift, so spreading work is cheaper
  than stacking it. Coverage never drops: both modes fill the same seats.
- **Honest bottleneck explanations** — after solving, a residual-graph
  min-cut analysis reports exactly which personal limits and seats bind, and
  each unfilled slot gets a plain-language reason plus a concrete
  recommendation ("raise Asha's limit by 1" / "add 2 more cook volunteers").
- **Pre-solve capacity check** — per role: seats demanded vs the most its
  qualified volunteers could cover, so structural shortages are visible
  before anyone solves anything.
- **Editable scenarios** — three bundled synthetic scenarios; edit people,
  shifts, limits, and click-cycle the availability matrix. Re-solves live.
- **Exports** — roster CSV, a full audit report (method note included), and
  the scenario as JSON. Generated locally in the page.

## Running it

It is a static site. Open `index.html` directly, serve the folder with any
static server, or use the GitHub Pages deployment. No install, no keys.

## Tests

```
node run-tests.mjs        # engine: 141 checks
node ui.spec.mjs [URL]    # live UI: 34 Playwright checks (needs Chrome)
```

The engine suite includes a **brute-force oracle**: 400 randomly generated
tiny instances × 2 cost modes, where every result (filled seats and exact
total cost) must agree with exhaustive enumeration of all legal assignments,
plus legality invariants on every assignment and the bottleneck invariant
(every candidate for an unfilled seat is provably at a limit or already on
that shift).

## Scope and limits

The solver is optimal **for the stated model only**: roles, limits, three
availability states, one seat per person per shift. It does not model
overlapping-time conflicts, travel, seniority, or labour rules. Ties between
equally good assignments break deterministically by input order. All bundled
people, organisations and events are synthetic.

## Credits and AI assistance

The application source (HTML, CSS, the solver, model, scenarios, tests) was
written within the LaunchPad Hacks build window with AI assistance
(Instinct), directed and reviewed by the author. **No earlier project code
was reused, and the app has zero runtime libraries.** Tools used during the
build: Node.js (test runner), Playwright + Chrome (UI checks), ffmpeg
(demo video assembly), and AI text-to-speech (demo narration). The demo
video's narration is AI-generated speech.
