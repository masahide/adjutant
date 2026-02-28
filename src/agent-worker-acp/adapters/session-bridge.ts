import {
  SessionRegistry,
  toSessionKey,
  type SessionBinding,
} from "../../control-plane/acp/session-registry.js";

export interface SessionBridgeBinding extends SessionBinding {
  registeredAt: string;
}

export class SessionBridge {
  private readonly registry: SessionRegistry;
  private readonly registeredAtBySessionId = new Map<string, string>();

  constructor(registry = new SessionRegistry()) {
    this.registry = registry;
  }

  ensureSession(sessionId: string): SessionBridgeBinding {
    const base = this.registry.registerSession(sessionId, toSessionKey(sessionId));
    const registeredAt = this.registeredAtBySessionId.get(sessionId) ?? new Date().toISOString();

    this.registeredAtBySessionId.set(sessionId, registeredAt);

    return {
      ...base,
      registeredAt,
    };
  }

  startRun(sessionId: string): SessionBridgeBinding {
    this.ensureSession(sessionId);
    const base = this.registry.startRun(sessionId);

    return {
      ...base,
      registeredAt: this.registeredAtBySessionId.get(sessionId) ?? new Date().toISOString(),
    };
  }

  resolve(sessionId: string): SessionBridgeBinding | undefined {
    const base = this.registry.resolveBySessionId(sessionId);
    if (base === undefined) {
      return undefined;
    }

    return {
      ...base,
      registeredAt: this.registeredAtBySessionId.get(sessionId) ?? new Date().toISOString(),
    };
  }
}
