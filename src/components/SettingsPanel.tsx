import { useEffect, useState } from 'react';
import { checkConnection, listModels, type CheckLine } from '../lib/check';
import { diagnose } from '../lib/diagnose';
import { inNativeApp } from '../lib/native';
import { PROVIDERS, providerFor } from '../lib/providers';
import { endpointHost, resetSettings, secretsAreEncrypted } from '../lib/settings';
import type { LinkReader, Settings } from '../lib/types';

interface Props {
  settings: Settings;
  onSave: (settings: Settings) => void;
  onClose: () => void;
}

export function SettingsPanel({ settings, onSave, onClose }: Props) {
  const [apiBase, setApiBase] = useState(settings.apiBase);
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [model, setModel] = useState(settings.model);
  const [visionModel, setVisionModel] = useState(settings.visionModel);
  const [pageReader, setPageReader] = useState(settings.pageReader);
  const [pageReaderCode, setPageReaderCode] = useState(settings.pageReaderCode);
  const [linkReader, setLinkReader] = useState<LinkReader>(settings.linkReader);
  const [jinaKey, setJinaKey] = useState(settings.jinaKey);
  const [show, setShow] = useState(false);
  const [report, setReport] = useState('');
  const [testing, setTesting] = useState(false);
  const [checks, setChecks] = useState<CheckLine[]>([]);
  /** What the provider says this key may use, offered in both model fields. */
  const [models, setModels] = useState<string[]>([]);

  /** The advice below is a browser's; this app is not always one. */
  const app = inNativeApp();
  const edited = (): Settings => ({
    apiBase,
    apiKey,
    model,
    visionModel,
    pageReader,
    pageReaderCode,
    linkReader,
    jinaKey,
  });

  /** The detailed probe, one request per feature — for when the plain check is not enough. */
  const runTest = async () => {
    setTesting(true);
    setReport('Testing…');
    try {
      await diagnose(edited(), setReport);
    } finally {
      setTesting(false);
    }
  };

  const runCheck = async () => {
    setTesting(true);
    setReport('');
    setChecks([]);
    try {
      await checkConnection(edited(), setChecks);
    } finally {
      setTesting(false);
    }
  };

  const provider = providerFor(apiBase);

  // Ask the provider which models there are once there is an address and a
  // key to ask with — after typing has settled, not on every keystroke.
  useEffect(() => {
    if (!apiBase.trim() || !apiKey.trim()) return;
    let current = true;
    const soon = setTimeout(() => {
      void listModels(edited()).then((list) => {
        if (current && list.ok) setModels(list.ids);
      });
    }, 700);
    return () => {
      current = false;
      clearTimeout(soon);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, apiKey]);

  /** The key, with what to know about where it goes. */
  const secretFields = (
    <>
      <label>
        API key
        <span className="row">
          <input
            type={show ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
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
      {provider?.keys && (
        <p className="hint">
          A key comes from <code>{provider.keys}</code>. One with a spending limit is the safe kind
          to put in an app.
        </p>
      )}
      <p className="hint">
        {app ? (
          <>
            Your key stays on this device{secretsAreEncrypted() ? ', encrypted,' : ''} and is sent
            straight to{' '}
            {apiBase.trim() ? endpointHost(edited()) : 'the API above'}. The app calls it itself,
            not as a web page, so any OpenAI-compatible API works here — including ones that
            refuse browsers — and links are read on the device.
          </>
        ) : (
          <>
            Your key stays in this browser and is sent straight to{' '}
            {apiBase.trim() ? endpointHost(edited()) : 'the API above'} —
            which means the browser has to be allowed to call it. Most hosted providers do not
            allow that, precisely because a key sent from a page is a key given away; OpenAI and
            OpenRouter do, and APIs you run yourself usually can.
          </>
        )}
      </p>
    </>
  );

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <label>
          Provider
          <select
            value={provider?.id ?? (apiBase.trim() ? 'custom' : '')}
            onChange={(e) => {
              const chosen = PROVIDERS.find((p) => p.id === e.target.value);
              setApiBase(chosen ? chosen.base : '');
              setModels([]);
            }}
          >
            {!apiBase.trim() && !provider && (
              <option value="" disabled>
                Choose a provider…
              </option>
            )}
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="custom">Other — type the address</option>
          </select>
        </label>
        {provider && !provider.browser && !app && (
          <p className="hint warn">
            {provider.name} does not let web pages call it, so it will not work here. OpenAI,
            OpenRouter, Groq and Mistral do.
          </p>
        )}
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
        {secretFields}
        <label>
          Model
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            list="caldrop-models"
            placeholder={models.length ? 'pick or type a model' : 'the model to ask'}
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
            list="caldrop-models"
            placeholder="the same one"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>
        <datalist id="caldrop-models">
          {models.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <p className="hint">
          A photo goes to the second one; text and PDFs to the first. Leave it empty if the
          same model reads both — many read only one.
        </p>

        {/* In the app the phone reads a link itself; only a browser needs someone to ask. */}
        {!app && (
          <>
            <fieldset className="method">
              <legend>Links</legend>
              <label className="choice">
                <input type="radio" name="links" checked={linkReader === 'off'} onChange={() => setLinkReader('off')} />
                <span>
                  <strong>Not read</strong>
                  <em>A browser may not fetch another site, so links are not read here. Paste the text or take a screenshot.</em>
                </span>
              </label>
              <label className="choice">
                <input type="radio" name="links" checked={linkReader === 'jina'} onChange={() => setLinkReader('jina')} />
                <span>
                  <strong>Jina Reader</strong>
                  <em>A public service (jina.ai) fetches the page. It sees every link you paste. Free, with a rate limit.</em>
                </span>
              </label>
              <label className="choice">
                <input type="radio" name="links" checked={linkReader === 'server'} onChange={() => setLinkReader('server')} />
                <span>
                  <strong>My own reader</strong>
                  <em>
                    Called the way Jina is: <code>GET address/link</code> answers with the page’s text.
                    The <code>fetcher/</code> in this project is one.
                  </em>
                </span>
              </label>
            </fieldset>

            {linkReader === 'jina' && (
              <label>
                Jina key <span className="muted">(optional, lifts the rate limit)</span>
                <input
                  type="password"
                  value={jinaKey}
                  onChange={(e) => setJinaKey(e.target.value)}
                  placeholder="jina_…"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </label>
            )}

            {linkReader === 'server' && (
              <>
                <label>
                  Reader address
                  <input
                    type="url"
                    value={pageReader}
                    onChange={(e) => setPageReader(e.target.value)}
                    placeholder="https://reader.example.com"
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </label>
                <label>
                  Its key <span className="muted">(optional, sent as a Bearer token)</span>
                  <input
                    type="password"
                    value={pageReaderCode}
                    onChange={(e) => setPageReaderCode(e.target.value)}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </label>
              </>
            )}
          </>
        )}

        <div className="diagnose">
          <button className="ghost small" onClick={runCheck} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {checks.length > 0 && (
            <ul className="checks">
              {checks.map((line) => (
                <li key={line.label} className={line.state}>
                  <span aria-hidden="true">
                    {line.state === 'ok' ? '✓' : line.state === 'fail' ? '✗' : line.state === 'warn' ? '!' : '–'}
                  </span>{' '}
                  <strong>{line.label}</strong>: {line.detail}
                </li>
              ))}
            </ul>
          )}
          {checks.length > 0 && !testing && (
            <button className="ghost small" onClick={runTest}>
              Technical details
            </button>
          )}
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
              setApiBase(fresh.apiBase);
              setApiKey(fresh.apiKey);
              setModel(fresh.model);
              setVisionModel(fresh.visionModel);
              setPageReader(fresh.pageReader);
              setPageReaderCode(fresh.pageReaderCode);
              setLinkReader(fresh.linkReader);
              setJinaKey(fresh.jinaKey);
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
