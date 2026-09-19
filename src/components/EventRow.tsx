import { useState } from 'react';
import { deeplinkCaveat, googleCalendarUrl, outlookCalendarUrl } from '../lib/calendar';
import { describeRrule, formatWhen } from '../lib/format';
import { downloadIcs, icsOpenLink } from '../lib/ics';
import type { EventDraft } from '../lib/types';

interface Props {
  event: EventDraft;
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
 * The calendar file itself. A link when the endpoint can serve it over https,
 * because that is what a phone will offer to open in a calendar app; a plain
 * download otherwise.
 */
export function CalendarFile({ events }: { events: EventDraft[] }) {
  const href = icsOpenLink(events);
  const label = events.length > 1 ? `Open in calendar (${events.length})` : 'Open in calendar';
  return href ? (
    <a className="button" href={href}>
      {label}
    </a>
  ) : (
    <button onClick={() => downloadIcs(events)}>{label}</button>
  );
}

export function EventRow({ event, onChange, onRemove }: Props) {
  const [open, setOpen] = useState(() => needsAttention(event));

  const set = <K extends keyof EventDraft>(key: K, value: EventDraft[K]) =>
    onChange({ ...event, [key]: value });

  const repeat = describeRrule(event.rrule);
  const caveat = deeplinkCaveat(event);

  return (
    <article className={`card${needsAttention(event) ? ' attention' : ''}`}>
      <div className="summary">
        <h2>{event.title}</h2>
        <p className="when">
          {formatWhen(event)}
          {repeat && <span className="repeat"> · {repeat}</span>}
          {event.location && <span className="muted"> · {event.location}</span>}
        </p>
        {event.sourceText && (
          <p className="quote">
            read from “{event.sourceText}”
          </p>
        )}
        {event.notes && <p className="note">⚠ {event.notes}</p>}
      </div>

      {/* Three ways to the same place, none of them this app's preference. */}
      <div className="card-actions">
        <CalendarFile events={[event]} />
        <a className="button" href={googleCalendarUrl(event)} target="_blank" rel="noreferrer">
          Google
        </a>
        <a className="button" href={outlookCalendarUrl(event)} target="_blank" rel="noreferrer">
          Outlook
        </a>
      </div>

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
