import { execSync, spawn as spawnProc } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, log, warn } from './util.js';

const SAMPLE_RATE = 48000;
const CHANNELS = 2;

function decodeToRaw(filePath) {
  const raw = execSync(
    `ffmpeg -y -i "${filePath}" -f f32le -ar ${SAMPLE_RATE} -ac ${CHANNELS} pipe:1`,
    { maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

function resample(samples, rate) {
  if (Math.abs(rate - 1) < 0.01) return samples;
  const outLen = Math.floor(samples.length / rate);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * rate;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, samples.length - 1);
    const frac = srcIdx - lo;
    out[i] = samples[lo] * (1 - frac) + samples[hi] * frac;
  }
  return out;
}

export function mixSfxEvents(events, soundMap, duration) {
  const totalSamples = Math.ceil(duration * SAMPLE_RATE * CHANNELS);
  const mixBuffer = new Float32Array(totalSamples);

  const decoded = {};
  for (const [key, path] of Object.entries(soundMap)) {
    if (!path || !existsSync(path)) continue;
    try {
      decoded[key] = decodeToRaw(path);
    } catch (e) {
      warn(`Failed to decode ${key}: ${e.message}`);
    }
  }

  const merged = [];
  const sorted = [...events].sort((a, b) => a.t - b.t);
  for (const ev of sorted) {
    const last = merged.find(m => m.sfx === ev.sfx && Math.abs(m.t - ev.t) < 0.03);
    if (last) continue;
    merged.push(ev);
  }

  const overlapWindow = 0.05;
  let windowEvents = [];

  for (let i = 0; i < merged.length; i++) {
    const ev = merged[i];
    const samples = decoded[ev.sfx];
    if (!samples) continue;

    const resampled = resample(samples, ev.rate || 1);
    const offsetSample = Math.floor(ev.t * SAMPLE_RATE * CHANNELS);

    windowEvents = windowEvents.filter(w => ev.t - w.t < overlapWindow);
    windowEvents.push(ev);
    const isBounce = ev.sfx === 'bounce';
    const baseGain = isBounce ? 0.25 : 1;
    const gain = Math.min(baseGain, 1.5 / Math.sqrt(windowEvents.length));

    for (let j = 0; j < resampled.length && offsetSample + j < totalSamples; j++) {
      mixBuffer[offsetSample + j] += resampled[j] * gain;
    }
  }

  for (let i = 0; i < totalSamples; i++) {
    mixBuffer[i] = Math.max(-1, Math.min(1, mixBuffer[i]));
  }

  return mixBuffer;
}

function writeWav(buffer, path) {
  const byteRate = SAMPLE_RATE * CHANNELS * 4;
  const dataSize = buffer.length * 4;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20); // float
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(CHANNELS * 4, 32);
  header.writeUInt16LE(32, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  const dataBuf = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  writeFileSync(path, Buffer.concat([header, dataBuf]));
}

function sfxPeakLevel(buf) {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

function muxSilentAudio(videoPath, finalPath, duration) {
  warn('SFX is silent, adding silent audio track');
  execSync([
    'ffmpeg', '-y',
    '-i', `"${videoPath}"`,
    '-f', 'lavfi', '-i', `anullsrc=r=${SAMPLE_RATE}:cl=stereo`,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-movflags', '+faststart', '-t', String(duration),
    `"${finalPath}"`,
  ].join(' '), { stdio: 'pipe', timeout: 120_000 });
}

function safeLoudnorm(inputs, finalPath, filterComplex, fallbackFilter) {
  const inputArgs = inputs.flatMap(p => ['-i', `"${p}"`]);
  try {
    execSync([
      'ffmpeg', '-y',
      ...inputArgs,
      '-filter_complex', `"${filterComplex}"`,
      '-map', '0:v', '-map', '"[out]"',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
      '-movflags', '+faststart', '-shortest',
      `"${finalPath}"`,
    ].join(' '), { stdio: 'pipe', timeout: 120_000 });
  } catch (e) {
    warn('loudnorm failed, falling back to simple volume normalization');
    execSync([
      'ffmpeg', '-y',
      ...inputArgs,
      '-filter_complex', `"${fallbackFilter}"`,
      '-map', '0:v', '-map', '"[out]"',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
      '-movflags', '+faststart', '-shortest',
      `"${finalPath}"`,
    ].join(' '), { stdio: 'pipe', timeout: 120_000 });
  }
}

export async function mixAudio(videoPath, events, soundMap, musicTrack, outDir, opts = {}) {
  const duration = opts.duration || 45;
  const mood = opts.mood || 'light';

  log(`Mixing ${events.length} sound events...`);
  const sfxBuffer = mixSfxEvents(events, soundMap, duration);
  const peak = sfxPeakLevel(sfxBuffer);
  log(`SFX peak level: ${peak.toFixed(6)}`);

  const sfxPath = join(outDir, 'sfx.wav');
  writeWav(sfxBuffer, sfxPath);

  const finalPath = join(outDir, 'reel.mp4');

  const moodVolumes = { light: 0.35, romantic: 0.35, dark: 0.4, rock: 0.45, loud: 0.5, meme: 0.4, bouncy: 0.4, retro: 0.4 };
  const musicVol = moodVolumes[mood] || 0.35;

  if (musicTrack && existsSync(musicTrack.path)) {
    const loopedMusicPath = join(outDir, 'music_loop.wav');

    try {
      execSync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${musicTrack.path}"`,
        { stdio: 'pipe' }
      );
    } catch {}

    execSync([
      'ffmpeg', '-y',
      '-stream_loop', '-1',
      '-i', `"${musicTrack.path}"`,
      '-t', String(duration),
      '-af', `afade=t=in:st=0:d=0.6,afade=t=out:st=${Math.max(0, duration - 1.5)}:d=1.5,volume=${musicVol}`,
      '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS),
      `"${loopedMusicPath}"`,
    ].join(' '), { stdio: 'pipe', timeout: 60_000 });

    safeLoudnorm([videoPath, sfxPath, loopedMusicPath], finalPath,
      '[1:a][2:a]amix=inputs=2:duration=first:normalize=0[mixed];[mixed]loudnorm=I=-14:TP=-1.5[out]',
      '[1:a][2:a]amix=inputs=2:duration=first:normalize=0[out]');
  } else {
    warn('No music track, mixing SFX only');
    if (peak < 0.001) {
      muxSilentAudio(videoPath, finalPath, duration);
    } else {
      safeLoudnorm([videoPath, sfxPath], finalPath,
        '[1:a]loudnorm=I=-14:TP=-1.5[out]',
        '[1:a]volume=1.5[out]');
    }
  }

  log(`Final reel: ${finalPath}`);
  return finalPath;
}

export function verifyOutput(filePath) {
  const fileSize = statSync(filePath).size;
  const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);

  const probe = execSync(
    `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name,r_frame_rate,bit_rate -of json "${filePath}"`,
    { stdio: ['pipe', 'pipe', 'pipe'] }
  ).toString();
  const video = JSON.parse(probe).streams?.[0];

  const probeA = execSync(
    `ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of json "${filePath}"`,
    { stdio: ['pipe', 'pipe', 'pipe'] }
  ).toString();
  const audio = JSON.parse(probeA).streams?.[0];

  const probeFmt = execSync(
    `ffprobe -v error -show_entries format=duration,bit_rate -of json "${filePath}"`,
    { stdio: ['pipe', 'pipe', 'pipe'] }
  ).toString();
  const fmt = JSON.parse(probeFmt).format || {};
  const dur = parseFloat(fmt.duration || 0);
  const bitrate = fmt.bit_rate ? `${(parseInt(fmt.bit_rate) / 1e6).toFixed(1)} Mbps` : 'unknown';

  log(`File: ${sizeMB} MB, ${bitrate}, ${video?.r_frame_rate || '?'} fps`);

  const checks = [];
  if (!video) checks.push('no video stream');
  else {
    if (video.width !== 1080 || video.height !== 1920) checks.push(`wrong resolution: ${video.width}x${video.height}`);
    if (video.codec_name !== 'h264') checks.push(`wrong video codec: ${video.codec_name}`);
  }
  if (!audio) checks.push('no audio stream');
  if (dur < 10 || dur > 200) checks.push(`duration out of range: ${dur}s`);

  return { valid: checks.length === 0, checks, duration: dur, resolution: video ? `${video.width}x${video.height}` : 'none', sizeMB: parseFloat(sizeMB) };
}
