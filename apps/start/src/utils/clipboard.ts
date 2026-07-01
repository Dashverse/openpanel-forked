import { toast } from 'sonner';

// Keep the toast preview small — long values (e.g. a full event JSON) would
// otherwise blow up the snackbar.
function truncateForToast(value: string, maxLines = 6, maxChars = 240): string {
  const lines = value.split('\n');
  let preview = lines.slice(0, maxLines).join('\n');
  const clipped = lines.length > maxLines || preview.length > maxChars;
  if (preview.length > maxChars) {
    preview = preview.slice(0, maxChars);
  }
  return clipped ? `${preview.trimEnd()}\n…` : preview;
}

export function clipboard(value: string | number, description?: null | string) {
  navigator.clipboard.writeText(value.toString());
  toast(
    'Copied to clipboard',
    description !== null
      ? {
          description: description ?? truncateForToast(value.toString()),
        }
      : {},
  );
}
