import { useEffect, useRef, useState } from 'react';
import { CameraPanel } from './CameraPanel';
import { ClipboardCard } from './ClipboardCard';

interface Props {
  onFiles: (files: File[]) => void;
  onText: (value: string) => void;
  onShots: (images: string[], warning: string) => void;
  /** What is happening right now, in words; empty when nothing is. */
  stage: string;
  /** The first title the model has said, while the rest is still arriving. */
  glimpse: string;
  onCancel: () => void;
  preview: string;
  /** How many results are on screen. */
  results: number;
  /** The viewfinder has the whole screen, so the ways in float over it. */
  fullScreen: boolean;
  onLive?: (live: boolean) => void;
  /** Open the camera without waiting to be asked: a page is being added. */
  wantCamera?: boolean;
}

/** The steps a source goes through, so there is something to watch before the
 *  model has said a word. */
const STEPS = ['Preparing', 'Sending', 'Reading'] as const;

/** Which step is under way. The stage text is the app's own wording, and the
 *  first title arriving is proof the model is answering. */
function stepAt(stage: string, glimpse: string): number {
  if (glimpse) return 2;
  return /sending/i.test(stage) ? 1 : 0;
}

/**
 * One target for everything. Deciding between "image", "PDF", "link" and "text"
 * is the app's job, not a choice to put in front of someone holding a phone.
 */
export function UniversalInput({ onFiles, onText, onShots, stage, glimpse, onCancel, preview, results, fullScreen, onLive, wantCamera }: Props) {
  /**
   * The row of ways in shrinks to make room for a result — but not while the
   * camera has the screen. There they float over the frame with room to
   * spare, and half of them went missing when the row collapsed itself
   * around a result that was not even on screen.
   */
  const compact = results > 0 && !fullScreen;
  const busy = Boolean(stage);
  const [value, setValue] = useState('');
  const [dragging, setDragging] = useState(false);
  const [typing, setTyping] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const systemCameraRef = useRef<HTMLInputElement>(null);

  // The way out of the in-app camera is the one that always worked.
  const useSystemCamera = () => systemCameraRef.current?.click();

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length > 0) {
        e.preventDefault();
        onFiles(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [onFiles]);

  const submit = (text = value) => {
    if (!text.trim()) return;
    onText(text);
    setValue('');
    setTyping(false);
  };

  /**
   * While something is being read, this is all there is.
   *
   * The camera unmounts with it, which is the point: the live preview is the
   * tallest thing on the screen and it has nothing left to show once the shot
   * is taken — leaving it running pushed the status and the result off the
   * bottom, and kept the camera warm for no reason. What replaces it is the
   * same size every time: what was sent, small, and where it has got to.
   */
  if (busy) {
    const at = stepAt(stage, glimpse);
    return (
      <section className="dropzone working" aria-busy="true">
        <div className="work-row">
          {preview ? (
            <img className="work-thumb" src={preview} alt="What is being read" />
          ) : (
            <span className="work-thumb glyph" aria-hidden="true">
              📄
            </span>
          )}
          <div className="work-what">
            <p className="work-stage" role="status">
              {/* Once the model starts answering, saying "sending" is a lie. */}
              <span className="spinner" /> {glimpse ? 'Reading the answer…' : stage}
            </p>
            {glimpse && <p className="work-glimpse">Found: {glimpse}</p>}
          </div>
        </div>
        <ol className="work-steps">
          {STEPS.map((label, i) => (
            <li key={label} className={i < at ? 'done' : i === at ? 'now' : ''}>
              {label}
            </li>
          ))}
        </ol>
        <button className="ghost small" onClick={onCancel}>
          Cancel
        </button>
      </section>
    );
  }

  return (
    <section
      ref={boxRef}
      className={`dropzone${dragging ? ' dragging' : ''}${compact ? ' again' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        onFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {/* The reason the app exists comes first, already looking at the world. */}
      <CameraPanel
        onShots={onShots}
        onSystemCamera={useSystemCamera}
        busy={busy}
        results={results}
        onLive={onLive}
        wantCamera={wantCamera}
      />

      {/* Once there is something to read below, this whole panel is in the way
          of it: the ways in shrink to one quiet row and give the screen back. */}
      {!compact && <div className="or">or</div>}

      <ClipboardCard onText={onText} onShots={onShots} busy={busy} compact={compact} />

      {/* Always present, so the camera panel has something to hand back to. */}
      <input
        ref={systemCameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => onFiles(Array.from(e.target.files ?? []))}
      />

      <div className={`drop-actions${compact ? ' tight' : ''}`}>
        <label className="button" title="Choose a photo or PDF already on this device">
          {compact ? '📎 File' : '📎 Choose file'}
          <input
            type="file"
            accept="image/*,application/pdf"
            multiple
            hidden
            onChange={(e) => onFiles(Array.from(e.target.files ?? []))}
          />
        </label>
        {/* Typing is the rarest way in by far, so it is a door rather than a
            field standing open: the first screen stays the camera and what is
            already on the clipboard. */}
        <button onClick={() => setTyping(true)} disabled={busy}>
          ⌨ Text
        </button>
      </div>

      {typing && (
        <div className="sheet-backdrop" onClick={() => setTyping(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Paste or type</h2>
            <p className="hint">A link to an event, or the text of a poster.</p>
            <textarea
              className="universal"
              rows={5}
              autoFocus
              value={value}
              placeholder="https://… or the poster's text"
              onChange={(e) => setValue(e.target.value)}
              onPaste={(e) => {
                // You paste in order to have it read. Asking for a second tap
                // to confirm that is a step with no decision in it.
                const text = e.clipboardData.getData('text');
                if (!text.trim()) return; // an image paste is handled globally
                e.preventDefault();
                submit(text);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <div className="sheet-actions">
              <span className="spacer" />
              <button className="ghost" onClick={() => setTyping(false)}>
                Cancel
              </button>
              <button className="primary" onClick={() => submit()} disabled={!value.trim()}>
                Read it
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
