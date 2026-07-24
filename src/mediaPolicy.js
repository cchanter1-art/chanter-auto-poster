'use strict';

// TikTok intake is video-only: every path that can create a NEW TikTok job
// (admin/campaign /upload, the client portal upload, and public-URL intake)
// must refuse images. This policy only guards creation — existing photo
// jobs stay viewable, editable, and deletable.
//
// Shared by routes.js, clientRoutes.js, and storage.js so the multer file
// filters, the route-level URL checks, and the storage chokepoint can never
// drift apart.

const path = require('path');

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm'];
// Image support is scoped to the Platform BATCH intake path only (opt-in via
// isSupportedBatchUploadFile). These are the formats the storage layer already
// encodes and mime-maps (defaultExtension / getPublicMediaMimeType) and that
// TikTok's Photo Direct Post accepts. Classic/single-post, client-portal, and
// runtime intake stay strictly video-only through isVideoUploadFile below.
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

const VIDEO_ONLY_UPLOAD_MESSAGE = 'TikTok posting is video-only. Upload an MP4, MOV, or WebM video.';
const VIDEO_ONLY_URL_MESSAGE = 'TikTok posting is video-only. The Public Media URL must point directly to an MP4, MOV, or WebM video file.';
const BATCH_MEDIA_UPLOAD_MESSAGE = 'Batch posting accepts a video (MP4, MOV, WebM) or an image (JPG, PNG, WebP).';

function isVideoUploadFile(file) {
  const mime = String((file && file.mimetype) || '').toLowerCase();
  const extension = path.extname((file && file.originalname) || '').toLowerCase();
  if (mime.startsWith('image/')) return false;
  // A video MIME type with a non-video extension is a mismatch — reject it
  // rather than trusting either signal alone. Extension may be absent
  // (some clients omit it); the video MIME type alone is enough then.
  if (mime.startsWith('video/')) return !extension || VIDEO_EXTENSIONS.includes(extension);
  // Generic/unknown MIME (e.g. application/octet-stream): trust only a
  // known video extension.
  return VIDEO_EXTENSIONS.includes(extension);
}

// Image counterpart of isVideoUploadFile, with the SAME strictness: MIME and
// extension must agree, a missing extension is forgiven for a real image MIME,
// and a generic MIME is trusted only with a known image extension. A
// video/image cross-mismatch (e.g. image MIME + .mp4, or video MIME + .png) is
// rejected by both predicates, so it can never sneak in as "supported".
function isImageUploadFile(file) {
  const mime = String((file && file.mimetype) || '').toLowerCase();
  const extension = path.extname((file && file.originalname) || '').toLowerCase();
  if (mime.startsWith('video/')) return false;
  if (mime.startsWith('image/')) return !extension || IMAGE_EXTENSIONS.includes(extension);
  return IMAGE_EXTENSIONS.includes(extension);
}

// The ONLY widened acceptance predicate, used exclusively by the opt-in batch
// path (platform multer filter, validateMedia when allowImageMedia, and the
// storage chokepoint when defaults.allowImageMedia). A batch source is valid if
// it is a supported video OR a supported image.
function isSupportedBatchUploadFile(file) {
  return isVideoUploadFile(file) || isImageUploadFile(file);
}

function isVideoMediaUrl(mediaUrl) {
  try {
    const pathname = new URL(String(mediaUrl || '')).pathname.toLowerCase();
    return VIDEO_EXTENSIONS.some((extension) => pathname.endsWith(extension));
  } catch (error) {
    return false;
  }
}

module.exports = {
  VIDEO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  VIDEO_ONLY_UPLOAD_MESSAGE,
  VIDEO_ONLY_URL_MESSAGE,
  BATCH_MEDIA_UPLOAD_MESSAGE,
  isVideoUploadFile,
  isImageUploadFile,
  isSupportedBatchUploadFile,
  isVideoMediaUrl
};
