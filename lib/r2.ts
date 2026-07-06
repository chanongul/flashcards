import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME!;

export async function putMedia(key: string, buffer: Buffer, contentType: string) {
  await r2.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }));
}

// Buffers the whole object rather than streaming it — media here is always
// small (compressed images/short audio clips, size-capped on upload), so
// sidestepping the Node-Readable vs Web-ReadableStream interop mismatch
// between the AWS SDK's response body and a Route Handler's Response isn't
// worth it for files this size.
export async function getMedia(key: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    return { buffer: Buffer.from(bytes), contentType: res.ContentType ?? 'application/octet-stream' };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'NoSuchKey') return null;
    throw err;
  }
}
