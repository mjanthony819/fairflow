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
// Start from a pristine slate: persisted state from earlier sessions must not leak in.
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
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

// 12. persistence: table edits survive a reload; reset clears them
await page.click('[data-testid="tab-edit"]');
await page.fill('#people-table tbody tr:first-child input[data-field="name"]', 'Persisted Name');
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('[data-testid="summary-strip"] .stat');
check('persistence keeps scenario', (await page.locator('[data-testid="scenario-select"]').inputValue()) === 'shelter');
await page.click('[data-testid="tab-edit"]');
const persistedName = await page.locator('#people-table tbody tr:first-child input[data-field="name"]').inputValue();
check('persistence survives reload', persistedName === 'Persisted Name', persistedName);
await page.click('[data-testid="reset-scenario"]');
const resetName = await page.locator('#people-table tbody tr:first-child input[data-field="name"]').inputValue();
check('reset clears persisted edits', resetName !== 'Persisted Name', resetName);

// 13. save copy as roster: custom rosters live in the dropdown and keep edits
await page.fill('#save-copy input[name="title"]', 'Shelter week 2');
await page.click('[data-testid="save-copy-btn"]');
const customId = await page.locator('[data-testid="scenario-select"]').inputValue();
check('custom roster selected', customId.startsWith('shelter-week-2'), customId);
const optTexts = await page.locator('#scenario-select option').allInnerTexts();
check('custom roster in dropdown', optTexts.some((t) => t.includes('Shelter week 2')), optTexts.join('|'));
check('reset hidden for custom', (await page.locator('[data-testid="reset-scenario"]').isVisible()) === false);
check('delete visible for custom', (await page.locator('[data-testid="delete-roster"]').isVisible()) === true);
await page.fill('#people-table tbody tr:first-child input[data-field="name"]', 'Copy Edited');
await page.selectOption('[data-testid="scenario-select"]', 'kitchen');
await page.selectOption('[data-testid="scenario-select"]', customId);
await page.click('[data-testid="tab-edit"]');
check('custom roster keeps edits across switches', (await page.locator('#people-table tbody tr:first-child input[data-field="name"]').inputValue()) === 'Copy Edited');
// deleting the custom roster returns to the first bundled scenario
await page.click('[data-testid="delete-roster"]');
check('delete returns to bundled', (await page.locator('[data-testid="scenario-select"]').inputValue()) === 'kitchen');

// 14. import: overlap fixture lands with warnings; recovery copy kept; bad file rejected
const { writeFileSync } = await import('fs');
const clashFixture = '/tmp/fairflow-clash-import.json';
writeFileSync(clashFixture, JSON.stringify({
  title: 'Clash Test',
  volunteers: [{ name: 'Solo Sam', roles: ['r'], maxShifts: 3 }],
  shifts: [
    { name: 'Morning', slot: 'Sat 08:00–12:00', role: 'r', capacity: 1 },
    { name: 'Midday', slot: 'Sat 10:00–14:00', role: 'r', capacity: 1 },
    { name: 'Odd', slot: 'whenever', role: 'r', capacity: 1 },
  ],
  availability: { 'solo-sam': { morning: 'available', midday: 'available', odd: 'available' } },
}));
const badFixture = '/tmp/fairflow-bad-import.json';
writeFileSync(badFixture, 'this is not json');
await page.fill('#people-table tbody tr:first-child input[data-field="name"]', 'Kitchen Edited');
await page.click('[data-testid="tab-export"]');
await page.locator('[data-testid="import-file"]').setInputFiles(clashFixture);
await page.waitForSelector('[data-testid="import-status"].ok');
const importMsg = await page.locator('[data-testid="import-status"]').innerText();
check('import success message', /Imported "Clash Test"/.test(importMsg), importMsg);
check('import keeps recovery copy', /Recovered/.test(importMsg), importMsg);
check('import selects imported roster', (await page.locator('[data-testid="scenario-select"]').inputValue()).startsWith('clash-test'));
await page.click('[data-testid="tab-board"]');
await page.waitForSelector('[data-testid="conflict-warnings"]');
const warnText = await page.locator('[data-testid="conflict-warnings"]').innerText();
check('overlap warning names volunteer', /Solo Sam/.test(warnText), warnText);
check('overlap warning says solver does not prevent', /does not prevent clashes/.test(warnText), warnText);
const uncheckedText = await page.locator('[data-testid="conflict-unchecked"]').innerText();
check('unchecked pairs reported', /whenever/.test(uncheckedText) && /manual check/.test(uncheckedText), uncheckedText);
const auditClash = await page.locator('[data-testid="tab-export"]').click().then(() => page.locator('[data-testid="audit-preview"]').innerText());
check('audit carries conflict section', /## Time conflicts/.test(auditClash) && /WARNING: Solo Sam/.test(auditClash) && /UNCHECKED/.test(auditClash));
// recovery copy is in the dropdown
const optTexts2 = await page.locator('#scenario-select option').allInnerTexts();
check('recovery roster in dropdown', optTexts2.some((t) => /Recovered/.test(t)), optTexts2.join('|'));
// invalid file: rejected, nothing changes
await page.locator('[data-testid="import-file"]').setInputFiles(badFixture);
await page.waitForSelector('[data-testid="import-status"].error');
const errMsg = await page.locator('[data-testid="import-status"]').innerText();
check('bad import rejected', /not valid JSON/.test(errMsg) && /nothing was changed/i.test(errMsg), errMsg);
check('bad import keeps roster', (await page.locator('[data-testid="scenario-select"]').inputValue()).startsWith('clash-test'));

// 15. print handout is populated
const ph = await page.locator('[data-testid="print-handout"]').innerText();
check('print handout has title', /FairFlow roster — Clash Test/.test(ph), ph.slice(0, 120));
check('print handout has conflict warning', /WARNING: Solo Sam/.test(ph));
check('print handout has workloads', /Solo Sam 3\/3/.test(ph), ph.slice(-300));
check('print button present', (await page.locator('[data-testid="print-handout-btn"]').count()) === 1);

// 16. offline claim + console health
check('no external requests', external.length === 0, external.slice(0, 3).join(', '));
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${passed} passed, ${failed} failed (UI @ ${BASE})`);
if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log(' - ' + f)); }
process.exit(failed === 0 ? 0 : 1);
