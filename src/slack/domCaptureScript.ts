import { captureDomSnapshot, type DomCaptureInput } from "./domCaptureCore.js";

export function buildDomCaptureExpression(input: DomCaptureInput): string {
  const serialized = JSON.stringify(input);
  const captureSource = captureDomSnapshot.toString();
  return `(() => {
    const __name = (target) => target;
    const input = ${serialized};
    const capture = ${captureSource};
    return capture(document, input);
  })()`;
}
