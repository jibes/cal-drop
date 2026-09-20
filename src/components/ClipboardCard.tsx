import { useCallback, useEffect, useState } from 'react';
import { canPeekSilently, clipboardReadable, readClipboard, type ClipboardPeek } from '../lib/clipboard';
import { SHARP_ENOUGH } from '../lib/image';

interface Props {
  onText: (value: string) => void;
  onShots: (images: string[], warning: string) => void;
  busy: boolean;
}

/**
 * What is on the clipboard, and one tap to send it.
 *
 * Pasting already works by pasting, but that means finding the box first and
 * trusting that the right thing is on the clipboard. Showing what will be sent
 * removes both: the copied poster text or screenshot is visible, and sending it
 * is a tap. Where the browser will not let the clipboard be read unprompted,
 * the button reads and sends in one gesture instead.
 */
export function ClipboardCard({ onText, onShots, busy }: Props) {
  const [peek, setPeek] = useState<ClipboardPeek | null>(null);
  const [silent, setSilent] = useState(false);

  const look = useCallback(async () => {
    if (!(await canPeekSilently())) return;
    setSilent(true);
    // A read can fail simply because the document is not focused yet, so a
    // failure means "nothing to show", never "remove the way to paste".
    setPeek(await readClipboard());
  }, []);

  useEffect(() => {
    if (!clipboardReadable()) return;
    void look();
    // Something may have been copied while the app was in the background, and
    // the first read on load often lands before the document has focus.
    const onFocus = () => void look();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [look]);

  const send = useCallback(
    (found: ClipboardPeek | null) => {
      if (!found) return;
      if (found.kind === 'image' && found.image) {
        const longest = Math.max(found.image.width, found.image.height);
        onShots(
          [found.image.url],
          longest < SHARP_ENOUGH
            ? `That image is only ${longest}px wide, which may be too soft for small print.`
            : '',
        );
      } else {
        onText(found.text);
      }
      setPeek(null);
    },
    [onShots, onText],
  );

  if (!clipboardReadable()) return null;

  /**
   * Without something to show, the button reads and sends inside the tap —
   * which is also the only thing a browser allows before permission is given.
   * There is always a control here: a clipboard that could not be read, or was
   * empty at the moment it was looked at, must not remove the way to paste.
   */
  if (!peek) {
    return (
      <button
        className="clipboard ask"
        disabled={busy}
        onClick={() => void readClipboard().then(send)}
        title={silent ? 'Nothing readable on the clipboard just now' : undefined}
      >
        📋 Paste from clipboard
      </button>
    );
  }

  return (
    <button className="clipboard" disabled={busy} onClick={() => send(peek)}>
      <span className="clip-icon">📋</span>
      {peek.kind === 'image' && peek.image ? (
        <img className="clip-thumb" src={peek.image.url} alt="" />
      ) : null}
      <span className="clip-text">{peek.kind === 'image' ? peek.text : peek.text.slice(0, 140)}</span>
      <span className="clip-go">Read it</span>
    </button>
  );
}
