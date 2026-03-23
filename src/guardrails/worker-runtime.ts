import type {
  GuardrailPermissionOutcome,
  GuardrailPermissionRequest,
  GuardrailPromptContext,
} from "./types.js";

type GuardrailPermissionRequester = (
  input: GuardrailPermissionRequest
) => Promise<GuardrailPermissionOutcome>;

let permissionRequester: GuardrailPermissionRequester | null = null;

const promptContextBySessionId = new Map<string, GuardrailPromptContext>();

export function configureGuardrailPermissionRequester(
  requester: GuardrailPermissionRequester | null
): void {
  permissionRequester = requester;
}

export async function requestGuardrailPermission(
  input: GuardrailPermissionRequest
): Promise<GuardrailPermissionOutcome> {
  if (permissionRequester === null) {
    throw new Error("GUARDRAIL_PERMISSION_REQUESTER_NOT_CONFIGURED");
  }
  return await permissionRequester(input);
}

export function setGuardrailPromptContext(context: GuardrailPromptContext): void {
  promptContextBySessionId.set(context.sessionId, context);
}

export function clearGuardrailPromptContext(sessionId: string): void {
  promptContextBySessionId.delete(sessionId);
}

export function getGuardrailPromptContext(sessionId: string): GuardrailPromptContext | undefined {
  return promptContextBySessionId.get(sessionId);
}
