import { useEffect, useId, useRef, useState } from 'react';

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** What the provider offers this key; may be empty, and then it is a plain field. */
  models: string[];
  placeholder: string;
}

/**
 * A model's name: typed, or picked from what the provider lists.
 *
 * This was an <input list> with a <datalist>, which is the browser's own
 * suggestion box — and that box filters by what is already in the field. So
 * with a model chosen it offered that one model and nothing else, and on
 * Android it did so in a strip above the keyboard that did not look like a
 * list at all. Here the list is the app's: opening it shows every model,
 * with the chosen one marked, and only typing narrows it.
 */
export function ModelField({ label, value, onChange, models, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  /** What was typed since the list opened; until then, nothing is filtered. */
  const [typed, setTyped] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId();

  const shown = typed ? models.filter((m) => m.toLowerCase().includes(typed.toLowerCase())) : models;
  const listing = open && shown.length > 0;

  // Opened on the chosen model, not at the top of a long list.
  useEffect(() => {
    if (!listing) return;
    const index = active >= 0 ? active : shown.indexOf(value);
    listRef.current?.children[index]?.scrollIntoView({ block: 'nearest' });
  }, [listing, active, shown, value]);

  const close = () => {
    setOpen(false);
    setTyped(null);
    setActive(-1);
  };

  const pick = (model: string) => {
    onChange(model);
    close();
  };

  return (
    // Not one <label> around it all: a label passes a tap anywhere inside it
    // on to its field, so a tap on ▾ also focused the field — which opened the
    // list — and then the button's own tap closed it again.
    <div className="model-field">
      <label htmlFor={id}>{label}</label>
      <span className="row">
        <input
          id={id}
          type="text"
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={listing}
          aria-autocomplete="list"
          onFocus={() => setOpen(true)}
          onBlur={close}
          onChange={(e) => {
            onChange(e.target.value);
            setTyped(e.target.value);
            setActive(-1);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (!listing) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const from = active >= 0 ? active : shown.indexOf(value);
              const step = e.key === 'ArrowDown' ? 1 : -1;
              setActive((from + step + shown.length) % shown.length);
            } else if (e.key === 'Enter' && active >= 0) {
              e.preventDefault();
              pick(shown[active]);
            } else if (e.key === 'Escape') {
              close();
            }
          }}
        />
        {models.length > 0 && (
          <button
            type="button"
            className="ghost model-toggle"
            aria-label={`Show the models for ${label.toLowerCase()}`}
            // Kept from taking the focus, so the field stays open behind it.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (open ? close() : setOpen(true))}
          >
            ▾
          </button>
        )}
      </span>
      {listing && (
        <ul className="model-list" role="listbox" ref={listRef}>
          {shown.map((model, i) => (
            <li key={model}>
              <button
                type="button"
                role="option"
                aria-selected={model === value}
                className={`${model === value ? 'chosen' : ''}${i === active ? ' active' : ''}`}
                // A tap on the list must not first blur the field and close it.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(model)}
              >
                {model}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
