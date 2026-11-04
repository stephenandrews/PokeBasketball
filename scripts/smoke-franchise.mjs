// One-shot smoke test of the live site: start a Random franchise, sign the founding papers,
// and check the hub shows the new economy/captain/plays features. Dev aid, not CI.
//   node scripts/smoke-franchise.mjs [url]
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const URL = process.argv[2] ?? 'https://pokebball.zublo.ai/';
const dir = join(homedir(), '.cache/ms-playwright');
const c = existsSync(dir) && readdirSync(dir).filter((d) => d.startsWith('chromium-')).sort().pop();
const chrome = process.env.CHROME || (c ? join(dir, c, 'chrome-linux64/chrome') : ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync));

const browser = await chromium.launch({ executablePath: chrome });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('crash', () => { console.log('✗ PAGE CRASHED'); process.exit(1); });
const fails = [];
const check = (name, ok) => { console.log(`${ok ? '✓' : '✗'} ${name}`); if (!ok) fails.push(name); };

await page.goto(URL, { waitUntil: 'load' });
check('title is PokeBBall', (await page.title()) === 'PokeBBall');

// Start with: Random → New franchise → founding dialog.
await page.click('[data-v="random"]');
await page.click('[data-go="new"]');
await page.waitForSelector('.fc-dialog');
check('signature pad shown', await page.isVisible('.fc-sig-pad'));
const pad = await page.$('.fc-sig-pad');
const box = await pad.boundingBox();
await page.mouse.move(box.x + 30, box.y + 55);
await page.mouse.down();
await page.mouse.move(box.x + 150, box.y + 30, { steps: 10 });
await page.mouse.move(box.x + 250, box.y + 80, { steps: 10 });
await page.mouse.up();
await page.click('[data-fc="yes"]');
await page.waitForSelector('.hub', { timeout: 15000 });

const hub = await page.innerHTML('.hub');
check('cash on hand shown ($10.0M)', hub.includes('$10.0M'));
check('payroll shown', hub.includes('payroll'));
check("owner's signature in the header", await page.isVisible('.owner-sig'));
check('Sim season button', hub.includes('data-a="sim-season"'));
check('Practice button', hub.includes('data-a="practice"'));
check('salaries on roster rows', /\$\d+\.\dM\/yr/.test(hub));
check('type chips on roster rows', (await page.$$('.roster-tbl .types i')).length > 0);

// Captain: edit lineup → make the first player captain.
await page.click('[data-a="lineup-edit"]');
await page.click('.roster-tbl [data-capt]');
check('captain C appears', await page.isVisible('.roster-tbl .capt'));
await page.click('[data-a="lineup-done"]');

// Trade sheet: cash stepper present.
await page.click('[data-a="trade"]');
await page.waitForSelector('.trade-sheet');
check('trade cash sweetener', await page.isVisible('.trade-cash'));
check('types in trade sheet', (await page.$$('.trade-sheet .types i')).length > 0);
await page.click('[data-a="close-trade"]');

// Service worker + manifest.
const swOk = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return false;
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  return !!reg?.active;
});
check('service worker active', swOk);
check('manifest linked', await page.evaluate(() => !!document.querySelector('link[rel="manifest"]')));

// Save then reload: economy survives a round trip.
await page.reload({ waitUntil: 'load' });
await page.click('[data-go="continue"]');
await page.waitForSelector('.hub');
check('franchise save round-trips', (await page.innerHTML('.hub')).includes('payroll'));

await page.screenshot({ path: '/tmp/pokebball-hub.png', fullPage: false });
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nAll smoke checks passed.');
process.exit(fails.length ? 1 : 0);
