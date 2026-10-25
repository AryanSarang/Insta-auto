import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn as spawnProc } from 'node:child_process';
import { chromium } from 'playwright';
import { ROOT, log, warn } from './util.js';

export async function renderSpec(spec, icons, outDir, opts = {}) {
  const fps = opts.fps || 30;
  const engineDir = join(ROOT, 'engine');
  const htmlPath = join(engineDir, 'merge-jar.html');

  mkdirSync(outDir, { recursive: true });

  const iconData = {};
  for (const [emoji, path] of Object.entries(icons)) {
    if (path && existsSync(path)) {
      const buf = readFileSync(path);
      iconData[emoji] = `data:image/png;base64,${buf.toString('base64')}`;
    }
  }

  const enrichedSpec = {
    ...spec,
    maxSeconds: opts.maxSeconds || 90,
    minSeconds: opts.minSeconds || 30,
  };

  log('Launching Playwright browser...');
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    viewport: { width: 360, height: 640 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });

  const page = await context.newPage();

  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('file:') || url.startsWith('data:')) {
      return route.continue();
    }
    return route.abort();
  });

  await page.addInitScript(`window.SPEC = ${JSON.stringify(enrichedSpec)};`);
  await page.addInitScript(`window.ICON_DATA = ${JSON.stringify(iconData)};`);

  page.on('pageerror', err => {
    throw new Error(`Page script error: ${err.message}`);
  });

  log('Loading engine page...');
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load', timeout: 30_000 });

  log('Waiting for pre-simulation...');
  await page.waitForFunction('window.SIM && (window.SIM.duration > 0 || window.SIM.failed)', { timeout: 120_000 });

  const simFailed = await page.evaluate(() => !!window.SIM.failed);
  if (simFailed) {
    await browser.close();
    throw new Error('Physics simulation did not reach the final tier');
  }

  const simInfo = await page.evaluate(() => ({
    duration: window.SIM.duration,
    totalFrames: window.SIM.totalFrames,
    eventCount: window.SIM.events.length,
  }));

  log(`Simulation ready: ${simInfo.duration.toFixed(1)}s, ${simInfo.totalFrames} frames, ${simInfo.eventCount} events`);

  if (simInfo.duration < 5 || simInfo.duration > 200) {
    throw new Error(`Simulation duration out of range: ${simInfo.duration}s`);
  }

  const events = await page.evaluate(() => window.SIM.events);

  const videoPath = join(outDir, 'video.mp4');
  const ffmpeg = spawnProc('ffmpeg', [
    '-y',
    '-f', 'image2pipe',
    '-framerate', String(fps),
    '-i', 'pipe:0',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-level', '4.1',
    '-maxrate', '25M',
    '-bufsize', '25M',
    '-vf', 'scale=1080:1920',
    '-movflags', '+faststart',
    videoPath,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  let ffmpegErr = '';
  ffmpeg.stderr.on('data', d => { ffmpegErr += d; });

  const reviewFrameIdxs = [
    Math.floor(simInfo.totalFrames * 0.15),
    Math.floor(simInfo.totalFrames * 0.50),
    Math.floor(simInfo.totalFrames * 0.85),
    simInfo.totalFrames - 2,
  ];
  const reviewFrames = [];

  log(`Capturing ${simInfo.totalFrames} frames...`);
  let lastProgress = 0;

  for (let i = 0; i < simInfo.totalFrames; i++) {
    const t = i / fps;
    await page.evaluate((time) => { window.SIM.seek(time); }, t);

    const buf = await page.screenshot({ type: 'jpeg', quality: 95 });

    const canWrite = ffmpeg.stdin.write(buf);
    if (!canWrite) {
      await new Promise(resolve => ffmpeg.stdin.once('drain', resolve));
    }

    if (reviewFrameIdxs.includes(i)) {
      const frameFile = `frame-${reviewFrames.length + 1}.jpg`;
      writeFileSync(join(outDir, frameFile), buf);
      reviewFrames.push(frameFile);
    }

    const progress = Math.floor((i / simInfo.totalFrames) * 100);
    if (progress >= lastProgress + 20) {
      log(`  ${progress}% (${i}/${simInfo.totalFrames})`);
      lastProgress = progress;
    }
  }

  ffmpeg.stdin.end();
  await new Promise((resolve, reject) => {
    ffmpeg.on('close', code => {
      if (code !== 0) reject(new Error(`ffmpeg encoding failed: ${ffmpegErr}`));
      else resolve();
    });
    ffmpeg.on('error', reject);
  });

  await browser.close();

  if (!existsSync(videoPath)) {
    throw new Error('Video file not created');
  }

  log(`Video rendered: ${videoPath}`);

  return {
    videoPath,
    duration: simInfo.duration,
    events,
    reviewFrames,
  };
}
