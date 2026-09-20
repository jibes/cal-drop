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
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 2560 },
      height: { ideal: 1920 },
      aspectRatio: { ideal: 4 / 3 },
    },
    audio: false,
  });
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
