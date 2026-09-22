import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { deeplinkCaveat, googleCalendarUrl, outlookCalendarUrl } from '../lib/calendar';
import { addToCalendarApp, calendarAppAvailable } from '../lib/native';
import { describeRrule, formatWhen } from '../lib/format';
import { downloadIcs, icsLink } from '../lib/ics';
import { Icon } from './Icon';
import type { EventDraft } from '../lib/types';

interface Props {
  event: EventDraft;
  /** Several events were found, so which ones to act on is a real question. */
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  onChange: (event: EventDraft) => void;
  onRemove: () => void;
}

/**
 * Three things can be done with an extracted event, and they do not overlap:
 * commit it somewhere, correct it, or drop it. They share one row, and the
 * primary button is the one that finishes the job.
 */

/** Anything the model was unsure about opens its own editor without being asked. */
function needsAttention(event: EventDraft): boolean {
  return event.confidence < 0.6 || Boolean(event.notes);
}

/**
 * Whether this device has a calendar app this one can open directly. Asked
 * once, and only answered yes inside the native shell — in a browser there is
 * no plugin to ask, so the main button hands over the calendar file instead.
 */
function useCalendarApp(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void calendarAppAvailable().then((yes) => {
      if (!cancelled) setReady(yes);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return ready;
}

/** Hand the event to the calendar itself; where nothing answers after all —
 *  a calendar uninstalled between the question and the tap — the file is still
 *  there, so it falls back to that rather than failing. */
async function openInCalendarApp(event: EventDraft): Promise<void> {
  if (await addToCalendarApp(event)) return;
  const href = icsLink([event]);
  if (href) window.location.href = href;
  else downloadIcs([event]);
}

/**
 * The calendar file, served over https so the device decides what opens it.
 *
 * There is no way for a web page to put an event straight into a calendar app
 * on Android: Chromium adds CATEGORY_BROWSABLE to any intent a page launches,
 * and a calendar's insert filter does not declare it, so such an intent
 * matches nothing. The file is the only handover the browser is allowed to
 * make, and which app receives it is the device's default to set.
 */
function openCalendarFile(events: EventDraft[]): void {
  const href = icsLink(events);
  if (href) window.location.href = href;
  else downloadIcs(events);
}

interface Option {
  label: string;
  run: () => void;
}

/**
 * One way that is clearly the way, and the rest one tap further in.
 *
 * Four buttons of equal weight asked which calendar is yours before anything
 * could happen; almost everyone wants the same one every time. The main
 * button adds the event, and the ▾ beside it holds the alternatives.
 */
function AddButton({
  label,
  onAdd,
  options,
}: {
  label: string;
  onAdd: () => void | Promise<void>;
  options: Option[];
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div className="split" ref={ref}>
      <button
        className="primary split-main"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void Promise.resolve(onAdd()).finally(() => setBusy(false));
        }}
      >
        {label}
      </button>
      {options.length > 0 && (
        <button
          className="primary split-more"
          aria-label="Other ways to add it"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          ▾
        </button>
      )}
      {open && (
        <div className="split-menu" role="menu">
          {options.map((option) => (
            <button
              key={option.label}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                option.run();
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Where a set of events can go. A calendar file takes as many as you like; the
 * Google and Outlook links each describe a single event, which is a limit of
 * those URLs and not a choice — so with several selected only the file can
 * carry them all.
 */
export function Destinations({ events, children }: { events: EventDraft[]; children?: React.ReactNode }) {
  const single = events.length === 1 ? events[0] : null;
  const calendarApp = useCalendarApp();

  // Nothing ticked is not a state to act in: an .ics with no events in it is a
  // file that does nothing, and offering it is worse than saying so.
  if (events.length === 0) {
    return (
      <div className="card-actions">
        <button className="primary split-main" disabled>
          Add to calendar
        </button>
        {children}
      </div>
    );
  }

  if (!single) {
    return (
      <div className="card-actions">
        <AddButton
          label={`Add ${events.length} to calendar`}
          onAdd={() => openCalendarFile(events)}
          options={[]}
        />
        {children}
      </div>
    );
  }

  const web = (url: string) => () => window.open(url, '_blank', 'noreferrer');
  const others: Option[] = [
    // In the app the main button goes straight to the calendar, so the file is
    // an alternative; in a browser the file is what the main button is.
    ...(calendarApp ? [{ label: 'Calendar file (.ics)', run: () => openCalendarFile(events) }] : []),
    { label: 'Google Calendar', run: web(googleCalendarUrl(single)) },
    { label: 'Outlook', run: web(outlookCalendarUrl(single)) },
  ];

  return (
    <div className="card-actions">
      <AddButton
        label="Add to calendar"
        onAdd={() => (calendarApp ? openInCalendarApp(single) : openCalendarFile(events))}
        options={others}
      />
      {children}
    </div>
  );
}

export function EventRow({ event, selectable, selected, onToggle, onChange, onRemove }: Props) {
  const [open, setOpen] = useState(() => needsAttention(event));

  const set = <K extends keyof EventDraft>(key: K, value: EventDraft[K]) =>
    onChange({ ...event, [key]: value });

  const repeat = describeRrule(event.rrule);
  const caveat = deeplinkCaveat(event);

  return (
    <article
      className={`card${needsAttention(event) ? ' attention' : ''}${
        selectable && !selected ? ' deselected' : ''
      }`}
    >
      <div className="summary">
        <h2>
          {selectable && (
            /* The tick is 20px because that is the right size to look at; the
               label around it is the size a thumb needs. */
            <label className="pick-wrap">
              <input
                type="checkbox"
                className="pick"
                checked={selected}
                onChange={onToggle}
                aria-label={`Include ${event.title}`}
              />
            </label>
          )}
          {event.title}
        </h2>
        <p className="when">
          {formatWhen(event)}
          {repeat && <span className="repeat"> · {repeat}</span>}
        </p>
        {/* The place gets its own line: it is the part that wraps, and a date
            broken across two lines is harder to check at a glance. */}
        {event.location && <p className="where">{event.location}</p>}
        {event.sourceText && (
          <p className="quote">
            read from “{event.sourceText}”
          </p>
        )}
        {event.notes && (
          <p className="note">
            <span>⚠ {event.notes}</span>
            {/* Once it has been read it has done its work, and the card can
                stop being the one with the orange border. */}
            <button className="ghost small note-done" onClick={() => set('notes', '')} aria-label="Dismiss this note">
              ✕
            </button>
          </p>
        )}
      </div>

      <Destinations events={[event]}>
        <button
          className="ghost small icon-button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? 'Done editing' : 'Edit'}
          aria-pressed={open}
          title={open ? 'Done editing' : 'Edit'}
        >
          <Icon name={open ? 'done' : 'edit'} />
        </button>
        <button className="ghost small icon-button" onClick={onRemove} aria-label="Discard" title="Discard">
          <Icon name="discard" />
        </button>
      </Destinations>
      {caveat && <p className="muted caveat">{caveat}</p>}

      {open && (
        <div className="editor">
          <label>
            Title
            <input value={event.title} onChange={(e) => set('title', e.target.value)} />
          </label>

          <div className="grid">
            <label>
              Starts
              <input
                type="date"
                value={event.startDate}
                onChange={(e) => set('startDate', e.target.value)}
              />
            </label>
            <label>
              At
              <input
                type="time"
                value={event.startTime}
                disabled={event.allDay}
                onChange={(e) => set('startTime', e.target.value)}
              />
            </label>
            <label>
              Ends
              <input
                type="date"
                value={event.endDate}
                onChange={(e) => set('endDate', e.target.value)}
              />
            </label>
            <label>
              At
              <input
                type="time"
                value={event.endTime}
                disabled={event.allDay}
                onChange={(e) => set('endTime', e.target.value)}
              />
            </label>
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={event.allDay}
              onChange={(e) => set('allDay', e.target.checked)}
            />
            All day
          </label>

          <label>
            Location
            <input value={event.location} onChange={(e) => set('location', e.target.value)} />
          </label>

          <label>
            Repeats <span className="muted">(RRULE, empty for a one-off)</span>
            <input
              value={event.rrule}
              placeholder="FREQ=WEEKLY;BYDAY=TU"
              onChange={(e) => set('rrule', e.target.value.toUpperCase())}
            />
          </label>

          <label>
            Description
            <textarea
              rows={3}
              value={event.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </label>
        </div>
      )}
    </article>
  );
}
