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

      <textarea
        className="universal"
        rows={2}
        value={value}
        placeholder="…or paste a link or text"
        onChange={(e) => setValue(e.target.value)}
        onPaste={(e) => {
          // You paste in order to have it read. Asking for a second tap to
          // confirm that is a step with no decision in it.
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

      <div className="drop-actions">
        {/* Pointing a camera at a poster is what this app is for, so it is the
            one control that gets the weight. */}
        {/* Always present, so the panel has something to hand back to. */}
        <input
          ref={systemCameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => onFiles(Array.from(e.target.files ?? []))}
        />
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
        {/* Only typed text needs a submit: a pick runs on selection and a paste
            runs on paste, so a permanent button here would be dead most of the time. */}
        {value.trim() && (
          <button onClick={() => submit()} disabled={busy}>
            Read it
          </button>
        )}
      </div>
    </section>
  );
}
