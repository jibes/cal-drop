import { frameToDataUrl, type Prepared } from './image';

/**
 * The camera, in the page rather than in another app.
 *
 * The photo is the frame that was on screen, and nothing else. A device's
 * still pipeline takes a better picture in general, but not the picture that
 * was being aimed: it answers in the sensor's own orientation, and it can
 * use more of the sensor than the preview stream does, so the photo comes
 * back holding things that were never in the viewfinder. Matching their
 * shapes does not catch that second case — the frames agree and the fields
 * of view do not.
 *
 * Nothing is lost by declining it. Everything on its way to the model is
 * reduced to 1280px first, which is below what the preview stream already
 * gives, so the still's extra detail was being thrown away before it was
 * ever sent. What it cost was the one promise the viewfinder makes.
 */

export function cameraSupported(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
}

export async function openCamera(deviceId = ''): Promise<MediaStream> {
  if (deviceId) {
    try {
      return await pinZoom(
        await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: deviceId }, ...CONSTRAINTS },
          audio: false,
        }),
      );
    } catch {
      // That lens is gone, or refused; fall back to whatever faces outward.
    }
  }
  return pinZoom(
    await navigator.mediaDevices.getUserMedia({
      // Ask for the rear camera, and for a 4:3 frame rather than the 16:9 a
      // large width alone tends to select: a poster is taller than it is wide,
      // so a wide frame wastes most of it. The still pipeline need not return
      // this shape, which is why the shot is cropped to the frame on screen.
      video: { facingMode: { ideal: 'environment' }, ...CONSTRAINTS },
      audio: false,
    }),
  );
}

interface ZoomCapabilities extends MediaTrackCapabilities {
  zoom?: { min: number; max: number; step?: number };
}

/**
 * One focal length, the ordinary one.
 *
 * A phone that presents its rear lenses as a single logical camera hands back
 * whatever zoom it was last left at — on several Android builds that is the
 * ultra-wide 0.5, which frames a poster small and bends its edges. There is
 * nothing to weigh up here: 1 is the plain view, so it is asked for outright
 * rather than left to whatever the system remembers.
 */
async function pinZoom(stream: MediaStream): Promise<MediaStream> {
  const [track] = stream.getVideoTracks();
  const zoom = (track?.getCapabilities?.() as ZoomCapabilities | undefined)?.zoom;
  if (!track || !zoom) return stream;
  // A camera whose range starts above 1 has no 1 to give; its own minimum is
  // then the widest ordinary view it has.
  const wanted = Math.min(Math.max(1, zoom.min), zoom.max);
  try {
    await track.applyConstraints({ advanced: [{ zoom: wanted }] } as unknown as MediaTrackConstraints);
  } catch {
    /* a camera that will not be told keeps what it has */
  }
  return stream;
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
 * A lens that sees far too much. "Wide" on its own is what several devices
 * call their main camera, so it is only damning next to "ultra" or a 0.x
 * factor — the two ways a device actually names the 0.5.
 */
export const isUltraWide = (label: string): boolean =>
  /ultra[-\s]?wide|wide[-\s]?angle|\b0[.,]\d\s*x\b/i.test(label);

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
  if (named) return named.deviceId;
  // Nothing is named, so fall back to the numbering — but never onto an
  // ultra-wide, whichever number it happens to carry.
  const plain = rear.filter((d) => !isUltraWide(d.label));
  return (plain[0] ?? rear[0]).deviceId;
}

/**
 * A lens chosen in an older build, which there is no longer any way to
 * choose — and which may well be the ultra-wide this now avoids. Cleared on
 * the way past, so nobody stays stuck on it.
 */
export function forgetLens(): void {
  try {
    localStorage.removeItem(LENS_KEY);
  } catch {
    /* nothing was stored to begin with */
  }
}

export function closeCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/**
 * Take the picture the viewfinder was showing — which is the frame itself,
 * so there is nothing to reconcile and no way for the two to disagree.
 */
export function takeShot(video: HTMLVideoElement): Prepared {
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
