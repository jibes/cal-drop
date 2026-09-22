import { useCallback, useEffect, useRef, useState } from 'react';
import { Destinations, EventRow } from './components/EventRow';
import { SettingsPanel } from './components/SettingsPanel';
import { UniversalInput } from './components/UniversalInput';
import { extractEvents } from './lib/ai';
import { fileToDataUrl } from './lib/image';
import { loadSettings, saveSettings } from './lib/settings';
import { firstUrlIn, onShared, takeIncoming } from './lib/share';
import type { EventDraft, ExtractionSource, Settings } from './lib/types';
import { fetchPageText } from './lib/url';

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [events, setEvents] = useState<EventDraft[]>([]);
  // Everything found is wanted until said otherwise; a poster listing six
  // events usually means six events, not a menu to pick one from.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState('');
  const [glimpse, setGlimpse] = useState('');
  const [error, setError] = useState('');
  /** Something worth knowing that did not stop the run — a soft photo, say. */
  const [hint, setHint] = useState('');
  const [preview, setPreview] = useState('');
  /**
   * The viewfinder is open and nothing has been read yet, so the screen is a
   * camera: the frame takes all of it and the rest floats on top. The moment
   * there is something to read, or something to wait for, it is a page again.
   */
  const [scanning, setScanning] = useState(false);
  /**
   * The photos behind the last result, and what they produced. One event can
   * need more than one picture — the back of a flyer, a poster too tall for a
   * frame — and that is only known once the first has been read. So a page is
   * added to a result, not decided on before the first photo: the next photo
   * is read together with these, and its answer replaces theirs.
   */
  const [pages, setPages] = useState<{ images: string[]; ids: string[] } | null>(null);
  const [adding, setAdding] = useState(false);
  /** The last photo read found nothing — which is when a second page helps most. */
  const [offerPage, setOfferPage] = useState(false);
  const [wantCamera, setWantCamera] = useState(false);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const addingRef = useRef(adding);
  addingRef.current = adding;
  const abortRef = useRef<AbortController | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => () => abortRef.current?.abort(), []);

  /** Resolves with what was found, or null when nothing could be read. Events
   *  listed in replace give way to what is found, if anything is. */
  const run = useCallback(async (
    build: () => Promise<ExtractionSource>,
    stage: string,
    replace: string[] = [],
  ): Promise<EventDraft[] | null> => {
    const current = settingsRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError('');
    setOfferPage(false);
    setGlimpse('');
    setBusy(stage);
    try {
      const source = await build();
      setBusy('Sending it to the model…');
      const found = await extractEvents(source, current, {
        signal: controller.signal,
        onProgress: ({ title, date }) => setGlimpse([title, date].filter(Boolean).join(' — ')),
      });
      if (found.length === 0) {
        setError('No dated event was found in that. Try a sharper photo, or paste the text.');
      }
      setEvents((prev) =>
        found.length > 0 ? [...found, ...prev.filter((e) => !replace.includes(e.id))] : prev,
      );
      return found;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return null;
      const message = (err as Error).message || 'Something went wrong.';
      // An access-code problem is the one error with an obvious next action.
      if (/access code/i.test(message)) setShowSettings(true);
      setError(message);
      return null;
    } finally {
      setBusy('');
      setGlimpse('');
    }
  }, []);

  /** Anything that is not photos starts over: there is nothing to add a page to. */
  const forgetPages = useCallback(() => {
    setPages(null);
    setAdding(false);
  }, []);

  /** Photos, from the camera or from files — on their own, or as the next page. */
  const readPhotos = useCallback(
    async (load: () => Promise<string[]>, label: (count: number) => string, stage: string) => {
      const base = addingRef.current ? pagesRef.current : null;
      setAdding(false);
      let all: string[] = [];
      const found = await run(
        async () => {
          const fresh = await load();
          all = [...(base?.images ?? []), ...fresh];
          setPreview(fresh[0]);
          return { kind: 'image', label: label(all.length), images: all, text: '' };
        },
        base ? `Reading page ${base.images.length + 1} with the rest…` : stage,
        base?.ids ?? [],
      );
      if (!found || all.length === 0) return;
      // An added page that found nothing leaves the earlier result standing, so
      // the next page still replaces that one.
      setPages({ images: all, ids: found.length > 0 ? found.map((e) => e.id) : (base?.ids ?? []) });
      setOfferPage(found.length === 0);
    },
    [run],
  );

  const addPage = useCallback(() => {
    setError('');
    setOfferPage(false);
    setAdding(true);
    setWantCamera(true);
  }, []);

  // Asked once: the camera is open, or adding has been called off.
  useEffect(() => {
    if (scanning || !adding) setWantCamera(false);
  }, [scanning, adding]);

  const handleFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const pdf = files.find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));

      if (pdf) {
        setPreview('');
        forgetPages();
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
      void readPhotos(
        () => Promise.all(images.map(fileToDataUrl)),
        (count) => (count === images.length ? images.map((f) => f.name).join(', ') : `${count} photos`),
        'Preparing the image…',
      );
    },
    [run, readPhotos, forgetPages],
  );

  /** Photographs taken in the app: already downscaled, so they skip file handling. */
  const handleShots = useCallback(
    (images: string[], warning: string) => {
      if (images.length === 0) return;
      setHint(warning);
      void readPhotos(
        async () => images,
        (count) => (count === 1 ? 'photo' : `${count} photos`),
        'Reading the photo…',
      );
    },
    [readPhotos],
  );

  /** One entry point for typed, pasted and shared text: a link is just text that looks like one. */
  const handleText = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      setPreview('');
      forgetPages();
      const link = /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : firstUrlIn(trimmed);

      if (link && trimmed.length - link.length < 40) {
        void run(async () => {
          const text = await fetchPageText(link, settingsRef.current);
          return { kind: 'url', label: link, images: [], text };
        }, 'Loading the page…');
        return;
      }
      void run(
        async () => ({ kind: 'text', label: 'pasted text', images: [], text: trimmed }),
        'Reading the text…',
      );
    },
    [run, forgetPages],
  );

  // Anything handed in from the OS share sheet, "open with", the text
  // selection menu, a bookmarklet or a Shortcut.
  const receive = useCallback(
    (incoming: { files: File[]; text: string; url: string }) => {
      if (incoming.files.length > 0) handleFiles(incoming.files);
      else handleText(incoming.url || incoming.text);
    },
    [handleFiles, handleText],
  );

  useEffect(() => {
    void takeIncoming().then((incoming) => {
      if (incoming) receive(incoming);
    });
    // And again for anything shared while the app is already open, which is
    // the second poster in a row — otherwise it would be collected by nobody.
    onShared(receive);
  }, [receive]);

  const chosen = events.filter((event) => !excluded.has(event.id));
  const toggleAll = () =>
    setExcluded(chosen.length === events.length ? new Set(events.map((e) => e.id)) : new Set());

  // A live viewfinder takes the screen whether or not something has been read
  // already: asking for the camera again is asking to point it at something.
  // An error does not shrink it back into the page — the camera is only ever
  // shown full screen, and the error floats over it like everything else.
  const viewfinder = scanning && !busy;

  return (
    <div className={`app${viewfinder ? ' scanning' : ''}`}>
      <header className="top">
        <h1>
          <span className="logo">📅</span> CalDrop
        </h1>
        <button className="ghost small" onClick={() => setShowSettings(true)}>
          Settings
        </button>
      </header>

      <UniversalInput
        onFiles={handleFiles}
        onText={handleText}
        onShots={handleShots}
        stage={busy}
        glimpse={glimpse}
        onCancel={() => abortRef.current?.abort()}
        preview={preview}
        results={events.length}
        fullScreen={viewfinder}
        onLive={setScanning}
        wantCamera={wantCamera}
      />

      {/* Floating, so neither one moves the page — or the camera — around. */}
      {(error || (hint && !busy) || adding) && (
        <div className="toasts">
          {adding && pages && (
            <div className="toast adding-toast" role="status">
              <p>
                Adding page {pages.images.length + 1}: take a photo or choose a file, and it is read
                together with the {pages.images.length === 1 ? 'first' : `other ${pages.images.length}`}.
              </p>
              <button className="toast-close" onClick={() => setAdding(false)} aria-label="Stop adding a page">
                ✕
              </button>
            </div>
          )}
          {error && (
            <div className="toast error" role="alert">
              <p>
                {error}
                {offerPage && pages && (
                  <button className="ghost small toast-action" onClick={addPage}>
                    ＋ Add a page
                  </button>
                )}
              </p>
              <button className="toast-close" onClick={() => setError('')} aria-label="Dismiss">
                ✕
              </button>
            </div>
          )}
          {hint && !busy && (
            <div className="toast hint-toast">
              <p>{hint}</p>
              <button className="toast-close" onClick={() => setHint('')} aria-label="Dismiss">
                ✕
              </button>
            </div>
          )}
        </div>
      )}

      {pages && pages.ids.length > 0 && !busy && events.some((e) => pages.ids.includes(e.id)) && (
        <div className="pages-bar">
          <span>
            📷 Read from {pages.images.length === 1 ? '1 photo' : `${pages.images.length} photos`}
          </span>
          <button className="ghost small" onClick={addPage}>
            ＋ Add a page
          </button>
        </div>
      )}

      {events.length > 1 && (
        <section className="bulk">
          <div className="bulk-head">
            <span>
              {chosen.length} of {events.length} selected
            </span>
            <button className="ghost small" onClick={toggleAll}>
              {chosen.length === events.length ? 'Select none' : 'Select all'}
            </button>
          </div>
          <Destinations events={chosen} />
        </section>
      )}

      <div className="results">
        {events.map((event) => (
          <EventRow
            key={event.id}
            event={event}
            selectable={events.length > 1}
            selected={!excluded.has(event.id)}
            onToggle={() =>
              setExcluded((prev) => {
                const next = new Set(prev);
                if (next.has(event.id)) next.delete(event.id);
                else next.add(event.id);
                return next;
              })
            }
            onChange={(next) => setEvents((prev) => prev.map((e) => (e.id === next.id ? next : e)))}
            onRemove={() => setEvents((prev) => prev.filter((e) => e.id !== event.id))}
          />
        ))}
      </div>

      <footer className="foot">Posters in, calendar out. Nothing is stored.</footer>

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
