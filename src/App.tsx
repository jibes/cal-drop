import { useCallback, useEffect, useRef, useState } from 'react';
import { EventCard } from './components/EventCard';
import { SettingsPanel } from './components/SettingsPanel';
import { extractEvents } from './lib/ai';
import { downloadIcs } from './lib/ics';
import { fileToDataUrl } from './lib/image';
import { readPdf } from './lib/pdf';
import { isConfigured, loadSettings, saveSettings } from './lib/settings';
import type { EventDraft, ExtractionSource, Settings } from './lib/types';
import { fetchPageText } from './lib/url';

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [events, setEvents] = useState<EventDraft[]>([]);
  const [busy, setBusy] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [urlInput, setUrlInput] = useState('');
  const [textInput, setTextInput] = useState('');
  const [preview, setPreview] = useState<string>('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(
    async (build: () => Promise<ExtractionSource>, stage: string) => {
      if (!isConfigured(settings)) {
        setShowSettings(true);
        setError('Add your API endpoint, key and model first.');
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setError('');
      setBusy(stage);
      try {
        const source = await build();
        setBusy('Reading the dates…');
        const found = await extractEvents(source, settings, controller.signal);
        if (found.length === 0) {
          setError('No dated event was found in that. Try a sharper photo or paste the text.');
        }
        setEvents((prev) => [...found, ...prev]);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setError((err as Error).message || 'Something went wrong.');
      } finally {
        setBusy('');
      }
    },
    [settings],
  );

  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      const files = Array.from(fileList ?? []);
      if (files.length === 0) return;

      const pdf = files.find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
      if (pdf) {
        setPreview('');
        void run(async () => {
          const content = await readPdf(pdf);
          if (content.images[0]) setPreview(content.images[0]);
          return {
            kind: 'pdf',
            label: pdf.name,
            images: content.images,
            text: content.text,
          };
        }, 'Reading the PDF…');
        return;
      }

      const images = files.filter((f) => f.type.startsWith('image/'));
      if (images.length === 0) {
        setError('Pick an image or a PDF.');
        return;
      }
      void run(async () => {
        const urls = await Promise.all(images.map(fileToDataUrl));
        setPreview(urls[0]);
        return {
          kind: 'image',
          label: images.map((f) => f.name).join(', '),
          images: urls,
          text: '',
        };
      }, 'Preparing the image…');
    },
    [run],
  );

  const handleUrl = () => {
    if (!urlInput.trim()) return;
    setPreview('');
    void run(async () => {
      const text = await fetchPageText(urlInput, settings.corsProxy);
      return { kind: 'url', label: urlInput.trim(), images: [], text };
    }, 'Loading the page…');
  };

  const handleText = () => {
    if (!textInput.trim()) return;
    setPreview('');
    void run(
      async () => ({ kind: 'text', label: 'pasted text', images: [], text: textInput }),
      'Reading the text…',
    );
  };

  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? [])[0];
      if (file) {
        const list = new DataTransfer();
        list.items.add(file);
        handleFiles(list.files);
      }
    },
    [handleFiles],
  );

  useEffect(() => {
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [onPaste]);

  return (
    <div className="app">
      <header className="top">
        <h1>
          <span className="logo">📅</span> CalDrop
        </h1>
        <button className="ghost" onClick={() => setShowSettings(true)}>
          Settings
        </button>
      </header>

      <p className="lede">
        Drop a poster photo, a screenshot, a PDF or an event link. The dates come back as a
        calendar file.
      </p>

      <section
        className="dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          handleFiles(e.dataTransfer.files);
        }}
      >
        {preview && <img className="preview" src={preview} alt="" />}
        <div className="drop-actions">
          <label className="primary button">
            Take photo
            <input
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(e) => handleFiles(e.target.files)}
            />
          </label>
          <label className="button">
            Choose image or PDF
            <input
              type="file"
              accept="image/*,application/pdf"
              multiple
              hidden
              onChange={(e) => handleFiles(e.target.files)}
            />
          </label>
        </div>
        <p className="muted">…or drag a file here, or paste one with ⌘/Ctrl+V</p>
      </section>

      <section className="inputs">
        <div className="row">
          <input
            type="url"
            placeholder="https://… event page"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleUrl()}
          />
          <button onClick={handleUrl} disabled={!urlInput.trim()}>
            Read link
          </button>
        </div>
        <details>
          <summary>Paste text instead</summary>
          <textarea
            rows={4}
            placeholder="Paste the event announcement…"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
          />
          <button onClick={handleText} disabled={!textInput.trim()}>
            Read text
          </button>
        </details>
      </section>

      {busy && (
        <p className="status" role="status">
          <span className="spinner" /> {busy}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {events.length > 1 && (
        <div className="bulk">
          <button className="primary" onClick={() => downloadIcs(events)}>
            Download all {events.length} events
          </button>
        </div>
      )}

      <div className="results">
        {events.map((event) => (
          <EventCard
            key={event.id}
            event={event}
            onChange={(next) =>
              setEvents((prev) => prev.map((e) => (e.id === next.id ? next : e)))
            }
            onRemove={() => setEvents((prev) => prev.filter((e) => e.id !== event.id))}
            onExport={() => downloadIcs([event])}
          />
        ))}
      </div>

      <footer className="foot">
        Everything runs in your browser. Your API key never leaves this device except to call
        your own endpoint.
      </footer>

      {showSettings && (
        <SettingsPanel
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSave={(next) => {
            setSettings(next);
            saveSettings(next);
            setShowSettings(false);
            setError('');
          }}
        />
      )}
    </div>
  );
}
