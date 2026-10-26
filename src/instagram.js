import { readFileSync, statSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { log, warn, sleep } from './util.js';
import { uploadToS3 } from './storage.js';

function graphUrl(path) {
  const host = process.env.GRAPH_HOST || 'graph.facebook.com';
  const version = process.env.GRAPH_API_VERSION || 'v23.0';
  return `https://${host}/${version}${path}`;
}

function token() {
  const t = process.env.IG_ACCESS_TOKEN;
  if (!t) throw new Error('IG_ACCESS_TOKEN not set');
  return t;
}

function userId() {
  const id = process.env.IG_USER_ID;
  if (!id) throw new Error('IG_USER_ID not set');
  return id;
}

export async function checkToken() {
  const tok = token();
  const uid = userId();

  const url = graphUrl(`/${uid}?fields=id,username&access_token=${tok}`);
  const res = await fetch(url);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const code = data.error?.code;
    if (code === 190) throw new Error('Token expired or invalid. Generate a new long-lived token from the Meta Business Suite.');
    throw new Error(`Token check failed (${res.status}): ${JSON.stringify(data.error || {})}`);
  }
  const data = await res.json();
  log(`Instagram account: @${data.username} (${data.id})`);

  try {
    const debugUrl = `https://graph.facebook.com/debug_token?input_token=${tok}&access_token=${tok}`;
    const debugRes = await fetch(debugUrl);
    if (debugRes.ok) {
      const debugData = await debugRes.json();
      const d = debugData.data || {};
      log(`Token debug: type=${d.type}, app_id=${d.app_id}, expires=${d.expires_at ? new Date(d.expires_at * 1000).toISOString() : 'never'}`);
      log(`Token scopes: ${(d.scopes || []).join(', ')}`);
      if (d.expires_at && d.expires_at * 1000 < Date.now() + 7 * 86400000) {
        warn('Token expires within 7 days!');
      }
      if (d.scopes && !d.scopes.includes('instagram_content_publish') && !d.scopes.includes('instagram_business_content_publish')) {
        warn('Token is MISSING content_publish scope — publishing will fail!');
      }
    }
  } catch (e) {
    warn(`Token debug failed: ${e.message}`);
  }

  return data;
}

export async function publishReel(videoPath, caption) {
  const mode = process.env.UPLOAD_MODE || 'resumable';
  if (mode === 'url') return publishViaUrl(videoPath, caption);
  return publishResumable(videoPath, caption);
}

async function createContainer(uid, tok, caption) {
  const createUrl = graphUrl(`/${uid}/media`);
  const createRes = await fetch(createUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media_type: 'REELS',
      upload_type: 'resumable',
      caption,
      share_to_feed: true,
      access_token: tok,
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.json().catch(() => ({}));
    throw new Error(`Container creation failed: ${JSON.stringify(err.error || err)}`);
  }

  const container = await createRes.json();
  const containerId = container.id;
  let uploadUri = container.uri;
  log(`Container ${containerId} created, uri: ${uploadUri || '(none)'}`);

  if (!uploadUri) {
    const version = process.env.GRAPH_API_VERSION || 'v23.0';
    uploadUri = `https://rupload.facebook.com/ig-api-upload/${version}/${containerId}`;
  }

  return { containerId, uploadUri };
}

function uploadVideoNative(uploadUri, fileData, tok, fileSize) {
  const url = new URL(uploadUri);

  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + (url.search || ''),
      method: 'POST',
      headers: {
        'Authorization': `OAuth ${tok}`,
        'offset': '0',
        'file_size': String(fileSize),
        'Content-Type': 'video/mp4',
        'Content-Length': String(fileData.length),
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const headers = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k] = v;
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          body,
          headers,
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(300_000, () => req.destroy(new Error('Upload timeout (5 min)')));
    req.end(fileData);
  });
}

async function publishResumable(videoPath, caption) {
  const uid = userId();
  const tok = token();
  const fileSize = statSync(videoPath).size;
  const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
  const maxRetries = 3;

  try {
    const { execSync } = await import('node:child_process');
    const probe = execSync(
      `ffprobe -v error -show_entries format=format_name,duration,bit_rate:stream=codec_name,codec_type,width,height,r_frame_rate,sample_rate,channels -of json "${videoPath}"`,
      { stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString();
    log(`Upload file probe: ${probe.trim()}`);
  } catch {}

  const fileData = readFileSync(videoPath);
  log(`Video: ${sizeMB} MB, ${fileData.length} bytes`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log(`\n--- Upload attempt ${attempt}/${maxRetries} ---`);

    const { containerId, uploadUri } = await createContainer(uid, tok, caption);

    log('Waiting 3s for container to settle...');
    await sleep(3000);

    log(`Uploading ${sizeMB} MB to ${uploadUri}`);

    let uploadResult;
    try {
      uploadResult = await uploadVideoNative(uploadUri, fileData, tok, fileSize);
    } catch (e) {
      warn(`Upload transport error: ${e.message}`);
      if (attempt < maxRetries) {
        const delay = attempt * 5000;
        warn(`Retrying in ${delay / 1000}s with fresh container...`);
        await sleep(delay);
        continue;
      }
      throw new Error(`Upload failed after ${maxRetries} attempts: ${e.message}`);
    }

    log(`Upload response: HTTP ${uploadResult.status}`);
    if (uploadResult.body) log(`Upload body: ${uploadResult.body.slice(0, 500)}`);
    if (Object.keys(uploadResult.headers).length) {
      log(`Upload response headers: ${JSON.stringify(uploadResult.headers)}`);
    }

    if (uploadResult.ok) {
      log('Upload succeeded, polling for processing...');
      return finishPublish(containerId);
    }

    const isProcessingError = uploadResult.body.includes('ProcessingFailedError');
    warn(`Upload failed: HTTP ${uploadResult.status}${isProcessingError ? ' (ProcessingFailedError)' : ''}`);

    if (attempt < maxRetries) {
      const delay = attempt * 5000;
      warn(`Creating fresh container and retrying in ${delay / 1000}s...`);
      await sleep(delay);
      continue;
    }

    if (hasS3Config()) {
      warn('Resumable upload exhausted — falling back to URL-based upload via S3...');
      return publishViaUrl(videoPath, caption);
    }

    throw new Error(`Video upload failed after ${maxRetries} attempts (HTTP ${uploadResult.status}, ${sizeMB} MB): ${uploadResult.body}`);
  }
}

function hasS3Config() {
  return !!(process.env.S3_ENDPOINT && process.env.S3_BUCKET && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY);
}

async function publishViaUrl(videoPath, caption) {
  const uid = userId();
  const tok = token();
  const key = `reels/${Date.now()}.mp4`;

  log('Uploading to S3...');
  const videoUrl = await uploadToS3(videoPath, key);

  log('Creating media container (URL)...');
  const createUrl = graphUrl(`/${uid}/media`);
  const createRes = await fetch(createUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media_type: 'REELS',
      video_url: videoUrl,
      caption,
      share_to_feed: true,
      access_token: tok,
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.json().catch(() => ({}));
    throw new Error(`Container creation failed: ${JSON.stringify(err.error || err)}`);
  }

  const container = await createRes.json();
  return finishPublish(container.id);
}

async function finishPublish(containerId) {
  const tok = token();
  const uid = userId();

  log('Waiting for processing...');
  const maxWait = 10 * 60 * 1000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const statusUrl = graphUrl(`/${containerId}?fields=status_code,status&access_token=${tok}`);
    const statusRes = await fetch(statusUrl);
    const statusData = await statusRes.json();

    log(`  Status: ${statusData.status_code || 'unknown'} (${Math.round((Date.now() - start) / 1000)}s elapsed)`);

    if (statusData.status_code === 'FINISHED') break;
    if (statusData.status_code === 'ERROR' || statusData.status_code === 'EXPIRED') {
      throw new Error(`Media processing failed: ${statusData.status_code} — ${JSON.stringify(statusData.status || {})}`);
    }

    await sleep(10_000);
  }

  if (Date.now() - start >= maxWait) throw new Error('Media processing timed out after 10 minutes');

  log('Publishing reel...');
  let publishResult;
  for (let attempt = 0; attempt < 3; attempt++) {
    const publishUrl = graphUrl(`/${uid}/media_publish`);
    const publishRes = await fetch(publishUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creation_id: containerId,
        access_token: tok,
      }),
    });

    if (publishRes.ok) {
      publishResult = await publishRes.json();
      break;
    }

    if (attempt < 2) {
      warn(`Publish attempt ${attempt + 1} failed, retrying...`);
      await sleep(5000);
    } else {
      const err = await publishRes.json().catch(() => ({}));
      throw new Error(`Publish failed after 3 attempts: ${JSON.stringify(err.error || err)}`);
    }
  }

  const mediaId = publishResult.id;
  log(`Published! Media ID: ${mediaId}`);

  let permalink = null;
  try {
    const pUrl = graphUrl(`/${mediaId}?fields=permalink&access_token=${tok}`);
    const pRes = await fetch(pUrl);
    if (pRes.ok) {
      const pData = await pRes.json();
      permalink = pData.permalink;
    }
  } catch {}

  return { mediaId, permalink };
}
