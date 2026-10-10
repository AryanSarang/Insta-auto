#!/usr/bin/env node
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_DIR = join(ROOT, 'engine');
const EXAMPLES_DIR = join(ROOT, 'examples');

async function testSpec(specPath, label) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const numTiers = spec.tiers.length;
  const expectedMerges = Math.pow(2, numTiers - 1) - 1;
  const expectedSpawns = Math.pow(2, numTiers - 1);

  console.log(`\n=== Testing: ${label} (${numTiers} tiers, need ${expectedSpawns} spawns, ${expectedMerges} merges) ===`);

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 360, height: 640 } });
  const page = await context.newPage();

  page.on('pageerror', err => console.error('  PAGE ERROR:', err.message));

  const enrichedSpec = { ...spec, maxSeconds: 45, minSeconds: 25 };
  await page.addInitScript(`window.SPEC = ${JSON.stringify(enrichedSpec)};`);
  await page.addInitScript(`window.ICON_DATA = {};`);

  await page.goto(`file://${join(ENGINE_DIR, 'merge-jar.html')}`, { waitUntil: 'load', timeout: 30_000 });

  const startMs = Date.now();
  await page.waitForFunction('window.SIM && (window.SIM.duration > 0 || window.SIM.failed)', { timeout: 60_000 });
  const simMs = Date.now() - startMs;

  const failed = await page.evaluate(() => !!window.SIM.failed);
  if (failed) {
    console.log(`  Pre-simulation: ${simMs}ms`);
    console.error('  FAIL: Simulation did not complete (SIM.failed = true)');
    await browser.close();
    return false;
  }

  const simInfo = await page.evaluate(() => ({
    duration: window.SIM.duration,
    totalFrames: window.SIM.totalFrames,
    eventCount: window.SIM.events.length,
    events: window.SIM.events,
  }));

  console.log(`  Pre-simulation: ${simMs}ms`);
  console.log(`  Duration: ${simInfo.duration.toFixed(1)}s (${simInfo.totalFrames} frames)`);
  console.log(`  Events: ${simInfo.eventCount}`);

  const mergeEvents = simInfo.events.filter(e => e.sfx.startsWith('merge_'));
  const finalEvent = simInfo.events.find(e => e.sfx === 'final');
  console.log(`  Merge events: ${mergeEvents.length}, Final event: ${finalEvent ? 'yes' : 'NO'}`);

  // Test seek works
  await page.evaluate(() => { window.SIM.seek(0); });
  await page.evaluate(() => { window.SIM.seek(window.SIM.duration / 2); });
  await page.evaluate(() => { window.SIM.seek(window.SIM.duration - 0.1); });
  console.log(`  Seek: OK`);

  // Determinism: run with same seed again
  const page2 = await context.newPage();
  await page2.addInitScript(`window.SPEC = ${JSON.stringify(enrichedSpec)};`);
  await page2.addInitScript(`window.ICON_DATA = {};`);
  await page2.goto(`file://${join(ENGINE_DIR, 'merge-jar.html')}`, { waitUntil: 'load', timeout: 30_000 });
  await page2.waitForFunction('window.SIM && (window.SIM.duration > 0 || window.SIM.failed)', { timeout: 60_000 });

  const simInfo2 = await page2.evaluate(() => ({
    duration: window.SIM.duration,
    eventCount: window.SIM.events.length,
    events: window.SIM.events,
  }));

  const deterministicDuration = Math.abs(simInfo.duration - simInfo2.duration) < 0.001;
  const deterministicEvents = simInfo.eventCount === simInfo2.eventCount;
  console.log(`  Determinism: duration=${deterministicDuration}, events=${deterministicEvents}`);

  if (!deterministicDuration || !deterministicEvents) {
    console.error('  FAIL: Simulation is not deterministic!');
  }

  let pass = true;
  if (simMs > 5000) { console.error('  WARN: Pre-simulation took >5s'); }
  if (simInfo.duration < 10) { console.error('  FAIL: Duration too short'); pass = false; }
  if (simInfo.duration > 120) { console.error('  FAIL: Duration too long'); pass = false; }
  if (!finalEvent) { console.error('  FAIL: No final event'); pass = false; }
  if (!deterministicDuration) pass = false;

  await page2.close();
  await browser.close();

  console.log(`  Result: ${pass ? 'PASS' : 'FAIL'}`);
  return pass;
}

async function testRandomSeeds(numTests = 5) {
  console.log(`\n=== Testing ${numTests} random seeds ===`);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 360, height: 640 } });

  let passed = 0;
  for (let i = 0; i < numTests; i++) {
    const numTiers = 5 + Math.floor(Math.random() * 4); // 5-8
    const tiers = [];
    const emojis = ['🐛', '🐜', '🐝', '🐞', '🦋', '🦅', '🦈', '🐉'];
    for (let t = 0; t < numTiers; t++) {
      tiers.push({ name: `Tier${t}`, icon: emojis[t] });
    }

    const spec = {
      title: `Random test ${i}`,
      hook: 'Test hook text here',
      tiers,
      sounds: {
        merge: Array.from({ length: numTiers - 1 }, (_, j) => ({ query: `test${j}`, style: 'pop' })),
        final: { query: 'test_final', style: 'fanfare' },
      },
      container: { shape: 'jar', color: '#8B4513' },
      palette: { bg: '#1a1a2e', text: '#ffffff', accent: '#e94560' },
      physics: { bounciness: 0.5 + Math.random() * 0.4, gravity: ['low', 'normal', 'high'][Math.floor(Math.random() * 3)] },
      finalText: 'Test punchline!',
      mood: 'light',
      caption: 'Test caption',
      hashtags: [],
      seed: Math.floor(Math.random() * 2147483647),
      maxSeconds: 45,
      minSeconds: 25,
    };

    const page = await context.newPage();
    page.on('pageerror', err => console.error(`  [seed=${spec.seed}] PAGE ERROR:`, err.message));

    await page.addInitScript(`window.SPEC = ${JSON.stringify(spec)};`);
    await page.addInitScript(`window.ICON_DATA = {};`);
    await page.goto(`file://${join(ENGINE_DIR, 'merge-jar.html')}`, { waitUntil: 'load', timeout: 30_000 });

    const startMs = Date.now();
    try {
      await page.waitForFunction('window.SIM && (window.SIM.duration > 0 || window.SIM.failed)', { timeout: 30_000 });
    } catch {
      console.error(`  [${i}] FAIL: Simulation timed out (seed=${spec.seed}, tiers=${numTiers})`);
      await page.close();
      continue;
    }

    const simMs = Date.now() - startMs;
    const isFailed = await page.evaluate(() => !!window.SIM.failed);
    if (isFailed) {
      console.error(`  [${i}] FAIL: Sim did not complete (seed=${spec.seed}, tiers=${numTiers}, ${simMs}ms)`);
      await page.close();
      continue;
    }

    const info = await page.evaluate(() => ({
      duration: window.SIM.duration,
      totalFrames: window.SIM.totalFrames,
      eventCount: window.SIM.events.length,
      hasFinal: window.SIM.events.some(e => e.sfx === 'final'),
    }));

    const ok = info.hasFinal && info.duration > 5 && simMs < 10000;
    console.log(`  [${i}] seed=${spec.seed} tiers=${numTiers} dur=${info.duration.toFixed(1)}s sim=${simMs}ms final=${info.hasFinal} ${ok ? 'PASS' : 'FAIL'}`);
    if (ok) passed++;

    await page.close();
  }

  await browser.close();
  console.log(`\nRandom seed tests: ${passed}/${numTests} passed`);
  return passed === numTests;
}

async function main() {
  let allPass = true;

  // Test example specs
  allPass = await testSpec(join(EXAMPLES_DIR, 'monkey-evolution.json'), 'Monkey Evolution') && allPass;
  allPass = await testSpec(join(EXAMPLES_DIR, 'money-evolution.json'), 'Money Evolution') && allPass;

  // Test random seeds
  allPass = await testRandomSeeds(20) && allPass;

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Overall: ${allPass ? 'ALL PASSED' : 'SOME FAILED'}`);
  process.exitCode = allPass ? 0 : 1;
}

main().catch(e => {
  console.error('Test error:', e);
  process.exitCode = 1;
});
