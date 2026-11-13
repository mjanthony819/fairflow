/*
 * FairFlow live-UI checks with Playwright. Usage:
 *   node tests/ui.spec.mjs [baseURL]
 * Default baseURL is http://127.0.0.1:8137 (serve the repo root first).
 * The same script runs against the deployed GitHub Pages URL.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:8137/';
let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) passed++;
  else { failed++; failures.push(name + (detail ? ' :: ' + detail : '')); }
}

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 860 } });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', (err) => consoleErrors.push(String(err)));
const external = [];
page.on('request', (req) => {
  const u = req.url();
  if (!u.startsWith(BASE) && !u.startsWith('data:')) external.push(u);
});

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForSelector('[data-testid="summary-strip"] .stat');

// 1. shell
check('title', (await page.title()).includes('FairFlow'));
check('summary stats', (await page.locator('[data-testid="summary-strip"] .stat').count()) === 4);
check('roster cards kitchen', (await page.locator('#roster .shift-card').count()) === 6);
const seatsText = await page.locator('[data-testid="summary-strip"] .stat .num').first().innerText();
check('kitchen seats fraction', /^\d+\/16$/.test(seatsText), seatsText);

// 2. kitchen roster content: every chip name belongs to a scenario volunteer
const chipCount = await page.locator('#roster .chip:not(.empty)').count();
check('chips equal filled seats', seatsText.startsWith(chipCount + '/'), `${chipCount} chips vs ${seatsText}`);

// 3. switch to conference: late desk is short, explanation names the reason
await page.selectOption('[data-testid="scenario-select"]', 'conference');
await page.waitForSelector('[data-testid="shift-sat-late"]');
check('conference cards', (await page.locator('#roster .shift-card').count()) === 6);
check('late desk short card', (await page.locator('[data-testid="shift-sat-late"].short').count()) === 1);
check('late desk open chip', (await page.locator('[data-testid="shift-sat-late"] .chip.empty').count()) === 1);
const lateCard = await page.locator('[data-testid="unfilled-sat-late"]').innerText();
check('late desk explanation mentions Hugo', /Hugo Serrano/.test(lateCard), lateCard);
check('late desk recommendation present', /volunteer/i.test(lateCard) && /fill it/.test(lateCard), lateCard);

// 4. shelter: structural shortage diagnostic + unfilled handler slots explained
await page.selectOption('[data-testid="scenario-select"]', 'shelter');
await page.waitForSelector('[data-testid="shift-mon-handle"]');
await page.click('[data-testid="tab-export"]');
const diagRow = await page.locator('[data-testid="diag-handler"]').innerText();
check('handler structural shortage', /structural shortage of 1/.test(diagRow), diagRow);
const audit = await page.locator('[data-testid="audit-preview"]').innerText();
check('audit has header', audit.includes('FairFlow audit'));
check('audit has method note', audit.includes('successive shortest paths'));
check('audit names bottleneck', /shift limit/.test(audit));
await page.click('[data-testid="tab-board"]');
const unfilledCards = await page.locator('#unfilled .unfilled-card').count();
check('shelter has unfilled cards', unfilledCards >= 1, 'count=' + unfilledCards);

// 5. edit tab: matrix cell cycles off -> available -> preferred -> off
await page.click('[data-testid="tab-edit"]');
const cell = page.locator('[data-testid="cell-nina-mon-handle"]');
const s0 = await cell.getAttribute('data-state');
await cell.click();
const s1 = await cell.getAttribute('data-state');
await cell.click();
const s2 = await cell.getAttribute('data-state');
await cell.click();
const s3 = await cell.getAttribute('data-state');
const order = ['off', 'available', 'preferred'];
check('cell cycles', order[(order.indexOf(s0) + 1) % 3] === s1 && order[(order.indexOf(s1) + 1) % 3] === s2 && s3 === s0, `${s0}->${s1}->${s2}->${s3}`);

// 6. add volunteer + add shift
const beforeRows = await page.locator('#people-table tbody tr').count();
await page.fill('#add-person input[name="name"]', 'Test Person');
await page.fill('#add-person input[name="roles"]', 'handler');
await page.click('#add-person button');
check('volunteer added', (await page.locator('#people-table tbody tr').count()) === beforeRows + 1);
const beforeCols = await page.locator('.matrix thead th').count();
await page.fill('#add-shift input[name="name"]', 'Extra shift');
await page.fill('#add-shift input[name="slot"]', 'Sun 09:00');
await page.fill('#add-shift input[name="role"]', 'handler');
await page.click('#add-shift button');
check('shift added', (await page.locator('.matrix thead th').count()) === beforeCols + 1);

// 7. marking the new volunteer preferred on the new shift changes the roster
await cellToPref(page, 'test-person', 'extra-shift');
await page.click('[data-testid="tab-board"]');
const rosterText = await page.locator('#roster').innerText();
check('new assignment appears', rosterText.includes('Extra shift'), rosterText.slice(0, 200));

// reset back to pristine shelter
await page.click('[data-testid="reset-scenario"]');
await page.click('[data-testid="tab-edit"]');
check('reset restores rows', (await page.locator('#people-table tbody tr').count()) === 12);

async function cellToPref(page, vol, shift) {
  const sel = `[data-testid="cell-${vol}-${shift}"]`;
  for (let i = 0; i < 3; i++) {
    const st = await page.locator(sel).getAttribute('data-state');
    if (st === 'preferred') return;
    await page.click(sel);
  }
}

// 8. fairness weight re-solves (weight 0 vs 4 both keep coverage)
await page.selectOption('[data-testid="scenario-select"]', 'shelter');
await page.click('[data-testid="tab-board"]');
const seatsW2 = await page.locator('[data-testid="summary-strip"] .stat .num').first().innerText();
await page.locator('[data-testid="weight"]').fill('0');
const seatsW0 = await page.locator('[data-testid="summary-strip"] .stat .num').first().innerText();
await page.locator('[data-testid="weight"]').fill('4');
const seatsW4 = await page.locator('[data-testid="summary-strip"] .stat .num').first().innerText();
check('fairness keeps coverage', seatsW2 === seatsW0 && seatsW0 === seatsW4, `${seatsW0}/${seatsW2}/${seatsW4}`);

// 9. compare tab
await page.click('[data-testid="tab-compare"]');
await page.waitForSelector('[data-testid="compare-table"]');
check('compare rows', (await page.locator('[data-testid="compare-table"] tr').count()) === 9);
const cmpFill = await page.locator('[data-testid="cmp-seats-filled"]').innerText();
const m = cmpFill.match(/(\d+)\/(\d+)/g);
check('compare fills equal', m && m.length === 2 && m[0] === m[1], cmpFill);
const note = await page.locator('[data-testid="compare-note"]').innerText();
check('compare note honest', /never sacrifices coverage/.test(note), note);

// 10. flow tab
await page.click('[data-testid="tab-flow"]');
const svgEdges = await page.locator('#flow-diagram line').count();
const seatsNum = Number((await page.locator('[data-testid="cmp-seats-filled"]').innerText()).match(/(\d+)\//)[1]);
check('flow edges = filled seats', svgEdges === seatsNum, `${svgEdges} vs ${seatsNum}`);
check('at-limit nodes shown', (await page.locator('#flow-diagram circle[fill="#f3dfc2"]').count()) >= 1);
check('cut report items', (await page.locator('#cut-report .cut-item').count()) >= 1);

// 11. exports download real files
await page.click('[data-testid="tab-export"]');
const [csvDl] = await Promise.all([
  page.waitForEvent('download'),
  page.click('[data-testid="export-csv"]'),
]);
check('csv filename', csvDl.suggestedFilename().endsWith('.csv'), csvDl.suggestedFilename());
const csvText = await streamText(await csvDl.createReadStream());
check('csv header', csvText.startsWith('shift,slot,role,seat,volunteer,preference'));
check('csv has rows', csvText.trim().split('\n').length > 10);
const [auditDl] = await Promise.all([
  page.waitForEvent('download'),
  page.click('[data-testid="export-audit"]'),
]);
const auditText2 = await streamText(await auditDl.createReadStream());
check('audit download matches preview', auditText2.includes('FairFlow audit') && auditText2.includes('## Bottleneck'));
const [jsonDl] = await Promise.all([
  page.waitForEvent('download'),
  page.click('[data-testid="export-json"]'),
]);
const jsonText = await streamText(await jsonDl.createReadStream());
let parsed = null;
try { parsed = JSON.parse(jsonText); } catch {}
check('scenario json parses', !!parsed && parsed.id === 'shelter' && Array.isArray(parsed.volunteers));

async function streamText(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// 12. offline claim + console health
check('no external requests', external.length === 0, external.slice(0, 3).join(', '));
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${passed} passed, ${failed} failed (UI @ ${BASE})`);
if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log(' - ' + f)); }
process.exit(failed === 0 ? 0 : 1);
