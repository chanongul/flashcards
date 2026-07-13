import { createClient, getAuthenticatedUser } from '@/utils/supabase/server';
import { getMedia } from '@/lib/r2';

export const runtime = 'nodejs';

// Matches exactly what the upload routes ever produce — also guards against
// path traversal/injection, since this is interpolated straight into the R2 key.
const FILENAME_RE = /^[0-9a-f-]{36}\.(webp|m4a)$/;

const CACHE_CONTROL = 'private, max-age=31536000, immutable';

export async function GET(request: Request, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;
  if (!FILENAME_RE.test(filename)) return new Response('Not found', { status: 404 });

  const supabase = await createClient();
  const user = await getAuthenticatedUser(supabase);
  if (!user) return new Response('Unauthorized', { status: 401 });

  const media = await getMedia(`media/${user.id}/${filename}`);
  if (!media) return new Response('Not found', { status: 404 });

  const { buffer, contentType } = media;

  // Safari's <audio>/<video> refuse to play a resource at all unless the
  // server answers its Range probe with a real 206 — a plain 200 (fine for
  // Chrome/Firefox, and for <img>) leaves Safari's player stuck showing
  // nothing. Every response also advertises Accept-Ranges so the browser
  // knows range requests are supported before it even sends one.
  const range = request.headers.get('range');
  const rangeMatch = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (rangeMatch) {
    const start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0;
    const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : buffer.length - 1;
    const chunk = buffer.subarray(start, end + 1);
    return new Response(new Uint8Array(chunk), {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${buffer.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(chunk.length),
        'Cache-Control': CACHE_CONTROL,
      },
    });
  }

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(buffer.length),
      // private: this is per-user, not for a shared/CDN cache. immutable +
      // long max-age is safe since every upload gets a fresh UUID filename —
      // nothing at a given filename ever changes.
      'Cache-Control': CACHE_CONTROL,
    },
  });
}
