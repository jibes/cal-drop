const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.85;

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
