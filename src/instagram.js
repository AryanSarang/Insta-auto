import { readFileSync, statSync } from 'node:fs';
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
  const url = graphUrl(`/${userId()}?fields=id,username&access_token=${token()}`);
  const res = await fetch(url);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const code = data.error?.code;
    if (code === 190) throw new Error('Token expired or invalid. Generate a new long-lived token from the Meta Business Suite.');
    throw new Error(`Token check failed (${res.status}): ${JSON.stringify(data.error || {})}`);
  }
  const data = await res.json();
  log(`Instagram account: @${data.username} (${data.id})`);
  return data;
}

export async function publishReel(videoPath, caption) {
  const mode = process.env.UPLOAD_MODE || 'resumable';
  if (mode === 'url') return publishViaUrl(videoPath, caption);
  return publishResumable(videoPath, caption);
}

async function publishResumable(videoPath, caption) {
  const uid = userId();
  const tok = token();

  log('Creating media container (resumable)...');
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

  if (!uploadUri) {
    const version = process.env.GRAPH_API_VERSION || 'v23.0';
    uploadUri = `https://rupload.facebook.com/ig-api-upload/${version}/${containerId}`;
  }

  const fileData = readFileSync(videoPath);
  const fileSize = statSync(videoPath).size;
  const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
  log(`Uploading video to container ${containerId} (${sizeMB} MB)...`);

  const uploadRes = await fetch(uploadUri, {
    method: 'POST',
    headers: {
      'Authorization': `OAuth ${tok}`,
      'offset': '0',
      'file_size': String(fileSize),
      'Content-Type': 'application/octet-stream',
    },
    body: fileData,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Video upload failed (HTTP ${uploadRes.status}, ${sizeMB} MB): ${err}`);
  }

  return finishPublish(containerId);
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
  const maxWait = 15 * 60 * 1000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const statusUrl = graphUrl(`/${containerId}?fields=status_code,status&access_token=${tok}`);
    const statusRes = await fetch(statusUrl);
    const statusData = await statusRes.json();

    log(`  Status: ${statusData.status_code || 'unknown'}`);

    if (statusData.status_code === 'FINISHED') break;
    if (statusData.status_code === 'ERROR' || statusData.status_code === 'EXPIRED') {
      throw new Error(`Media processing failed: ${statusData.status_code} — ${JSON.stringify(statusData.status || {})}`);
    }

    await sleep(10_000);
  }

  if (Date.now() - start >= maxWait) throw new Error('Media processing timed out after 15 minutes');

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
