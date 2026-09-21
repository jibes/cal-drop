import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cameraSupported,
  closeCamera,
  defaultRearCamera,
  hasTorch,
  openCamera,
  rearCameras,
  rememberedLens,
  rememberLens,
  setTorch,
  takeShot,
} from '../lib/camera';
import { SHARP_ENOUGH, type Prepared } from '../lib/image';

interface Props {
  /** Shots in the order taken, plus a warning when they look too soft to read. */
  onShots: (images: string[], warning: string) => void;
  /** The way out: the system camera, for when this one will not do. */
  onSystemCamera: () => void;
  busy: boolean;
  /** How many results are on screen; above zero, the screen is for reading them. */
  results: number;
}

const PREFERENCE = 'caldrop.camera.v1';

/** A little air under the panel, so the viewfinder does not sit on the edge
 *  of the screen when it takes all the room it is offered. */
const BREATHING_ROOM = 16;

/**
 * Should the camera open without being asked? Only where it is known that no
 * prompt will appear: the Permissions API says granted, or this browser has
 * opened it successfully before. Safari answers neither question through the
 * Permissions API, which is why the remembered answer matters.
 */
async function shouldAutoStart(): Promise<boolean> {
  try {
    if (localStorage.getItem(PREFERENCE) === 'auto') return true;
  } catch {
    /* storage disabled; fall through to asking the browser */
  }
  try {
    return (await navigator.permissions.query({ name: 'camera' as PermissionName })).state === 'granted';
  } catch {
    return false;
  }
}

/**
 * The camera, live on the first screen.
 *
 * The point of the app is to photograph a poster, so the viewfinder is not
 * somewhere to navigate to: it is what you arrive at, and the shutter is the
 * first thing under your thumb. Opening it costs a permission prompt, so that
 * is only done unasked once the browser has already granted it — a first visit
 * gets a button to press instead of an ambush.
 */
export function CameraPanel({ onShots, onSystemCamera, busy, results }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  /** Asked for again by hand, after standing down for a result. */
  const [asked, setAsked] = useState(false);
  const standDown = results > 0 && !asked;
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [live, setLive] = useState(false);
  const [error, setError] = useState('');
  const [shots, setShots] = useState<Prepared[]>([]);
  const [torch, setTorchOn] = useState(false);
  const [torchable, setTorchable] = useState(false);
  /**
   * The shape of the frame on screen, taken from the video element — which is
   * the one measurement that says what is actually being shown. The still
   * camera can be asked what shape its photos are, and it answers in the
   * sensor's own orientation: a phone held upright reports a landscape frame
   * and then delivers a portrait photo. So it is not asked; the picture is
   * cropped to this instead.
   */
  const [ratio, setRatio] = useState(4 / 3);
  /** Which rear camera, when the phone has several and names none of them. */
  const [lens, setLens] = useState('');
  const [lenses, setLenses] = useState<MediaDeviceInfo[]>([]);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(PREFERENCE) === 'off';
    } catch {
      return false;
    }
  });

  const stop = useCallback(() => {
    closeCamera(streamRef.current);
    streamRef.current = null;
    setLive(false);
    setTorchOn(false);
  }, []);

  const remember = (off: boolean) => {
    try {
      localStorage.setItem(PREFERENCE, off ? 'off' : 'auto');
    } catch {
      /* the preference simply will not persist */
    }
  };

  const start = useCallback(async (wanted = rememberedLens()) => {
    if (streamRef.current) return;
    setError('');
    try {
      let stream = await openCamera(wanted);

      // Labels are unreadable until permission exists, so which lens this
      // should be can only be worked out once something is already open.
      const rear = await rearCameras();
      setLenses(rear);
      if (!wanted) {
        const preferred = await defaultRearCamera();
        const open = stream.getVideoTracks()[0]?.getSettings().deviceId;
        if (preferred && preferred !== open) {
          closeCamera(stream);
          stream = await openCamera(preferred);
        }
      }
      setLens(stream.getVideoTracks()[0]?.getSettings().deviceId ?? '');
      streamRef.current = stream;
      setTorchable(hasTorch(stream));
      setLive(true);
      // Having been granted once, it will be granted again: next visit can
      // open without asking, in browsers whose Permissions API stays quiet.
      remember(false);
    } catch (err) {
      const problem = err as Error;
      setError(
        problem.name === 'NotAllowedError'
          ? 'Camera permission was declined.'
          : `The camera could not be opened: ${problem.message}`,
      );
    }
  }, []);

  /**
   * How tall the viewfinder may be, measured rather than guessed.
   *
   * It used to be the viewport minus a constant for everything else on the
   * screen, and that constant was wrong every time the layout changed — and
   * wrong at two widths at once, since the buttons wrap at narrow ones. What
   * is left over can simply be measured: the page's height minus the stage's
   * own is everything else, and that figure does not move when the stage
   * does, so one pass settles it.
   */
  useEffect(() => {
    if (!live) return;
    const fit = () => {
      const stage = stageRef.current;
      const panel = stage?.closest('.dropzone') as HTMLElement | null;
      if (!stage || !panel) return;
      // What the viewfinder competes with is the rest of the panel it is in,
      // and the header above it — not the results below, which are somewhere
      // to scroll to and would otherwise shrink the camera for having worked.
      const above = panel.getBoundingClientRect().top + window.scrollY;
      const rest = panel.offsetHeight - stage.getBoundingClientRect().height;
      const room = Math.max(140, window.innerHeight - above - rest - BREATHING_ROOM);
      const current = Number(stage.style.getPropertyValue('--room').replace('px', '')) || 0;
      if (Math.abs(room - current) > 2) stage.style.setProperty('--room', `${Math.round(room)}px`);
    };
    fit();
    window.addEventListener('resize', fit);
    const observer = new ResizeObserver(fit);
    observer.observe(document.body);
    return () => {
      window.removeEventListener('resize', fit);
      observer.disconnect();
    };
  }, [live, ratio, results]);

  /**
   * The video element only exists once the camera is live, so the stream has
   * to be attached after that render rather than while opening it.
   */
  useEffect(() => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!live || !video || !stream || video.srcObject === stream) return;
    video.srcObject = stream;
    void video.play().catch(() => undefined);
  }, [live]);

  // Start unasked only where the answer is already yes.
  useEffect(() => {
    if (dismissed || standDown || !cameraSupported()) return;
    let cancelled = false;
    void shouldAutoStart().then((yes) => {
      if (yes && !cancelled) void start();
    });
    return () => {
      cancelled = true;
    };
  }, [dismissed, standDown, start]);

  /**
   * Once an event is on screen, that is what the screen is for: dates to check,
   * a title to fix, a calendar to send it to. A live viewfinder above all that
   * is the tallest thing in the way of it, so the camera closes and leaves a
   * button — one tap back to scanning, for when the next poster comes along.
   * Each new result stands it down again, including one it just took.
   */
  useEffect(() => {
    if (results > 0) setAsked(false);
  }, [results]);

  useEffect(() => {
    if (standDown) stop();
  }, [standDown, stop]);

  // A camera left running behind a switched-away tab costs battery for nothing.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) stop();
      else if (!dismissed && !standDown) {
        void shouldAutoStart().then((ok) => {
          if (ok) void start();
        });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [dismissed, standDown, start, stop]);

  const shoot = useCallback(async (): Promise<Prepared[]> => {
    const stream = streamRef.current;
    const video = videoRef.current;
    if (!stream || !video) return shots;
    try {
      // The shape on screen is handed to the shutter, which crops to it if the
      // camera hands back something else. What was framed is what is sent.
      const next = [...shots, await takeShot(stream, video, ratio)];
      setShots(next);
      return next;
    } catch (err) {
      setError(`That shot failed: ${(err as Error).message}`);
      return shots;
    }
  }, [ratio, shots]);

  const finish = useCallback(
    (taken: Prepared[]) => {
      if (taken.length === 0) return;
      // A soft capture is the one failure a user can act on, and it is
      // invisible until the extraction comes back empty.
      const softest = Math.min(...taken.map((shot) => Math.max(shot.width, shot.height)));
      onShots(
        taken.map((shot) => shot.url),
        softest < SHARP_ENOUGH
          ? `Those came out at ${softest}px, which may be too soft for small print. If nothing is found, try the system camera.`
          : '',
      );
      setShots([]);
    },
    [onShots],
  );

  /** No API says which lens is the ordinary one, so offer the others. */
  const nextLens = async () => {
    if (lenses.length < 2) return;
    const at = Math.max(0, lenses.findIndex((d) => d.deviceId === lens));
    const pick = lenses[(at + 1) % lenses.length].deviceId;
    rememberLens(pick);
    stop();
    await start(pick);
  };

  const toggleTorch = async () => {
    const next = !torch;
    setTorchOn(next);
    await setTorch(streamRef.current, next).catch(() => setTorchOn(!next));
  };

  if (!cameraSupported()) return null;

  if (dismissed || standDown || (!live && !error)) {
    return (
      <div className="camera off">
        <button
          className="primary button"
          onClick={() => {
            setDismissed(false);
            setAsked(true);
            remember(false);
            void start();
          }}
        >
          {standDown ? '📷 Scan' : '📷 Turn on the camera'}
        </button>
      </div>
    );
  }

  return (
    <div className="camera">
      {/* Both of the stage's dimensions are derived from this, so the box
          always matches the camera instead of letterboxing when one clamps. */}
      <div className="stage" ref={stageRef} style={{ '--ar': ratio } as React.CSSProperties}>
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          onLoadedMetadata={(e) => {
            const video = e.currentTarget;
            if (video.videoWidth && video.videoHeight) {
              setRatio(video.videoWidth / video.videoHeight);
            }
          }}
        />
        {live && <div className="frame-guide" aria-hidden="true" />}
        {error && <p className="stage-error">{error}</p>}

        <div className="stage-top">
          {lenses.length > 1 && (
            <button className="vf-chip" onClick={() => void nextLens()} title="Switch rear camera">
              Lens {Math.max(0, lenses.findIndex((d) => d.deviceId === lens)) + 1}/{lenses.length}
            </button>
          )}
          {torchable && (
            <button className="vf-chip" onClick={toggleTorch} aria-pressed={torch}>
              {torch ? '🔦 On' : '🔦 Off'}
            </button>
          )}
          <button
            className="vf-chip"
            onClick={() => {
              stop();
              setDismissed(true);
              remember(true);
            }}
            aria-label="Turn the camera off"
          >
            ✕
          </button>
        </div>

        {shots.length > 0 && (
          <div className="vf-shots">
            {shots.map((shot, i) => (
              <img key={shot.url.slice(-24) + i} src={shot.url} alt={`Shot ${i + 1}`} />
            ))}
          </div>
        )}
      </div>

      <div className="shutter-row">
        <button className="vf-secondary" onClick={() => void shoot()} disabled={!live || busy}>
          + another
        </button>
        <button
          className="shutter"
          onClick={() => void shoot().then(finish)}
          disabled={!live || busy}
          aria-label={shots.length ? `Read ${shots.length + 1} photos` : 'Take the photo and read it'}
        >
          <span />
        </button>
        <button className="vf-secondary" onClick={onSystemCamera}>
          System camera
        </button>
      </div>

      {shots.length > 0 && (
        <p className="vf-count">{shots.length} banked — the shutter adds one more and reads them all</p>
      )}
    </div>
  );
}
