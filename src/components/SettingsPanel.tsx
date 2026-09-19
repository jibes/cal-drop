import { useState } from 'react';
import { diagnose } from '../lib/diagnose';
import { endpointHost, resetSettings } from '../lib/settings';
import type { Settings } from '../lib/types';

interface Props {
  settings: Settings;
  onSave: (settings: Settings) => void;
  onClose: () => void;
}

export function SettingsPanel({ settings, onSave, onClose }: Props) {
  const [code, setCode] = useState(settings.accessCode);
  const [show, setShow] = useState(false);
  const [report, setReport] = useState('');
  const [testing, setTesting] = useState(false);

  const runTest = async () => {
    setTesting(true);
    setReport('Testing…');
    try {
      await diagnose({ accessCode: code }, setReport);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <label>
          Access code
          <span className="row">
            <input
              type={show ? 'text' : 'password'}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="from whoever runs this"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onKeyDown={(e) => e.key === 'Enter' && onSave({ accessCode: code })}
            />
            <button type="button" className="ghost" onClick={() => setShow((v) => !v)}>
              {show ? 'Hide' : 'Show'}
            </button>
          </span>
        </label>
        <p className="hint">
          Stays on this device. Everything else — which model reads your posters, and who
          pays for it — is set by whoever runs {endpointHost()}.
        </p>

        <div className="diagnose">
          <button className="ghost small" onClick={runTest} disabled={testing}>
            {testing ? 'Testing endpoint…' : 'Test endpoint'}
          </button>
          {report && (
            <>
              <pre className="report">{report}</pre>
              <button
                className="ghost small"
                onClick={() => void navigator.clipboard?.writeText(report)}
              >
                Copy report
              </button>
            </>
          )}
        </div>

        <p className="hint build">Build {__BUILD__} UTC</p>

        <div className="sheet-actions">
          <button className="ghost small" onClick={() => setCode(resetSettings().accessCode)}>
            Clear
          </button>
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={() => onSave({ accessCode: code })}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
