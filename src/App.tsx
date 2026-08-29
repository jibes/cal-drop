import { useCallback, useEffect, useRef, useState } from 'react';
import { EventRow } from './components/EventRow';
import { SettingsPanel } from './components/SettingsPanel';
import { UniversalInput } from './components/UniversalInput';
import { extractEvents } from './lib/ai';
import { downloadIcs } from './lib/ics';
import { fileToDataUrl } from './lib/image';
import { isConfigured, loadSettings, saveSettings, usingSharedEndpoint } from './lib/settings';
import { firstUrlIn, takeIncoming } from './lib/share';
import type { EventDraft, ExtractionSource, Settings } from './lib/types';
import { fetchPageText } from './lib/url';

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [events, setEvents] = useState<EventDraft[]>([]);
  const [busy, setBusy] = useState('');
  const [glimpse, setGlimpse] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(async (build: () => Promise<ExtractionSource>, stage: string) => {
    const current = settingsRef.current;
    if (!isConfigured(current)) {
      setShowSettings(true);
      setError('Add your API endpoint, key and model first.');
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError('');
    setGlimpse('');
    setBusy(stage);
    try {
      const source = await build();
      setBusy('Reading the dates…');
      const found = await extractEvents(source, current, {
        signal: controller.signal,
        onProgress: ({ title, date }) => setGlimpse([title, date].filter(Boolean).join(' — ')),
      });
      if (found.length === 0) {
        setError('No dated event was found in that. Try a sharper photo, or paste the text.');
      }
      setEvents((prev) => [...found, ...prev]);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setError((err as Error).message || 'Something went wrong.');
    } finally {
      setBusy('');
      setGlimpse('');
    }
  }, []);

  const handleFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const pdf = files.find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));

      if (pdf) {
        setPreview('');
        void run(async () => {
          // pdf.js is a large dependency; only pay for it when a PDF turns up.
          const { readPdf } = await import('./lib/pdf');
          const content = await readPdf(pdf);
          if (content.images[0]) setPreview(content.images[0]);
          return { kind: 'pdf', label: pdf.name, images: content.images, text: content.text };
        }, 'Reading the PDF…');
        return;
      }

      const images = files.filter((f) => f.type.startsWith('image/'));
      if (images.length === 0) {
        setError('That file type is not supported — use an image or a PDF.');
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

  /** One entry point for typed, pasted and shared text: a link is just text that looks like one. */
  const handleText = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      setPreview('');
      const link = /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : firstUrlIn(trimmed);

      if (link && trimmed.length - link.length < 40) {
        void run(async () => {
          const text = await fetchPageText(link, settingsRef.current.corsProxy);
          return { kind: 'url', label: link, images: [], text };
        }, 'Loading the page…');
        return;
      }
      void run(
        async () => ({ kind: 'text', label: 'pasted text', images: [], text: trimmed }),
        'Reading the text…',
      );
    },
    [run],
  );

  // Anything handed in from the OS share sheet, a bookmarklet or a Shortcut.
  useEffect(() => {
    void takeIncoming().then((incoming) => {
      if (!incoming) return;
      if (incoming.files.length > 0) handleFiles(incoming.files);
      else handleText(incoming.url || incoming.text);
    });
  }, [handleFiles, handleText]);

  return (
    <div className="app">
      <header className="top">
        <h1>
          <span className="logo">📅</span> CalDrop
        </h1>
        <button className="ghost small" onClick={() => setShowSettings(true)}>
          Settings
        </button>
      </header>

      <UniversalInput onFiles={handleFiles} onText={handleText} busy={Boolean(busy)} preview={preview} />

      {busy && (
        <p className="status" role="status">
          <span className="spinner" /> {glimpse || busy}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {events.length > 1 && (
        <div className="bulk">
          <button onClick={() => downloadIcs(events)}>
            Download all {events.length} as one .ics
          </button>
        </div>
      )}

      <div className="results">
        {events.map((event) => (
          <EventRow
            key={event.id}
            event={event}
            onChange={(next) => setEvents((prev) => prev.map((e) => (e.id === next.id ? next : e)))}
            onRemove={() => setEvents((prev) => prev.filter((e) => e.id !== event.id))}
          />
        ))}
      </div>

      <footer className="foot">
        {usingSharedEndpoint(settings)
          ? 'Using the shared demo endpoint. Add your own key in Settings for no rate limit.'
          : 'Runs in your browser. Your key never leaves this device except to call your own endpoint.'}
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
