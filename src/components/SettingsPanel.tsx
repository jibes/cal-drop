import { useState } from 'react';
import type { Settings } from '../lib/types';

interface Props {
  settings: Settings;
  onSave: (settings: Settings) => void;
  onClose: () => void;
}

export function SettingsPanel({ settings, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [showKey, setShowKey] = useState(false);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <p className="hint">
          Your key stays on this device (browser storage) and is sent only to the endpoint
          below. It is never uploaded anywhere else.
        </p>

        <label>
          API base URL
          <input
            value={draft.baseUrl}
            onChange={(e) => set('baseUrl', e.target.value)}
            placeholder="https://api.openai.com/v1"
            autoComplete="off"
          />
        </label>

        <label>
          API key
          <span className="row">
            <input
              type={showKey ? 'text' : 'password'}
              value={draft.apiKey}
              onChange={(e) => set('apiKey', e.target.value)}
              placeholder="sk-…"
              autoComplete="off"
            />
            <button type="button" className="ghost" onClick={() => setShowKey((v) => !v)}>
              {showKey ? 'Hide' : 'Show'}
            </button>
          </span>
        </label>

        <label>
          Vision model
          <input
            value={draft.model}
            onChange={(e) => set('model', e.target.value)}
            placeholder="gpt-4o-mini"
            autoComplete="off"
          />
        </label>

        <label>
          Text model <span className="muted">(optional, used for links and pasted text)</span>
          <input
            value={draft.textModel}
            onChange={(e) => set('textModel', e.target.value)}
            placeholder="same as vision model"
            autoComplete="off"
          />
        </label>

        <label>
          CORS proxy for links <span className="muted">({'{url}'} is replaced)</span>
          <input
            value={draft.corsProxy}
            onChange={(e) => set('corsProxy', e.target.value)}
            placeholder="https://r.jina.ai/{url}"
            autoComplete="off"
          />
        </label>

        <div className="sheet-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={() => onSave(draft)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
