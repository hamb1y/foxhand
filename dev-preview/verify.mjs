// Behavioral checks for the local review and the changed UI, using disposable Firefox.
import assert from 'node:assert/strict';
import { firefox } from 'playwright';
const browser = await firefox.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const base = 'http://localhost:8840';
try {
  await page.goto(base + '/_ext/popup.html?state=ready');
  await page.locator('#pause').click();
  await page.waitForFunction(() => document.querySelector('#pause').textContent.includes('Resume'));
  assert.match(await page.locator('#hint').textContent(), /refused until you resume/i);
  await page.locator('#pause').click();
  await page.waitForFunction(() => document.querySelector('#state').textContent === 'Ready');
  console.log('ok popup pause/resume and state hints');
  await page.goto(base + '/_ext/options.html?state=empty');
  await page.locator('#events a').click();
  assert.equal(new URL(page.url()).hash, '#connect');
  assert.match(await page.locator('#safety').textContent(), /AI sets it itself|AI supplies|human|prompt/i);
  console.log('ok activity recovery link and safety explanation');
  await page.goto(base + '/_ext/onboarding.html?state=connected');
  await page.waitForFunction(() => document.querySelector('#p3').className === 'cur');
  console.log('ok onboarding advances after the first command');
  await page.goto(base + '/_ext/announcement.html');
  await page.locator('#announcement').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#announcement a').count(), 3);
  assert.equal(await page.locator('#done').isVisible(), true);
  assert.equal(await page.locator('#announcement').evaluate(el => getComputedStyle(el).textAlign), 'center');
  console.log('ok approved announcement, links and Done render under CSP');
  await page.goto(base);
  const tabs = page.locator('[data-group="ai"] [role="tab"]');
  await tabs.first().focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await tabs.last().getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowRight');
  assert.equal(await tabs.first().getAttribute('aria-selected'), 'true');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true }));
  await page.locator('.copy:visible').first().click();
  assert.equal(await page.locator('.copy:visible').first().textContent(), 'Press Ctrl+C');
  assert.ok(await page.evaluate(() => getSelection().toString().length > 0));
  console.log('ok website keyboard tab wrapping and clipboard fallback');
  for (const route of ['/', '/_ext/options.html', '/_ext/onboarding.html', '/_ext/announcement.html']) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + route);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `horizontal overflow: ${route}`);
  }
  console.log('ok mobile website/settings/setup/announcement fit');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + '/_review/');
  for (const area of ['popup', 'onboarding', 'settings', 'announcement', 'website']) {
    await page.selectOption('#screen', area);
    await page.frameLocator('#frameAfter').locator('body').waitFor();
    assert.equal(await page.locator('#frameAfter').count(), 1);
  }
  await page.selectOption('#screen', 'popup');
  await page.waitForFunction(() => ['frameBefore', 'frameAfter'].every(id => document.getElementById(id).contentDocument?.querySelector('#state')?.textContent === 'Ready'));
  await page.evaluate(() => Promise.all(['frameBefore', 'frameAfter'].map(id => document.getElementById(id).contentDocument.fonts.ready)));
  await page.screenshot({ path: 'dev-preview/review/screens/gallery.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('ok interactive gallery; no page errors');
} finally { await browser.close(); }
