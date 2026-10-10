import { log } from './util.js';

export async function uploadToS3(filePath, key) {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { readFileSync } = await import('node:fs');

  const client = new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
    forcePathStyle: true,
  });

  const body = readFileSync(filePath);
  await client.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: body,
    ContentType: 'video/mp4',
    ACL: 'public-read',
  }));

  const publicUrl = `${process.env.S3_PUBLIC_URL}/${key}`;
  log(`Uploaded to S3: ${publicUrl}`);
  return publicUrl;
}
