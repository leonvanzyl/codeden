import { toast } from "sonner";
import { platform } from "./platform";

/** Told to the user when nothing reached the clipboard. */
export function notifyCopyFailed(): void {
  toast.error("Couldn't copy. Select the text and copy it manually.");
}

/**
 * Copies `text` through the platform bridge: `success` is toasted when it worked, the
 * manual-copy hint when it didn't. Call it synchronously from the click handler so the copy
 * counts as part of the user's gesture. Resolves whether the copy worked.
 */
export async function copyWithFeedback(text: string, success?: string): Promise<boolean> {
  const ok = await platform.writeClipboard(text);
  if (!ok) notifyCopyFailed();
  else if (success) toast.success(success);
  return ok;
}
