import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

type AuthConfig = {
  issuer: string;
  metadataUrl: string;
  audience: string;
  requiredScopes: string[];
};

let verificationKeys: ReturnType<typeof createRemoteJWKSet>;
let trustedIssuer: string;
let trustedAudience: string;
let requiredScopes: string[];

export async function initializeAuth(config: AuthConfig) {
  // Load Auth0's discovery document.
  const response = await fetch(config.metadataUrl);

  if (!response.ok) {
    throw new Error(`Could not load OAuth metadata: HTTP ${response.status}`);
  }

  const metadata = (await response.json()) as {
    issuer?: string;
    jwks_uri?: string;
  };

  // Never trust a metadata document from an unexpected issuer.
  if (metadata.issuer !== config.issuer) {
    throw new Error("OAuth metadata issuer does not match OAUTH_ISSUER");
  }

  if (!metadata.jwks_uri) {
    throw new Error("OAuth metadata is missing jwks_uri");
  }

  const jwksUrl = new URL(metadata.jwks_uri);

  if (jwksUrl.protocol !== "https:") {
    throw new Error("OAuth JWKS URL must use HTTPS");
  }

  trustedIssuer = config.issuer;
  trustedAudience = config.audience;
  requiredScopes = config.requiredScopes;
  verificationKeys = createRemoteJWKSet(jwksUrl);
}

export async function verifyAccessToken(token: string): Promise<JWTPayload> {
  if (!verificationKeys) {
    throw new Error("OAuth verifier has not been initialized");
  }

  const { payload } = await jwtVerify(token, verificationKeys, {
    issuer: trustedIssuer,
    audience: trustedAudience,
    algorithms: ["RS256"],
  });
  console.log("Token scope:", payload.scope);
  console.log("Token permissions:", payload.permissions);
  if (typeof payload.exp !== "number") {
    throw new Error("Access token must have an expiration");
  }

  let scopes: string[];
  if (typeof payload.scope === "string") {
    scopes = payload.scope.split(/\s+/).filter(Boolean);
  } else if (Array.isArray(payload.permissions)) {
    scopes = payload.permissions.filter(
      (permission): permission is string => typeof permission === "string",
    );
  } else {
    scopes = [];
  }

  const tokenScopes = new Set(scopes);

  const missingScopes = requiredScopes.filter(
    (scope) => !tokenScopes.has(scope),
  );

  if (missingScopes.length > 0) {
    throw new Error(
      `Access token is missing required scopes: ${missingScopes.join(", ")}`,
    );
  }

  return payload;
}
