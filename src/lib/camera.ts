import { frameToDataUrl, prepareImage, type Prepared } from './image';

/**
 * The camera, in the page rather than in another app.
 *
 * Where a browser offers ImageCapture the photo comes from the device's still
 * pipeline, which is close to what the camera app would have produced. Where it
 * does not — Safari, at the time of writing — a video frame is grabbed instead,
 * which is softer and smaller. That difference is worth telling the user about
 * when it matters, which is what Prepared's dimensions are for.
 */

interface ImageCaptureLike {
  takePhoto(): Promise<Blob>;
  getPhotoSettings?(): Promise<{ imageWidth?: number; imageHeight?: number }>;
}

type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

const imageCapture = (): ImageCaptureCtor | undefined =>
  (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture;

export function cameraSupported(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
}

export async function openCamera(deviceId = ''): Promise<MediaStream> {
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId }, ...CONSTRAINTS },
        audio: false,
      });
    } catch {
      // That lens is gone, or refused; fall back to whatever faces outward.
    }
  }
  return navigator.mediaDevices.getUserMedia({
    // Ask for the rear camera, and for a 4:3 frame rather than the 16:9 a
    // large width alone tends to select: a poster is taller than it is wide,
    // so a wide frame wastes most of it. The still comes from the camera's own
    // photo pipeline and need not have this shape, which is what stillShape
    // below is for.
    video: { facingMode: { ideal: 'environment' }, ...CONSTRAINTS },
    audio: false,
  });
}

const CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 2560 },
  height: { ideal: 1920 },
  aspectRatio: { ideal: 4 / 3 },
};

const LENS_KEY = 'caldrop.lens.v1';

/** Android names cameras "camera2 0, facing back"; the number is the lens. */
const lensIndex = (label: string): number => Number(/(\d+)/.exec(label)?.[1] ?? 99);

/**
 * The rear cameras, in the order the device numbers them. Labels only become
 * readable once permission has been granted, so this is worth nothing before
 * the first stream and reliable after it.
 */
export async function rearCameras(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput' && /back|rear|environment/i.test(d.label))
      .sort((a, b) => lensIndex(a.label) - lensIndex(b.label));
  } catch {
    return [];
  }
}

/**
 * Which rear camera to open by default.
 *
 * facingMode says which way a camera points, not which of several it is, and a
 * phone with three rear lenses may hand back the ultra-wide, which puts the
 * poster small in a distorted frame. Nothing in the API says which lens is the
 * ordinary one: some devices name it, most only number it, and the lowest
 * number is conventionally the main camera. Both are guesses, which is why the
 * choice can be overridden and is then remembered.
 */
export async function defaultRearCamera(): Promise<string> {
  const rear = await rearCameras();
  if (rear.length < 2) return '';
  const named = rear.find((d) => !/wide|ultra|tele|macro|depth|zoom|monochrome/i.test(d.label));
  return (named ?? rear[0]).deviceId;
}

export function rememberedLens(): string {
  try {
    return localStorage.getItem(LENS_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberLens(deviceId: string): void {
  try {
    localStorage.setItem(LENS_KEY, deviceId);
  } catch {
    /* the choice simply will not persist */
  }
}

export function closeCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/**
 * The shape of the photo this camera will actually take, when it will say.
 *
 * The preview is a video stream; the shutter uses the still pipeline, and the
 * two are configured separately. A phone quite reasonably previews at 16:9 and
 * photographs at 4:3 — and then the picture is not the picture that was
 * framed. Asking first means the viewfinder can be drawn in the photo's shape
 * instead of its own.
 */
export async function stillShape(stream: MediaStream | null): Promise<number> {
  const [track] = stream?.getVideoTracks() ?? [];
  const Ctor = imageCapture();
  if (!track || !Ctor) return 0;
  try {
    const settings = await new Ctor(track).getPhotoSettings?.();
    const w = settings?.imageWidth ?? 0;
    const h = settings?.imageHeight ?? 0;
    return w > 0 && h > 0 ? w / h : 0;
  } catch {
    return 0;
  }
}

/**
 * Take the picture, in the shape the viewfinder was showing.
 *
 * `frame` is that shape. Where the still pipeline hands back a different one,
 * the middle is kept: a photo wider than the preview contains things that were
 * never aimed at, and one narrower has lost part of what was.
 */
export async function takeShot(
  stream: MediaStream,
  video: HTMLVideoElement,
  frame = 0,
): Promise<Prepared> {
  const [track] = stream.getVideoTracks();
  const Ctor = imageCapture();

  if (track && Ctor) {
    try {
      return await prepareImage(await new Ctor(track).takePhoto(), frame);
    } catch {
      // Some devices advertise it and then refuse; the frame is still there.
    }
  }
  return frameToDataUrl(video);
}

interface TorchCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
}

export function hasTorch(stream: MediaStream | null): boolean {
  const [track] = stream?.getVideoTracks() ?? [];
  return Boolean((track?.getCapabilities?.() as TorchCapabilities | undefined)?.torch);
}

export async function setTorch(stream: MediaStream | null, on: boolean): Promise<void> {
  const [track] = stream?.getVideoTracks() ?? [];
  // Not in the standard constraint list, but this is how it is switched.
  await track?.applyConstraints({ advanced: [{ torch: on }] } as unknown as MediaTrackConstraints);
}
