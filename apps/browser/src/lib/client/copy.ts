export async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const doc =
    typeof globalThis !== "undefined" && "document" in globalThis
      ? (globalThis.document as Document)
      : null;
  if (!doc) {
    throw new Error("Clipboard API is not available in this environment");
  }
  const textarea = doc.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  doc.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  doc.execCommand("copy");
  doc.body.removeChild(textarea);
}
