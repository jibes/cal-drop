import type { EventDraft } from '../lib/types';

interface Props {
  event: EventDraft;
  onChange: (event: EventDraft) => void;
  onRemove: () => void;
  onExport: () => void;
}

function confidenceLabel(value: number): { text: string; className: string } {
  if (value >= 0.8) return { text: 'high confidence', className: 'good' };
  if (value >= 0.5) return { text: 'medium confidence', className: 'warn' };
  return { text: 'low confidence — check the date', className: 'bad' };
}

export function EventCard({ event, onChange, onRemove, onExport }: Props) {
  const set = <K extends keyof EventDraft>(key: K, value: EventDraft[K]) =>
    onChange({ ...event, [key]: value });

  const confidence = confidenceLabel(event.confidence);

  return (
    <article className="card">
      <header className="card-head">
        <span className={`badge ${confidence.className}`}>{confidence.text}</span>
        <button className="ghost small" onClick={onRemove} aria-label="Discard this event">
          Discard
        </button>
      </header>

      {event.notes && <p className="note">⚠ {event.notes}</p>}

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
        Description
        <textarea
          rows={3}
          value={event.description}
          onChange={(e) => set('description', e.target.value)}
        />
      </label>

      <div className="card-actions">
        <button className="primary" onClick={onExport}>
          Download .ics
        </button>
      </div>
    </article>
  );
}
