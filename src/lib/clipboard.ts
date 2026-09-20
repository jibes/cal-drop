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

export function clipboardReadable(): boolean {
  return Boolean(navigator.clipboard?.read || navigator.clipboard?.readText) && window.isSecureContext;
}

/** Can the clipboard be read without the user being asked at that moment? */
export async function canPeekSilently(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName });
    return status.state === 'granted';
  } catch {
    // Safari and Firefox do not answer; they will prompt, so do not peek.
    return false;
  }
}

const IMAGE_TYPE = /^image\//;

export async function readClipboard(): Promise<ClipboardPeek | null> {
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
