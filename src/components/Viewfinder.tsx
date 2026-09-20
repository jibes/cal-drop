import { useCallback, useEffect, useRef, useState } from 'react';
import { closeCamera, hasTorch, openCamera, setTorch, takeShot } from '../lib/camera';
import { SHARP_ENOUGH, type Prepared } from '../lib/image';

interface Props {
  /** Shots in the order taken, plus a warning when they look too soft to read. */
  onShots: (images: string[], warning: string) => void;
  onClose: () => void;
  /** The way out: the system camera, for when this one will not do. */
  onSystemCamera: () => void;
}

/**
 * The camera, inside the app.
 *
 * Handing off to the system camera costs an app switch and a confirmation, and
 * leaves a copy of every poster in the camera roll. It also makes a second
 * picture a second round trip, which a festival programme across three boards
 * always needs.
 */
export function Viewfinder({ onShots, onClose, onSystemCamera }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [shots, setShots] = useState<Prepared[]>([]);
  const [torch, setTorchOn] = useState(false);
  const [torchable, setTorchable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    openCamera()
      .then((stream) => {
        if (cancelled) {
          closeCamera(stream);
          return;
        }
        streamRef.current = stream;
        setTorchable(hasTorch(stream));
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play();
        }
        setReady(true);
      })
      .catch((err: Error) => {
        setError(
          err.name === 'NotAllowedError'
            ? 'Camera permission was declined. You can still use the system camera or pick a file.'
            : `The camera could not be opened: ${err.message}`,
        );
      });

    return () => {
      cancelled = true;
      closeCamera(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  const shoot = useCallback(async (): Promise<Prepared[]> => {
    const stream = streamRef.current;
    const video = videoRef.current;
    if (!stream || !video) return shots;
    try {
      const shot = await takeShot(stream, video);
      const next = [...shots, shot];
      setShots(next);
      return next;
    } catch (err) {
      setError(`That shot failed: ${(err as Error).message}`);
      return shots;
    }
  }, [shots]);

  const finish = useCallback(
    (taken: Prepared[]) => {
      if (taken.length === 0) return;
      // A soft capture is the one failure the user can do something about, and
      // it is invisible until the extraction comes back empty.
      const softest = Math.min(...taken.map((shot) => Math.max(shot.width, shot.height)));
      const warning =
        softest < SHARP_ENOUGH
          ? `That came out at ${softest}px, which may be too soft for small print. If nothing is found, try the system camera.`
          : '';
      onShots(
        taken.map((shot) => shot.url),
        warning,
      );
    },
    [onShots],
  );

  const toggleTorch = async () => {
    const next = !torch;
    setTorchOn(next);
    await setTorch(streamRef.current, next).catch(() => setTorchOn(!next));
  };

  return (
    <div className="viewfinder">
      <video ref={videoRef} playsInline muted autoPlay />
      {ready && !error && <div className="frame-guide" aria-hidden="true" />}

      <div className="vf-top">
        <button className="vf-chip" onClick={onClose} aria-label="Close the camera">
          ✕
        </button>
        {torchable && (
          <button className="vf-chip" onClick={toggleTorch} aria-pressed={torch}>
            {torch ? '🔦 On' : '🔦 Off'}
          </button>
        )}
      </div>

      {error && (
        <div className="vf-error">
          <p>{error}</p>
          <button className="button" onClick={onSystemCamera}>
            Use the system camera
          </button>
        </div>
      )}

      {shots.length > 0 && (
        <div className="vf-shots">
          {shots.map((shot, i) => (
            <img key={shot.url.slice(-24) + i} src={shot.url} alt={`Shot ${i + 1}`} />
          ))}
        </div>
      )}

      {!error && (
        <div className="vf-bottom">
          <button className="vf-secondary" onClick={() => void shoot()} disabled={!ready}>
            + another
          </button>
          <button
            className="shutter"
            onClick={() => void shoot().then(finish)}
            disabled={!ready}
            aria-label="Take the photo and read it"
          >
            <span />
          </button>
          <button className="vf-secondary" onClick={onSystemCamera}>
            System camera
          </button>
        </div>
      )}

      {shots.length > 0 && !error && (
        <p className="vf-count">
          {shots.length} taken — the shutter adds one more and reads them all
        </p>
      )}
    </div>
  );
}
