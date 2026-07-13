import { writeFile, readFile, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';
import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import { createClient, getAuthenticatedUser } from '@/utils/supabase/server';
import { putMedia } from '@/lib/r2';

export const runtime = 'nodejs';

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

// Safari's <audio> element has no Opus support at all — neither Ogg Opus nor
// WebM/Opus decode there, in any iOS/macOS version this app is tested on.
// Storing everything as Opus (the original approach here) played back fine
// on Chrome/Firefox but was silently unplayable on Safari, which is the
// browser this app is actually reviewed on day to day (iOS PWA). AAC-in-M4A
// is the one format every major browser's <audio> element supports
// natively, so that's the on-disk target regardless of what was recorded or
// uploaded. Safari's own MediaRecorder output is already AAC/mp4, so that
// one case skips transcoding; everything else (Chrome/Firefox's Opus
// recordings, uploaded mp3/wav/ogg files) is converted.
const AAC_MIME_RE = /aac|mp4|m4a/i;

// Temp files, not stdin/stdout pipes: some containers (notably MP4/M4A, whose
// moov atom can sit at the end of the file) need the demuxer to seek, which a
// non-seekable pipe can't support.
async function transcodeToAac(input: Buffer): Promise<Buffer> {
  const id = crypto.randomUUID();
  const inPath = path.join(os.tmpdir(), `${id}-in`);
  const outPath = path.join(os.tmpdir(), `${id}-out.m4a`);
  await writeFile(inPath, input);
  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inPath)
        .audioChannels(1)
        .audioCodec('aac')
        .audioBitrate('64k')
        .format('mp4')
        .on('end', () => resolve())
        .on('error', reject)
        .save(outPath);
    });
    return await readFile(outPath);
  } finally {
    await Promise.allSettled([unlink(inPath), unlink(outPath)]);
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const user = await getAuthenticatedUser(supabase);
  if (!user) return new Response('Unauthorized', { status: 401 });

  const formData = await request.formData();
  const file = formData.get('file');
  if (!(file instanceof Blob)) return new Response('Missing file', { status: 400 });
  if (file.size > MAX_AUDIO_BYTES) return new Response('Audio too large', { status: 413 });

  const input = Buffer.from(await file.arrayBuffer());
  let output: Buffer;
  if (AAC_MIME_RE.test(file.type)) {
    output = input;
  } else {
    try {
      output = await transcodeToAac(input);
    } catch {
      return new Response('Could not process audio', { status: 422 });
    }
  }

  const filename = `${crypto.randomUUID()}.m4a`;
  await putMedia(`media/${user.id}/${filename}`, output, 'audio/mp4');

  return Response.json({ filename });
}
