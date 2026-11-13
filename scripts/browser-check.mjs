/**
 * Floodline - Automated Browser E2E & Operator Workflow Verification
 * Uses puppeteer-core with Microsoft Edge / Google Chrome to verify:
 * - Two clients following different stations simultaneously
 * - Metric and range changes
 * - Fault injection and recovery
 * - Historical incident replay from MongoDB
 * - Disconnect and reconnect cursor synchronization
 * - 390px mobile viewport rendering
 */

import fs from 'fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import puppeteer from 'puppeteer-core';
import { createServer } from '../server/index.mjs';

function getBrowserPath() {
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const edgeLinux = '/usr/bin/microsoft-edge';
  const chromeLinux = '/usr/bin/google-chrome';

  if (fs.existsSync(edgePath)) return edgePath;
  if (fs.existsSync(chromePath)) return chromePath;
  if (fs.existsSync(edgeLinux)) return edgeLinux;
  if (fs.existsSync(chromeLinux)) return chromeLinux;

  throw new Error('No compatible Edge or Chrome browser found.');
}

async function runBrowserChecks() {
  console.log('\n===============================================================');
  console.log('🌐 FLOODLINE OPERATOR WORKFLOW BROWSER VERIFICATION');
  console.log('===============================================================\n');

  const browserPath = getBrowserPath();
  console.log(`[Browser Check] Browser detected at: ${browserPath}`);

  const databaseName = 'floodline_browser_' + randomUUID().replaceAll('-', '');
  const uri = new URL(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/floodline');
  uri.pathname = '/' + databaseName;
  const mongo = new MongoClient(uri.toString());
  let serverInstance;
  let browser;
  try {
    process.env.DEMO_MODE = 'true';
    serverInstance = await createServer({ mongoUri: uri.toString(), simulatorRate: 288 });
    await new Promise((resolve, reject) => {
      serverInstance.server.once('error', reject);
      serverInstance.server.listen(0, '127.0.0.1', resolve);
    });
    const baseUrl = 'http://127.0.0.1:' + serverInstance.server.address().port;
    browser = await puppeteer.launch({ executablePath: browserPath, headless: true });
    const pageErrors = [];
    console.log('\n--- Step 1: Open Client 1 (Canal Junction) ---');
    const page1 = await browser.newPage();
    page1.on('pageerror', error => pageErrors.push(error.message));
    await page1.setViewport({ width: 1280, height: 800 });
    await page1.setRequestInterception(true);
    page1.on('request', request => request.url().startsWith(baseUrl + '/') ? request.continue() : request.abort());
    await page1.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    await page1.waitForSelector('h1', { timeout: 10000 });
    assert.equal(await page1.$eval('header', element => getComputedStyle(element).display), 'flex');
    const title1 = await page1.$eval('h1', el => el.textContent);
    console.log(`✓ Client 1 active on station: ${title1}`);

    console.log('\n--- Step 2: Open Client 2 & Switch to East Sluice ---');
    const page2 = await browser.newPage();
    page2.on('pageerror', error => pageErrors.push(error.message));
    await page2.setViewport({ width: 1280, height: 800 });
    await page2.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page2.waitForSelector('h1', { timeout: 10000 });

    // Click East Sluice in station roster
    const switched = await page2.evaluate(() => {
      const allDivs = Array.from(document.querySelectorAll('div.cursor-pointer.justify-between'));
      const target = allDivs.find(d => d.textContent.includes('East Sluice Pump House'));
      if (target) {
        target.click();
        return true;
      }
      return false;
    });
    console.log(`✓ Client 2 clicked East Sluice: ${switched}`);
    assert.equal(switched, true);
    await new Promise(r => setTimeout(r, 800));

    const title2 = await page2.$eval('h1', el => el.textContent);
    assert.match(title2, /East Sluice/);
    assert.match(title1, /Canal Junction/);
    console.log(`✓ Client 2 following independent station: ${title2}`);
    console.log(`✓ Verified two clients follow different stations simultaneously.`);

    console.log('\n--- Step 3: Test Metric Channel & Time Window Changes ---');
    const metricChanged = await page1.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const target = btns.find(b => b.textContent.trim() === 'Water');
      if (target) {
        target.click();
        return true;
      }
      return false;
    });
    console.log(`✓ Client 1 metric toggled to Water: ${metricChanged}`);
    assert.equal(metricChanged, true);
    await new Promise(r => setTimeout(r, 400));

    const winChanged = await page1.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const target = btns.find(b => b.textContent.trim() === '1m');
      if (target) {
        target.click();
        return true;
      }
      return false;
    });
    console.log(`✓ Client 1 time window set to 1m: ${winChanged}`);
    assert.equal(winChanged, true);
    await new Promise(r => setTimeout(r, 400));

    console.log('\n--- Step 4: Inject Storm Surge Fault & Observe Live Propagation ---');
    const faultTriggered = await page1.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const target = btns.find(b => b.textContent.includes('Storm Surge'));
      if (target) {
        target.click();
        return true;
      }
      return false;
    });
    console.log(`✓ Storm surge triggered on Canal Junction: ${faultTriggered}`);
    assert.equal(faultTriggered, true);

    // Wait 2.5 seconds for telemetry to elevate
    await new Promise(r => setTimeout(r, 2500));

    // Client 2 sees Fleet severity alert while remaining on East Sluice
    await page2.waitForFunction(() => /Crit:\s+[1-6]/.test(document.body.innerText));
    assert.match(await page2.$eval('h1', element => element.textContent), /East Sluice/);
    await page2.select('select[aria-label="Filter stations"]', 'attention');
    await page2.waitForFunction(() => {
      const rows = Array.from(document.querySelectorAll('div.cursor-pointer.justify-between'));
      return rows.some(row => row.textContent.includes('Canal Junction')) &&
        !rows.some(row => row.textContent.includes('East Sluice'));
    });
    await page2.select('select[aria-label="Filter stations"]', 'all');
    console.log('✓ East Sluice client received the fleet alert while keeping its own station selected.');

    // Clear fault
    const faultCleared = await page1.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const target = btns.find(b => b.textContent.trim() === 'Clear');
      if (target) {
        target.click();
        return true;
      }
      return false;
    });
    console.log(`✓ Cleared fault on Canal Junction: ${faultCleared}`);
    assert.equal(faultCleared, true);
    await new Promise(r => setTimeout(r, 1000));

    console.log('\n--- Step 5: Test Historical Incident Replay ---');
    const replayClicked = await page2.evaluate(() => {
      const links = Array.from(document.querySelectorAll('button'));
      const target = links.find(el => el.textContent.trim() === 'Replay');
      if (target) {
        target.click();
        return true;
      }
      return false;
    });
    console.log(`✓ Clicked historical incident replay: ${replayClicked}`);
    await new Promise(r => setTimeout(r, 1000));

    const hasReplayBanner = await page2.evaluate(() => {
      return document.body.innerText.includes('HISTORICAL REPLAY');
    });
    console.log(`✓ Historical replay window locked and loaded from MongoDB: ${hasReplayBanner}`);
    assert.equal(hasReplayBanner, true);
    const csv = await page2.evaluate(async () => {
      const link = document.querySelector('a[download][href$="/export"]');
      if (!link) return null;
      const response = await fetch(link.href);
      return { status: response.status, body: await response.text() };
    });
    assert.equal(csv?.status, 200);
    assert.match(csv.body, /^timestamp,iso_time,station_id,/);
    assert.ok(csv.body.split('\n').length > 2);

    // Return to live
    const returnedToLive = await page2.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const target = btns.find(b => b.textContent.trim().toLowerCase().includes('return to live'));
      if (target) {
        target.click();
        return true;
      }
      return false;
    });
    console.log(`✓ Returned to live stream: ${returnedToLive}`);
    assert.equal(returnedToLive, true);
    await new Promise(r => setTimeout(r, 500));

    console.log('\n--- Step 6: Test Disconnect & Reconnect Recovery ---');
    // Reconnect Client 1 and wait for the actual backfill response.
    const diagOpened = await page1.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const target = btns.find(b => b.textContent.includes('Diagnostics'));
      if (target) {
        target.click();
        return true;
      }
      return false;
    });
    console.log(`✓ Diagnostics modal opened: ${diagOpened}`);
    assert.equal(diagOpened, true);
    await new Promise(r => setTimeout(r, 500));

    const backfill = page1.waitForResponse(response =>
      response.ok() && response.url().includes('/stations/canal-junction/history?'));
    const reconnected = await page1.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const target = btns.find(b => b.textContent.includes('Test Reconnect'));
      if (target) {
        target.click();
        return true;
      }
      return false;
    });
    console.log(`✓ Reconnect test triggered: ${reconnected}`);
    assert.equal(reconnected, true);
    await backfill;

    await page1.waitForFunction(() => {
      return Array.from(document.querySelectorAll('header span'))
        .some(span => span.textContent.trim().toLowerCase() === 'connected');
    });
    console.log('✓ Reconnection restored the station history and connected status.');

    console.log('\n--- Step 7: Test 390px Mobile Viewport Layout ---');
    const mobilePage = await browser.newPage();
    mobilePage.on('pageerror', error => pageErrors.push(error.message));
    await mobilePage.setViewport({ width: 390, height: 844, isMobile: true });
    await mobilePage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await mobilePage.waitForSelector('h1', { timeout: 10000 });

    const scrollWidth = await mobilePage.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await mobilePage.evaluate(() => document.documentElement.clientWidth);
    assert.ok(scrollWidth <= clientWidth, `Mobile viewport overflows by ${scrollWidth - clientWidth}px`);
    assert.deepEqual(pageErrors, []);
    console.log(`✓ 390px Viewport: scrollWidth=${scrollWidth}, clientWidth=${clientWidth}`);
    console.log('✓ Mobile responsive layout verified with zero layout blowout.');

    console.log('\n--- Step 8: Verify the guided demo from a non-default station ---');
    await page2.bringToFront();
    const tourReplaysHistory = page2.waitForResponse(response => {
      const url = new URL(response.url());
      return response.ok() && url.pathname.endsWith('/canal-junction/history') && !url.searchParams.has('beforeSeq');
    }, { timeout: 20000 });
    await page2.evaluate(() => Array.from(document.querySelectorAll('div.cursor-pointer.justify-between'))
      .find(row => row.textContent.includes('East Sluice Pump House')).click());
    await page2.waitForSelector('button[title="Run guided demo"]:enabled');
    await page2.$eval('button[title="Run guided demo"]', button => button.click());
    await page2.waitForFunction(() => document.body.innerText.includes('1/5: Monitoring Canal Junction'));
    await tourReplaysHistory;
    assert.match(await page2.$eval('h1', element => element.textContent), /Canal Junction/);
    await page2.waitForFunction(() => document.body.textContent.includes('Demo walkthrough complete'), {
      timeout: 20000, polling: 250
    });
    assert.equal(serverInstance.simulator.getActiveFaults().length, 0);
    assert.deepEqual(pageErrors, []);
    console.log('✓ Guided demo triggered and cleared the Canal Junction fault and opened its archive.');

    console.log('\n===============================================================');
    console.log('🎉 ALL OPERATOR BROWSER WORKFLOW CHECKS PASSED SUCCESSFULLY!');
    console.log('===============================================================\n');
  } finally {
    await browser?.close();
    await serverInstance?.shutdown();
    try { await mongo.db(databaseName).dropDatabase(); }
    finally { await mongo.close(); }
  }
}

runBrowserChecks().catch(err => {
  console.error('[Browser Check Error]', err);
  process.exit(1);
});
