import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  cameraSupported,
  closeCamera,
  defaultRearCamera,
  forgetLens,
  hasTorch,
  openCamera,
  setTorch,
  takeShot,
} from '../lib/camera';
import { SHARP_ENOUGH, type Prepared } from '../lib/image';
import { Icon } from './Icon';

interface Props {
  /** Shots in the order taken, plus a warning when they look too soft to read. */
  onShots: (images: string[], warning: string) => void;
  busy: boolean;
  /** How many results are on screen; above zero, the screen is for reading them. */
  results: number;
  /** Whether the viewfinder is open, so the page can give it the whole screen. */
  onLive?: (live: boolean) => void;
  /** The page wants the camera open — to add a page to what was just read. */
  wantCamera?: boolean;
}

const PREFERENCE = 'caldrop.camera.v1';

/** One transparent pixel. */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** A little air under the panel, so the viewfinder does not sit on the edge
 *  of the screen when it takes all the room it is offered. */
const BREATHING_ROOM = 16;

/**
 * Should the camera open without being asked? Only where it is known that no
 * prompt will appear: the Permissions API says granted, or this browser has
 * opened it successfully before. Safari answers neither question through the
 * Permissions API, which is why the remembered answer matters.
 */
/**
 * The same question, answered without waiting — for the one case where the
 * answer is already written down. It decides what the first render looks
 * like, so it cannot be a promise: by the time a promise settles the page has
 * been drawn once, and drawn as a page rather than as a camera.
 */
function willAutoStart(): boolean {
  try {
    return localStorage.getItem(PREFERENCE) === 'auto';
  } catch {
    return false;
  }
}

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
export function CameraPanel({ onShots, busy, results, onLive, wantCamera }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  /** Asked for again by hand, after standing down for a result. */
  const [asked, setAsked] = useState(false);
  const standDown = results > 0 && !asked;
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [live, setLive] = useState(false);
  /**
   * The camera is on its way up. This is what stops the app showing itself as
   * an ordinary page first: opening a camera takes anything from a moment to
   * a second, and for all of it the screen used to be the in-page layout,
   * small framed viewfinder and all, which then jumped to full screen. Where
   * it is already known the camera will open — a visitor who has granted it
   * before — this starts true, so the very first paint is the camera.
   */
  const [opening, setOpening] = useState(() => willAutoStart() && results === 0);
  /** The first frame has been drawn. Until then the video stays invisible:
   *  what the browser paints in its place is its own placeholder, a grey play
   *  button on Android, which is not the camera and should not be seen. */
  const [showing, setShowing] = useState(false);
  const [error, setError] = useState('');
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
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(PREFERENCE) === 'off';
    } catch {
      return false;
    }
  });

  /**
   * The first frames are dark: the sensor is still finding its exposure.
   * Shown at once, the viewfinder faded in from black to murk to picture, so
   * it waits for about a dozen frames — or a second at most, so a slow camera
   * is never a black screen for long.
   */
  const revealAfterSettling = useCallback((video: HTMLVideoElement) => {
    let shown = false;
    // A lens switch starts a new stream; a timer left from the old one must
    // not reveal the new one before its own frames have settled.
    const stream = streamRef.current;
    const show = () => {
      if (!shown && streamRef.current === stream) setShowing(true);
      shown = true;
    };
    setTimeout(show, 1000);
    const frames = (video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
    }).requestVideoFrameCallback;
    if (!frames) {
      setTimeout(show, 400);
      return;
    }
    let seen = 0;
    const tick = () => {
      if (++seen >= 12) show();
      else frames.call(video, tick);
    };
    frames.call(video, tick);
  }, []);

  const stop = useCallback(() => {
    closeCamera(streamRef.current);
    streamRef.current = null;
    setLive(false);
    setOpening(false);
    setShowing(false);
    setTorchOn(false);
  }, []);

  const remember = (off: boolean) => {
    try {
      localStorage.setItem(PREFERENCE, off ? 'off' : 'auto');
    } catch {
      /* the preference simply will not persist */
    }
  };

  /**
   * Set from the first moment of opening, not the last. Tapping Scan both
   * starts the camera and changes what the auto-start watches, so two starts
   * arrive together — and the second, asking for a camera the first is still
   * opening, failed with "could not start video source" and took the picture
   * down with it.
   */
  const busyOpening = useRef(false);

  const start = useCallback(async () => {
    if (streamRef.current || busyOpening.current) return;
    busyOpening.current = true;
    setOpening(true);
    setError('');
    try {
      let stream = await openCamera();
      forgetLens();

      /**
       * One camera, the ordinary one.
       *
       * Switching lenses used to be offered because nothing in the API says
       * which of three rear cameras is the plain one — but what the chip
       * mostly did was reach the ultra-wide, which frames a poster small and
       * bends its edges, and then remember it. Filtering it out by name does
       * not work where there are no names: Android calls them "camera2 0,
       * facing back", so the filter matches nothing and offers all three.
       * Labels are unreadable until permission exists, so this can only be
       * settled once something is already open.
       */
      const open = stream.getVideoTracks()[0]?.getSettings().deviceId;
      const preferred = await defaultRearCamera();
      if (preferred && preferred !== open) {
        closeCamera(stream);
        stream = await openCamera(preferred);
      }
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
      setOpening(false);
    } finally {
      busyOpening.current = false;
    }
  }, []);

  /**
   * The page lays itself out around the answer to this, so it has to have the
   * answer before anything is drawn.
   *
   * As an ordinary effect this ran after the browser had already painted, and
   * that paint was the panel at its in-page size inside a page that did not
   * yet know the camera was open — the small framed viewfinder, shown for a
   * frame or for as long as the first video frame took to arrive, before the
   * layout jumped to full screen. A layout effect is flushed before the paint,
   * so the first thing drawn is the full-screen camera.
   */
  useLayoutEffect(() => {
    onLive?.(live || opening);
    return () => onLive?.(false);
  }, [live, opening, onLive]);

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

  /**
   * A viewfinder showing nothing looks exactly like a viewfinder pointed at
   * something black, and the shutter works either way. If no frame has arrived
   * a few seconds after opening, say so and offer the way back in.
   */
  useEffect(() => {
    if (!live) return;
    const check = setTimeout(() => {
      const video = videoRef.current;
      const track = streamRef.current?.getVideoTracks()[0];
      const dead = !video?.videoWidth || track?.readyState === 'ended' || !streamRef.current?.active;
      if (dead) setError('The camera opened but is not sending a picture. Tap ✕ and turn it on again.');
    }, 3000);
    return () => clearTimeout(check);
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

  // Asked for from outside: "add a page" is pointing the camera at the next one.
  useEffect(() => {
    if (!wantCamera || live) return;
    setDismissed(false);
    setAsked(true);
    void start();
  }, [wantCamera, live, start]);

  /**
   * A camera left running behind a switched-away tab costs battery for
   * nothing — but closing it belongs to leaving the page, and to nothing else.
   *
   * This used to list dismissed and standDown as dependencies, which meant
   * React tore the effect down and rebuilt it whenever either changed, and
   * tearing it down called stop(). Asking for the camera again changes
   * standDown: the click opened a stream, the cleanup closed it a moment
   * later, and what was left was a live viewfinder with a dead picture in it.
   * The listener is registered once and reads the current values through refs,
   * so the only thing that stops the camera on the way out is the way out.
   */
  const context = useRef({ dismissed, standDown, start, stop });
  context.current = { dismissed, standDown, start, stop };

  useEffect(() => {
    const onVisibility = () => {
      const { dismissed: off, standDown: down, start: open, stop: close } = context.current;
      if (document.hidden) close();
      else if (!off && !down) {
        void shouldAutoStart().then((ok) => {
          if (ok) void open();
        });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      context.current.stop();
    };
  }, []);

  /**
   * One press, one photo, read at once. A second page of the same event is
   * added from the result, once it is clear one was needed — not decided
   * before the first photo, on every photo.
   */
  const capture = useCallback(async () => {
    const stream = streamRef.current;
    const video = videoRef.current;
    if (!stream || !video) return;
    let shot: Prepared;
    try {
      // The frame on screen is the photo. Nothing is reconciled, because
      // there are no longer two pictures to reconcile.
      shot = takeShot(video);
    } catch (err) {
      setError(`That shot failed: ${(err as Error).message}`);
      return;
    }
    // A soft capture is the one failure a user can act on, and it is
    // invisible until the extraction comes back empty.
    const size = Math.max(shot.width, shot.height);
    onShots(
      [shot.url],
      size < SHARP_ENOUGH
        ? `That came out at ${size}px, which may be too soft for small print. If nothing is found, take it with the camera app and share it to DropToCal.`
        : '',
    );
  }, [onShots]);

  const toggleTorch = async () => {
    const next = !torch;
    setTorchOn(next);
    await setTorch(streamRef.current, next).catch(() => setTorchOn(!next));
  };

  if (!cameraSupported()) return null;

  // The picture is only ever shown live, and live means full screen. A camera
  // that would not open says why under the button that tries again, rather
  // than as an empty frame in the middle of the page.
  /**
   * Coming up. The screen is already the camera's — black, with the shutter
   * there but not yet usable — so nothing moves when the picture arrives.
   */
  if (opening && !live && !dismissed && !standDown) {
    return (
      <div className="camera">
        <div className="stage" ref={stageRef} style={{ '--ar': ratio } as React.CSSProperties}>
          {error && <p className="stage-error">{error}</p>}
        </div>
        <div className="shutter-row">
          <button className="shutter" disabled aria-label="The camera is opening">
            <span />
          </button>
        </div>
      </div>
    );
  }

  if (dismissed || standDown || !live) {
    return (
      <div className="camera off">
        {error && !dismissed && !standDown && <p className="camera-error">{error}</p>}
        <button
          className="primary button"
          onClick={() => {
            setDismissed(false);
            setAsked(true);
            remember(false);
            void start();
          }}
        >
          <Icon name="camera" />
          Scan
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
          className={showing ? undefined : 'waiting'}
          // A transparent poster, so there is no placeholder to draw at all.
          poster={BLANK}
          onPlaying={(e) => revealAfterSettling(e.currentTarget)}
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
          {torchable && (
            <button
              className="vf-chip"
              onClick={toggleTorch}
              aria-pressed={torch}
              aria-label={torch ? 'Light on' : 'Light off'}
              title={torch ? 'Turn the light off' : 'Turn the light on'}
            >
              <Icon name={torch ? 'flash' : 'flashOff'} filled={torch} />
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

      </div>

      <div className="shutter-row">
        <button
          className="shutter"
          onClick={() => void capture()}
          disabled={!showing || busy}
          aria-label="Take the photo and read it"
        >
          <span />
        </button>
      </div>
    </div>
  );
}
