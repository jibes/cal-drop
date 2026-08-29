import { useState } from 'react';
import { deeplinkCaveat, googleCalendarUrl, outlookCalendarUrl } from '../lib/calendar';
import { describeRrule, formatWhen } from '../lib/format';
import { downloadIcs } from '../lib/ics';
import type { EventDraft } from '../lib/types';

interface Props {
  event: EventDraft;
  onChange: (event: EventDraft) => void;
  onRemove: () => void;
}

/** Anything the model was unsure about opens its own editor without being asked. */
function needsAttention(event: EventDraft): boolean {
  return event.confidence < 0.6 || Boolean(event.notes);
}

export function EventRow({ event, onChange, onRemove }: Props) {
  const [open, setOpen] = useState(() => needsAttention(event));
  const [moreTargets, setMoreTargets] = useState(false);

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

      <div className="card-actions">
        <a
          className="primary button"
          href={googleCalendarUrl(event)}
          target="_blank"
          rel="noreferrer"
        >
          Add to calendar
        </a>
        <button className="ghost small" onClick={() => setOpen((v) => !v)}>
          {open ? 'Done' : 'Edit'}
        </button>
        <button className="ghost small" onClick={() => setMoreTargets((v) => !v)}>
          Other apps
        </button>
      </div>

      {moreTargets && (
        <div className="targets">
          <a className="button small" href={outlookCalendarUrl(event)} target="_blank" rel="noreferrer">
            Outlook
          </a>
          <button className="small" onClick={() => downloadIcs([event])}>
            Download .ics
          </button>
          {caveat && <p className="muted">{caveat}</p>}
        </div>
      )}

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

          <button className="ghost small" onClick={onRemove}>
            Discard this event
          </button>
        </div>
      )}
    </article>
  );
}
