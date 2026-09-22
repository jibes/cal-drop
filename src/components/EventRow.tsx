import { useEffect, useState } from 'react';
import { deeplinkCaveat, googleCalendarUrl, outlookCalendarUrl } from '../lib/calendar';
import { addToCalendarApp, calendarAppAvailable } from '../lib/native';
import { describeRrule, formatWhen } from '../lib/format';
import { downloadIcs, icsLink } from '../lib/ics';
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
 * commit it somewhere, correct it, or drop it. The primary button is the one
 * that finishes the job; the rest live behind the ⋯ so they cost nothing to
 * ignore.
 */

/** Anything the model was unsure about opens its own editor without being asked. */
function needsAttention(event: EventDraft): boolean {
  return event.confidence < 0.6 || Boolean(event.notes);
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
export function CalendarFile({ events }: { events: EventDraft[] }) {
  const label = events.length > 1 ? `Calendar file (${events.length})` : 'Calendar file';
  const href = icsLink(events);
  return href ? (
    <a className="button" href={href}>
      {label}
    </a>
  ) : (
    <button onClick={() => downloadIcs(events)}>{label}</button>
  );
}

/**
 * Where a set of events can go. A calendar file takes as many as you like; the
 * Google and Outlook links each describe a single event, which is a limit of
 * those URLs and not a choice — so with several selected only the file can
 * carry them all.
 */
/**
 * Whether this device has a calendar app this one can open directly. Asked
 * once, and only answered yes inside the native shell — in a browser there is
 * no plugin to ask, so the button never appears and the page is unchanged.
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

/**
 * Hand the event to the calendar itself. Where nothing answers after all —
 * a calendar uninstalled between the question and the tap — the file is still
 * there, so the button falls back to it rather than failing.
 */
function AddToCalendar({ event }: { event: EventDraft }) {
  const [busy, setBusy] = useState(false);
  const href = icsLink([event]);
  return (
    <button
      className="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void addToCalendarApp(event)
          .then((opened) => {
            if (opened) return;
            if (href) window.location.href = href;
            else downloadIcs([event]);
          })
          .finally(() => setBusy(false));
      }}
    >
      Add to calendar
    </button>
  );
}

export function Destinations({ events }: { events: EventDraft[] }) {
  const single = events.length === 1 ? events[0] : null;
  const calendarApp = useCalendarApp();

  // Nothing ticked is not a state to act in: an .ics with no events in it is a
  // file that does nothing, and offering it is worse than saying so.
  if (events.length === 0) {
    return (
      <div className="destinations">
        <div className="card-actions">
          <button className="button" disabled>
            Calendar file
          </button>
        </div>
        <p className="muted why">Nothing is selected.</p>
      </div>
    );
  }

  // With several events selected there is only one way to take them, so the
  // other two are not shown greyed out: a disabled button asks to be pressed
  // and then explains itself in a tooltip no phone will ever show.
  if (!single) {
    return (
      <div className="destinations">
        <div className="card-actions">
          <CalendarFile events={events} />
        </div>
        <p className="muted why">Google and Outlook take one event at a time.</p>
      </div>
    );
  }

  return (
    <div className="card-actions">
      {/* First, where there is one: it is the only route that needs nothing
          downloaded, nothing chosen and no account. */}
      {calendarApp && <AddToCalendar event={single} />}
      <CalendarFile events={events} />
      <a className="button" href={googleCalendarUrl(single)} target="_blank" rel="noreferrer">
        Google
      </a>
      <a className="button" href={outlookCalendarUrl(single)} target="_blank" rel="noreferrer">
        Outlook
      </a>
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

      {/* Three ways to the same place, none of them this app's preference. */}
      <Destinations events={[event]} />

      <div className="card-actions secondary">
        <button className="ghost small" onClick={() => setOpen((v) => !v)}>
          {open ? 'Done' : 'Edit'}
        </button>
        <button className="ghost small" onClick={onRemove}>
          Discard
        </button>
        {caveat && <p className="muted">{caveat}</p>}
      </div>

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
