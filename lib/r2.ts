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

// An unreachable/stalled R2 would otherwise hang putMedia/getMedia
// indefinitely, taking the media upload/fetch API routes down with it (same
// failure mode the Supabase auth calls had — see utils/supabase/server.ts).
// Aborting after a timeout degrades that to the existing error handling
// instead of a request that never resolves. Longer than the 3s used for
// auth checks since this covers actual multi-MB payload transfer, not just
// a metadata round-trip.
const REQUEST_TIMEOUT_MS = 15_000;

function withTimeout() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return { abortSignal: controller.signal, clear: () => clearTimeout(timer) };
}

export async function putMedia(key: string, buffer: Buffer, contentType: string) {
  const { abortSignal, clear } = withTimeout();
  try {
    await r2.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }),
      { abortSignal }
    );
  } finally {
    clear();
  }
}

// Buffers the whole object rather than streaming it — media here is always
// small (compressed images/short audio clips, size-capped on upload), so
// sidestepping the Node-Readable vs Web-ReadableStream interop mismatch
// between the AWS SDK's response body and a Route Handler's Response isn't
// worth it for files this size.
export async function getMedia(key: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const { abortSignal, clear } = withTimeout();
  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }), { abortSignal });
    const bytes = await res.Body!.transformToByteArray();
    return { buffer: Buffer.from(bytes), contentType: res.ContentType ?? 'application/octet-stream' };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'NoSuchKey') return null;
    throw err;
  } finally {
    clear();
  }
}
