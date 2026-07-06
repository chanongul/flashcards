import sharp from 'sharp';
import { createClient } from '@/utils/supabase/server';
import { putMedia } from '@/lib/r2';

export const runtime = 'nodejs';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const formData = await request.formData();
  const file = formData.get('file');
  if (!(file instanceof Blob)) return new Response('Missing file', { status: 400 });
  if (file.size > MAX_IMAGE_BYTES) return new Response('Image too large', { status: 413 });

  const input = Buffer.from(await file.arrayBuffer());
  const output = await sharp(input)
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();

  const filename = `${crypto.randomUUID()}.webp`;
  await putMedia(`media/${user.id}/${filename}`, output, 'image/webp');

  return Response.json({ filename });
}
