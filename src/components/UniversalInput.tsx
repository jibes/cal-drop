import { useEffect, useRef, useState } from 'react';

interface Props {
  onFiles: (files: File[]) => void;
  onText: (value: string) => void;
  busy: boolean;
  preview: string;
}

/**
 * One target for everything. Deciding between "image", "PDF", "link" and "text"
 * is the app's job, not a choice to put in front of someone holding a phone.
 */
export function UniversalInput({ onFiles, onText, busy, preview }: Props) {
  const [value, setValue] = useState('');
  const [dragging, setDragging] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

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

  const submit = () => {
    if (!value.trim()) return;
    onText(value);
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
      {preview && <img className="preview" src={preview} alt="" />}

      <textarea
        className="universal"
        rows={2}
        value={value}
        placeholder="Paste a link or any text — or drop a photo or PDF here"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />

      <div className="drop-actions">
        <label className="button" title="Take a photo">
          📷 Photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => onFiles(Array.from(e.target.files ?? []))}
          />
        </label>
        <label className="button" title="Choose a file">
          📎 File
          <input
            type="file"
            accept="image/*,application/pdf"
            multiple
            hidden
            onChange={(e) => onFiles(Array.from(e.target.files ?? []))}
          />
        </label>
        <button className="primary" onClick={submit} disabled={busy || !value.trim()}>
          Read it
        </button>
      </div>
    </section>
  );
}
