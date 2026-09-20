const MAX_DIMENSION = 1280;
const JPEG_QUALITY = 0.75;

/** What to fall back to when the upload itself will not go through: a poster's
 *  headline and date survive this easily, and it is a quarter of the bytes. */
const FRUGAL_DIMENSION = 900;
const FRUGAL_QUALITY = 0.6;

/** Below this, a photo is unlikely to carry small print legibly. */
export const SHARP_ENOUGH = 1200;

export interface Prepared {
  url: string;
  /** The source's own size, before downscaling — what says whether it was sharp. */
  width: number;
  height: number;
}

function downscale(source: CanvasImageSource, width: number, height: number): Prepared {
  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not read the image (no canvas context).');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { url: canvas.toDataURL('image/jpeg', JPEG_QUALITY), width, height };
}

/** Downscale a picture before it goes to the API — posters are readable well
 *  below phone-camera resolution, and tokens are charged by pixels. */
export async function prepareImage(blob: Blob): Promise<Prepared> {
  const bitmap = await createImageBitmap(blob);
  try {
    return downscale(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

export async function fileToDataUrl(file: Blob): Promise<string> {
  return (await prepareImage(file)).url;
}

/** A frame from a live camera, for browsers with no still-capture API. */
export function frameToDataUrl(video: HTMLVideoElement): Prepared {
  return downscale(video, video.videoWidth, video.videoHeight);
}

/**
 * The same picture, smaller — for a connection that could not carry the first
 * one. Vision models tile their input at around 900px anyway, so this costs
 * far less in legibility than it saves in bytes.
 */
export async function shrinkFurther(dataUrl: string): Promise<string> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const scale = Math.min(1, FRUGAL_DIMENSION / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', FRUGAL_QUALITY);
}
