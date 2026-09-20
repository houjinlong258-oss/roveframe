import { NextRequest } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { json, jsonError, errorResponse } from '@/lib/api-helpers';
import { getTenantContext, requirePermission } from '@/lib/tenant';
import { protectBusinessMutation } from '@/lib/mutation-guard';
import { checkFixedWindow, rateLimitResponse } from '@/lib/rate-limit';

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

async function uploadProductMedia(request: NextRequest) {
  try {
    const context = await getTenantContext(request);
    requirePermission(context, 'products:write');

    // P0-1：媒体上传限流 —— 每商户 20 次/分钟。
    const limit = checkFixedWindow(
      `upload:${context.tenantId}`,
      { limit: 20, windowMs: 60_000 },
    );
    if (!limit.ok) return rateLimitResponse(limit);

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
    const path = `products/${context.tenantId}/${crypto.randomUUID()}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, {
      contentType: file.type,
      upsert: false,
    });
    if (error) return jsonError(error.message, 500);

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);

    /**
     * `getPublicUrl` is a pure string join against the client's base URL, so it
     * hands out whatever host the SERVER uses to reach the storage API.
     *
     * On Supabase Cloud those are the same host, and the default below keeps
     * that behaviour byte-for-byte. On a self-hosted install they are NOT: the
     * app talks to `http://gateway` (see docker-compose.selfhosted.yml), a
     * container name no browser can resolve — every product image would 404.
     * There, STORAGE_PUBLIC_BASE_URL is set to the public origin and the stored
     * URL stays correct.
     *
     * Deliberately not a silent fallback: the variable is documented in
     * docker/deploy.env.example and set by install.sh.
     */
    const publicBase = process.env.STORAGE_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
    const url = publicBase
      ? `${publicBase}/storage/v1/object/public/${BUCKET}/${path}`
      : data.publicUrl;

    return json({ url, type: isImage ? 'image' : 'video' });
  } catch (e) {
    return errorResponse(e);
  }
}

export const POST = protectBusinessMutation(
  { permission: 'products:write', action: 'products.upload_media', entity: 'product_media' },
  uploadProductMedia,
);
