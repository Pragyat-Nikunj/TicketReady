import { createPublicKey, verify as verifySignature } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  oauthMetadataResponse,
  originValidationResponse,
  OAuthError,
  requireBearerAuth,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { createServer } from "./index.js";

type JwtClaims = {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  sub?: unknown;
  scope?: unknown;
  scp?: unknown;
  azp?: unknown;
  client_id?: unknown;
};
type Jwk = { kty: string; crv?: string; kid?: string; use?: string; alg?: string; [key: string]: unknown };
type JwkSet = { keys: Jwk[] };

const BODY_LIMIT = 1_048_576;
const JWKS_CACHE_MS = 5 * 60_000;
let cachedKeys: JwkSet | undefined;
let cachedKeysAt = 0;
let remoteHandler: ReturnType<typeof createMcpHandler>;
let authenticate: ReturnType<typeof requireBearerAuth>;
let resourceUrl: URL;
let issuerUrl: URL;
let oauthMetadata: Record<string, unknown>;

function requiredUrl(name: string, value: string | undefined): URL {
  if (!value) throw new Error(`${name} is required for remote MCP mode.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`${name} must use HTTPS outside local development.`);
  }
  return url;
}

function invalidToken(message = "Access token is invalid."): OAuthError {
  return new OAuthError("invalid_token", message);
}

async function fetchJson(url: URL): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`OAuth metadata endpoint returned HTTP ${response.status}.`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > BODY_LIMIT) throw new Error("OAuth metadata response is too large.");
    const text = await response.text();
    if (Buffer.byteLength(text) > BODY_LIMIT) throw new Error("OAuth metadata response is too large.");
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

async function getJwks(uri: URL, forceRefresh = false): Promise<JwkSet> {
  if (!forceRefresh && cachedKeys && Date.now() - cachedKeysAt < JWKS_CACHE_MS) return cachedKeys;
  const body = await fetchJson(uri) as Partial<JwkSet>;
  if (!Array.isArray(body.keys) || body.keys.length === 0 || body.keys.length > 100) {
    throw new Error("OAuth JWKS document has an invalid keys collection.");
  }
  cachedKeys = body as JwkSet;
  cachedKeysAt = Date.now();
  return cachedKeys;
}

function decodeSegment(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw invalidToken();
  return Buffer.from(segment, "base64url");
}

function verifyJwtSignature(header: Record<string, unknown>, signingInput: string, signature: Buffer, jwk: Jwk): boolean {
  const algorithm = header.alg;
  const key = createPublicKey({ key: jwk as Parameters<typeof createPublicKey>[0] extends { key: infer K } ? K : never, format: "jwk" });
  if (algorithm === "RS256" && jwk.kty === "RSA") {
    return verifySignature("RSA-SHA256", Buffer.from(signingInput), key, signature);
  }
  if (algorithm === "ES256" && jwk.kty === "EC" && jwk.crv === "P-256") {
    return verifySignature("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" }, signature);
  }
  if (algorithm === "EdDSA" && jwk.kty === "OKP" && jwk.crv === "Ed25519") {
    return verifySignature(null, Buffer.from(signingInput), key, signature);
  }
  throw invalidToken("Access token uses an unsupported signing algorithm.");
}

async function verifyAccessToken(token: string): Promise<AuthInfo> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || token.length > 16_384) throw invalidToken();
    const header = JSON.parse(decodeSegment(parts[0]).toString("utf8")) as Record<string, unknown>;
    const claims = JSON.parse(decodeSegment(parts[1]).toString("utf8")) as JwtClaims;
    if (typeof header.kid !== "string" || typeof header.alg !== "string" || header.crit !== undefined || header.b64 === false) throw invalidToken();
    const jwksUri = new URL(String(oauthMetadata.jwks_uri));
    if (jwksUri.protocol !== "https:" && jwksUri.hostname !== "localhost") throw new Error("OAuth JWKS URI must use HTTPS.");
    let jwks = await getJwks(jwksUri);
    let jwk = jwks.keys.find((key) => key.kid === header.kid && (!key.use || key.use === "sig") && (!key.alg || key.alg === header.alg));
    if (!jwk) {
      jwks = await getJwks(jwksUri, true);
      jwk = jwks.keys.find((key) => key.kid === header.kid && (!key.use || key.use === "sig") && (!key.alg || key.alg === header.alg));
    }
    if (!jwk || !verifyJwtSignature(header, `${parts[0]}.${parts[1]}`, decodeSegment(parts[2]), jwk)) throw invalidToken();

    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== issuerUrl.href.replace(/\/$/, "") && claims.iss !== issuerUrl.href) throw invalidToken();
    const audiences = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
    if (!audiences.includes(resourceUrl.href) || typeof claims.exp !== "number" || claims.exp <= now || (typeof claims.nbf === "number" && claims.nbf > now)) throw invalidToken();
    if (typeof claims.sub !== "string" || claims.sub.length < 1 || claims.sub.length > 255) throw invalidToken();
    const scopes = typeof claims.scope === "string"
      ? claims.scope.split(/\s+/).filter(Boolean)
      : typeof claims.scp === "string"
        ? claims.scp.split(/\s+/).filter(Boolean)
        : Array.isArray(claims.scp)
          ? claims.scp.filter((scope): scope is string => typeof scope === "string")
          : [];
    return {
      token,
      clientId: typeof claims.client_id === "string" ? claims.client_id : typeof claims.azp === "string" ? claims.azp : claims.sub,
      scopes,
      expiresAt: claims.exp,
      resource: resourceUrl,
      // Preserve the verified principal for per-user GitHub authorization added in the next layer.
      subject: claims.sub,
    } as AuthInfo;
  } catch (error) {
    if (OAuthError.isInstance(error)) throw error;
    console.error("OAuth access-token verification failed", error instanceof Error ? error.name : "unknown");
    throw invalidToken();
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new Error("MCP request body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendWebResponse(response: Response, outgoing: ServerResponse): void {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  if (!response.body) {
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!outgoing.write(Buffer.from(value))) await new Promise<void>((resolve) => outgoing.once("drain", resolve));
      }
      outgoing.end();
    } catch {
      outgoing.destroy();
    }
  };
  void pump();
  outgoing.on("close", () => void reader.cancel().catch(() => undefined));
}

export async function startRemoteServer(): Promise<void> {
  resourceUrl = requiredUrl("MCP_PUBLIC_URL", process.env.MCP_PUBLIC_URL);
  issuerUrl = requiredUrl("OAUTH_ISSUER", process.env.OAUTH_ISSUER);
  if (resourceUrl.protocol !== "https:") throw new Error("MCP_PUBLIC_URL must use HTTPS for remote deployment.");
  if (!process.env.OAUTH_METADATA_URL) throw new Error("OAUTH_METADATA_URL is required for OAuth discovery.");
  const metadataUrl = requiredUrl("OAUTH_METADATA_URL", process.env.OAUTH_METADATA_URL);
  oauthMetadata = await fetchJson(metadataUrl) as Record<string, unknown>;
  if (oauthMetadata.issuer !== issuerUrl.href.replace(/\/$/, "") && oauthMetadata.issuer !== issuerUrl.href) {
    throw new Error("OAUTH_METADATA_URL issuer does not match OAUTH_ISSUER.");
  }
  if (typeof oauthMetadata.jwks_uri !== "string") throw new Error("OAuth metadata must provide jwks_uri.");
  // Fetch the signing keys before listening so invalid issuer configuration fails closed.
  await getJwks(requiredUrl("OAuth jwks_uri", oauthMetadata.jwks_uri));

  const metadataUrlForResource = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  authenticate = requireBearerAuth({
    verifier: { verifyAccessToken },
    requiredScopes: (process.env.MCP_REQUIRED_SCOPES ?? "mcp").split(/\s+/).filter(Boolean),
    expectedResource: resourceUrl,
    resourceMetadataUrl: metadataUrlForResource,
  });
  remoteHandler = createMcpHandler(() => createServer());

  const requestHandler = createHttpServer(async (incoming, outgoing) => {
    try {
      const requestPath = new URL(incoming.url ?? "/", resourceUrl).pathname;
      const requestUrl = new URL(incoming.url ?? "/", resourceUrl);
      const pathMetadataRoute = getOAuthProtectedResourceMetadataUrl(resourceUrl);
      const metadataPath = new URL(pathMetadataRoute).pathname;
      if (requestPath !== resourceUrl.pathname && requestPath !== metadataPath) {
        outgoing.writeHead(404).end("Not found");
        return;
      }
      const body = ["GET", "HEAD"].includes(incoming.method ?? "GET") ? undefined : await readBody(incoming);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      if (incoming.headers.host?.toLowerCase() !== resourceUrl.host.toLowerCase()) {
        outgoing.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Invalid Host header.");
        return;
      }
      const request = new Request(requestUrl, {
        method: incoming.method,
        headers,
        ...(body ? { body, duplex: "half" } as RequestInit : {}),
      });
      const hostError = hostHeaderValidationResponse(request, [resourceUrl.host]);
      if (hostError) { sendWebResponse(hostError, outgoing); return; }
      const allowedOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? resourceUrl.host).split(",").map((origin) => origin.trim()).filter(Boolean);
      const originError = originValidationResponse(request, allowedOrigins);
      if (originError) { sendWebResponse(originError, outgoing); return; }
      const discovery = oauthMetadataResponse(request, {
        oauthMetadata: oauthMetadata as never,
        resourceServerUrl: resourceUrl,
        scopesSupported: (process.env.MCP_REQUIRED_SCOPES ?? "mcp").split(/\s+/).filter(Boolean),
        resourceName: "GitHub Issues MCP Server",
      });
      if (discovery) { sendWebResponse(discovery, outgoing); return; }
      const auth = await authenticate(request);
      if (auth instanceof Response) { sendWebResponse(auth, outgoing); return; }
      const response = await remoteHandler.fetch(request, { authInfo: auth });
      sendWebResponse(response, outgoing);
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === "MCP request body is too large.";
      const message = tooLarge ? "MCP request body is too large." : "MCP request failed.";
      if (!outgoing.headersSent) outgoing.writeHead(tooLarge ? 413 : 500, { "Content-Type": "text/plain; charset=utf-8" });
      outgoing.end(message);
      if (!tooLarge) console.error("Remote MCP request failed", error instanceof Error ? error.name : "unknown");
    }
  });
  const port = Number(process.env.MCP_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MCP_PORT must be a valid TCP port.");
  const certPath = process.env.MCP_TLS_CERT_FILE;
  const keyPath = process.env.MCP_TLS_KEY_FILE;
  if (Boolean(certPath) !== Boolean(keyPath)) throw new Error("Configure both MCP_TLS_CERT_FILE and MCP_TLS_KEY_FILE, or neither.");
  const listener = certPath && keyPath
    ? createHttpsServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, requestHandler.listeners("request")[0] as (request: IncomingMessage, response: ServerResponse) => void)
    : undefined;
  if ((!certPath || !keyPath) && process.env.MCP_TLS_TERMINATED !== "true") {
    throw new Error("Configure MCP_TLS_CERT_FILE and MCP_TLS_KEY_FILE, or set MCP_TLS_TERMINATED=true when a trusted reverse proxy provides HTTPS.");
  }
  const host = process.env.MCP_HOST ?? "0.0.0.0";
  (listener ?? requestHandler).listen(port, host, () => {
    console.error(`Remote MCP listening on ${process.env.MCP_HOST ?? "0.0.0.0"}:${port} for ${resourceUrl.href}`);
  });
}
