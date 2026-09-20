import { useEffect, useRef, useState } from 'react';
import { CameraPanel } from './CameraPanel';
import { ClipboardCard } from './ClipboardCard';

interface Props {
  onFiles: (files: File[]) => void;
  onText: (value: string) => void;
  onShots: (images: string[], warning: string) => void;
  busy: boolean;
  preview: string;
}

/**
 * One target for everything. Deciding between "image", "PDF", "link" and "text"
 * is the app's job, not a choice to put in front of someone holding a phone.
 */
export function UniversalInput({ onFiles, onText, onShots, busy, preview }: Props) {
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

  return (
    <section
      ref={boxRef}
      className={`dropzone${dragging ? ' dragging' : ''}`}
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
      <CameraPanel onShots={onShots} onSystemCamera={useSystemCamera} busy={busy} />

      {preview && <img className="preview" src={preview} alt="" />}

      <div className="or">or</div>

      <ClipboardCard onText={onText} onShots={onShots} busy={busy} />

      {/* Always present, so the camera panel has something to hand back to. */}
      <input
        ref={systemCameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => onFiles(Array.from(e.target.files ?? []))}
      />

      <div className="drop-actions">
        <label className="button" title="Choose a photo or PDF already on this device">
          Choose file
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
