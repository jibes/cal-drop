import { useState } from 'react';
import { diagnose } from '../lib/diagnose';
import { inNativeApp } from '../lib/native';
import { endpointHost, proxyUrl, resetSettings } from '../lib/settings';
import type { Method, Settings } from '../lib/types';

interface Props {
  settings: Settings;
  onSave: (settings: Settings) => void;
  onClose: () => void;
}

export function SettingsPanel({ settings, onSave, onClose }: Props) {
  const [method, setMethod] = useState<Method>(settings.method);
  const [code, setCode] = useState(settings.accessCode);
  const [apiBase, setApiBase] = useState(settings.apiBase);
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [model, setModel] = useState(settings.model);
  const [visionModel, setVisionModel] = useState(settings.visionModel);
  const [show, setShow] = useState(false);
  const [report, setReport] = useState('');
  const [testing, setTesting] = useState(false);

  const own = method === 'direct';
  /** The advice below is a browser's; this app is not always one. */
  const app = inNativeApp();
  const edited = (): Settings => ({ method, accessCode: code, apiBase, apiKey, model, visionModel });

  const runTest = async () => {
    setTesting(true);
    setReport('Testing…');
    try {
      await diagnose(edited(), setReport);
    } finally {
      setTesting(false);
    }
  };

  const secret = own ? apiKey : code;
  const setSecret = own ? setApiKey : setCode;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <fieldset className="method">
          <legend>How the model is reached</legend>
          <label className="choice">
            <input
              type="radio"
              name="method"
              checked={!own}
              disabled={!proxyUrl}
              onChange={() => setMethod('proxy')}
            />
            <span>
              <strong>The shared endpoint</strong>
              <em>
                {proxyUrl
                  ? 'Someone else holds the API key and picks the model; an access code says who may use it.'
                  : 'This build was given no endpoint, so there is none to use.'}
              </em>
            </span>
          </label>
          <label className="choice">
            <input type="radio" name="method" checked={own} onChange={() => setMethod('direct')} />
            <span>
              <strong>My own API</strong>
              <em>Anything that speaks the OpenAI API. Your key, your model, your bill.</em>
            </span>
          </label>
        </fieldset>

        {own && (
          <>
            <label>
              API address
              <input
                type="url"
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
                placeholder="https://api.example.com/v1"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </label>
            <label>
              Model
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gemma-4-31b"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </label>
            <label>
              Model for photos
              <input
                type="text"
                value={visionModel}
                onChange={(e) => setVisionModel(e.target.value)}
                placeholder="the same one"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </label>
            <p className="hint">
              A photo goes to the second one; text and PDFs to the first. Leave it empty if the
              same model reads both — many read only one.
            </p>
          </>
        )}

        <label>
          {own ? 'API key' : 'Access code'}
          <span className="row">
            <input
              type={show ? 'text' : 'password'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={own ? 'sk-…' : 'from whoever runs this'}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onKeyDown={(e) => e.key === 'Enter' && onSave(edited())}
            />
            <button type="button" className="ghost" onClick={() => setShow((v) => !v)}>
              {show ? 'Hide' : 'Show'}
            </button>
          </span>
        </label>
        <p className="hint">
          {own ? (
            app ? (
              <>
                Your key stays on this device and is sent straight to {endpointHost(edited())}.
                The app calls it through the system rather than as a web page, so providers that
                refuse browsers — most hosted ones do — work here, and links are read on the
                device too.
              </>
            ) : (
              <>
                Your key stays on this device and is sent straight to {endpointHost(edited())} —
                which means the browser has to be allowed to call it. Most hosted providers do not
                allow that, precisely because a key sent from a page is a key given away; APIs you
                run yourself usually can, and so does the Android app. Reading a link needs the
                shared endpoint and is unavailable here.
              </>
            )
          ) : (
            <>
              Stays on this device. Everything else — which model reads your posters, and who
              pays for it — is set by whoever runs {endpointHost(edited())}.
            </>
          )}
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

        {/* People hit this and reasonably assume the app chose the wrong app. */}
        {/android/i.test(navigator.userAgent) && (
          <p className="hint">
            A calendar file opens in whichever app Android has as the default for it — an
            .ics importer, if one is installed. To change it: Android settings → Apps →
            that app → Open by default → Clear defaults, then pick your calendar next time.
          </p>
        )}

        <p className="hint build">Build {__BUILD__} UTC</p>

        <div className="sheet-actions">
          <button
            className="ghost small"
            onClick={() => {
              const fresh = resetSettings();
              setMethod(fresh.method);
              setCode(fresh.accessCode);
              setApiBase(fresh.apiBase);
              setApiKey(fresh.apiKey);
              setModel(fresh.model);
              setVisionModel(fresh.visionModel);
            }}
          >
            Clear
          </button>
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={() => onSave(edited())}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
