import { NextRequest } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { json, jsonError, getErrorMessage } from '@/lib/api-helpers';

const BUCKET = 'product-media';
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_VIDEO = 50 * 1024 * 1024;

let bucketReady = false;

async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const supabase = getSupabaseClient();
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: MAX_VIDEO,
    allowedMimeTypes: ['image/*', 'video/*'],
  });
  if (error && !/already exists|duplicate/i.test(error.message)) {
    throw new Error(error.message);
  }
  bucketReady = true;
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return jsonError('No file provided', 400);

    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    if (!isImage && !isVideo) return jsonError('Only image or video files are allowed', 400);
    if (isImage && file.size > MAX_IMAGE) return jsonError('Image exceeds 5MB limit', 400);
    if (isVideo && file.size > MAX_VIDEO) return jsonError('Video exceeds 50MB limit', 400);

    await ensureBucket();

    const supabase = getSupabaseClient();
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
    const path = `products/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, {
      contentType: file.type,
      upsert: false,
    });
    if (error) return jsonError(error.message, 500);

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
    return json({ url: data.publicUrl, type: isImage ? 'image' : 'video' });
  } catch (e) {
    return jsonError(getErrorMessage(e), 500);
  }
}
