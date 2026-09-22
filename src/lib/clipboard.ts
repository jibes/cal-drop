import { prepareImage, type Prepared } from './image';

/**
 * Looking at the clipboard, where the browser allows it.
 *
 * Reading the clipboard is privileged: a page may do it silently only once the
 * user has granted it, and otherwise only inside a gesture, often behind the
 * browser's own paste confirmation. So a preview is offered where permission
 * exists and a button where it does not — the same shape as the camera.
 */

export interface ClipboardPeek {
  kind: 'text' | 'image';
  /** For text: the text itself. For an image: a short description. */
  text: string;
  image?: Prepared;
}

/**
 * Inside the Android app the WebView refuses navigator.clipboard outright —
 * there is no prompt to grant it — so the shell reads the clipboard natively.
 * In a browser there is no such plugin and the web API is used as before.
 */
interface ClipboardRead {
  read(): Promise<{ text?: string; type?: string; data?: string }>;
}

const nativeClipboard = (): ClipboardRead | undefined =>
  (globalThis as { Capacitor?: { Plugins?: { ClipboardRead?: ClipboardRead } } }).Capacitor?.Plugins
    ?.ClipboardRead;

export function clipboardReadable(): boolean {
  if (nativeClipboard()) return true;
  return Boolean(navigator.clipboard?.read || navigator.clipboard?.readText) && window.isSecureContext;
}

/** Can the clipboard be read without the user being asked at that moment? */
export async function canPeekSilently(): Promise<boolean> {
  // Android shows a "pasted from your clipboard" notice on every native read,
  // so in the app it is read when Paste is pressed and never just to preview.
  if (nativeClipboard()) return false;
  try {
    const status = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName });
    return status.state === 'granted';
  } catch {
    // Safari and Firefox do not answer; they will prompt, so do not peek.
    return false;
  }
}

const IMAGE_TYPE = /^image\//;

/** Base64 bytes as a Blob, which is what prepareImage takes from any source. */
function toBlob(data: string, type: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function readNative(plugin: ClipboardRead): Promise<ClipboardPeek | null> {
  try {
    const clip = await plugin.read();
    if (clip.data && clip.type && IMAGE_TYPE.test(clip.type)) {
      const image = await prepareImage(toBlob(clip.data, clip.type));
      return { kind: 'image', text: `image, ${image.width}×${image.height}`, image };
    }
    const text = (clip.text ?? '').trim();
    return text ? { kind: 'text', text } : null;
  } catch {
    return null;
  }
}

export async function readClipboard(): Promise<ClipboardPeek | null> {
  const plugin = nativeClipboard();
  if (plugin) return readNative(plugin);
  if (!navigator.clipboard) return null;

  if (navigator.clipboard.read) {
    try {
      for (const item of await navigator.clipboard.read()) {
        const imageType = item.types.find((type) => IMAGE_TYPE.test(type));
        if (imageType) {
          const image = await prepareImage(await item.getType(imageType));
          return { kind: 'image', text: `image, ${image.width}×${image.height}`, image };
        }
      }
    } catch {
      // Denied, or nothing readable; a plain text read may still work.
    }
  }

  try {
    const text = (await navigator.clipboard.readText?.()) ?? '';
    return text.trim() ? { kind: 'text', text: text.trim() } : null;
  } catch {
    return null;
  }
}
