export interface AuthenticateRequest {
  token?: string;
}

export interface AuthenticateResult {
  authenticated: boolean;
  authMethod: "none";
}

export function handleAuthenticate(_request: AuthenticateRequest): AuthenticateResult {
  return {
    authenticated: true,
    authMethod: "none",
  };
}
