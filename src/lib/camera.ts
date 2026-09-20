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
}

type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

const imageCapture = (): ImageCaptureCtor | undefined =>
  (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture;

export function cameraSupported(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
}

export async function openCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    // Ask for the rear camera, and for a 4:3 frame rather than the 16:9 a
    // large width alone tends to select: a poster is taller than it is wide,
    // and the preview shows exactly what will be sent, so a wide frame wastes
    // most of it. Still capture is unaffected — ImageCapture returns the
    // sensor's own photo whatever the preview is set to.
    video: { facingMode: { ideal: 'environment' }, ...CONSTRAINTS },
    audio: false,
  });
}

const CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 2560 },
  height: { ideal: 1920 },
  aspectRatio: { ideal: 4 / 3 },
};

/**
 * Prefer the ordinary rear camera over the ultra-wide.
 *
 * facingMode says which way a camera points, not which of several it should
 * be, and a phone with three rear lenses may hand back the ultra-wide — which
 * puts the poster small in a distorted frame, the opposite of what reading
 * small print needs. Labels only become readable once permission is granted,
 * which is why this runs after the first stream rather than instead of it.
 */
export async function preferMainRearCamera(stream: MediaStream): Promise<MediaStream> {
  const [track] = stream.getVideoTracks();
  const current = track?.getSettings().deviceId;

  let rear: MediaDeviceInfo[];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    rear = devices.filter((d) => d.kind === 'videoinput' && /back|rear|environment/i.test(d.label));
  } catch {
    return stream;
  }
  // Without labels there is no way to tell one camera from another, and
  // guessing risks landing on the front one.
  if (rear.length < 2) return stream;

  const main =
    rear.find((d) => !/wide|ultra|tele|macro|depth|zoom|monochrome/i.test(d.label)) ?? rear[0];
  if (!main || main.deviceId === current) return stream;

  try {
    const better = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: main.deviceId }, ...CONSTRAINTS },
      audio: false,
    });
    closeCamera(stream);
    return better;
  } catch {
    return stream;
  }
}

export function closeCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export async function takeShot(stream: MediaStream, video: HTMLVideoElement): Promise<Prepared> {
  const [track] = stream.getVideoTracks();
  const Ctor = imageCapture();

  if (track && Ctor) {
    try {
      return await prepareImage(await new Ctor(track).takePhoto());
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
