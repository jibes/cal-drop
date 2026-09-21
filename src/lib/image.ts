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

/**
 * Draw the source down to size, optionally keeping only the middle of it.
 *
 * `frame` is the shape the picture is supposed to be — the shape the viewfinder
 * was showing. A still camera does not have to hand back the shape its preview
 * stream had: on a phone with a 4:3 sensor the preview may be 16:9, or the
 * other way about, and then the photo contains something other than what was
 * framed. Where the two disagree the middle is kept, so the picture that is
 * sent is the picture that was aimed.
 */
function downscale(
  source: CanvasImageSource,
  width: number,
  height: number,
  frame = 0,
): Prepared {
  let sx = 0;
  let sy = 0;
  let sw = width;
  let sh = height;
  // A hair of difference is rounding, not a different frame.
  if (frame > 0 && Math.abs(width / height - frame) / frame > 0.02) {
    if (width / height > frame) {
      sw = Math.round(height * frame);
      sx = Math.round((width - sw) / 2);
    } else {
      sh = Math.round(width / frame);
      sy = Math.round((height - sh) / 2);
    }
  }

  const scale = Math.min(1, MAX_DIMENSION / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not read the image (no canvas context).');
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return { url: canvas.toDataURL('image/jpeg', JPEG_QUALITY), width: sw, height: sh };
}

/** Downscale a picture before it goes to the API — posters are readable well
 *  below phone-camera resolution, and tokens are charged by pixels. */
export async function prepareImage(blob: Blob, frame = 0): Promise<Prepared> {
  const bitmap = await createImageBitmap(blob);
  try {
    return downscale(bitmap, bitmap.width, bitmap.height, frame);
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
