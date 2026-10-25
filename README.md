# TicketReady GitHub Issues MCP

This MCP server supports local stdio and remote Streamable HTTP. Remote mode is an OAuth 2.1 resource server: an external authorization server issues access tokens, and this service validates them before invoking MCP tools. It does not issue OAuth tokens itself.

## Remote OAuth configuration

1. Configure an OAuth authorization server that supports MCP-compatible authorization discovery and issues signed JWT access tokens.
2. Register the MCP public URL as an audience/resource at that authorization server. Tokens must have `aud` exactly matching `MCP_PUBLIC_URL`, an `iss` matching `OAUTH_ISSUER`, an unexpired `exp`, a valid signing key in the issuer's JWKS, and the configured MCP scopes.
3. Set `OAUTH_METADATA_URL` to the issuer's OpenID Connect discovery document (or an equivalent document that includes `issuer` and `jwks_uri`). The server checks that the metadata issuer matches `OAUTH_ISSUER` and loads the signing keys before listening.
4. Publish the server behind HTTPS. Configure `MCP_TLS_CERT_FILE` and `MCP_TLS_KEY_FILE` for TLS at this process, or set `MCP_TLS_TERMINATED=true` only when a trusted reverse proxy provides HTTPS and the backend is not publicly reachable.
5. Build and run with `npm run build` and `npm run start:http`.

The service publishes OAuth Protected Resource Metadata at the path-aware RFC 9728 URL for `MCP_PUBLIC_URL`. Its `WWW-Authenticate` challenge points clients at the resource metadata document. Set `MCP_ALLOWED_ORIGINS` to a comma-separated list of allowed origin hostnames when browser clients send an `Origin` header.

Required remote settings:

- `MCP_PUBLIC_URL`: public HTTPS resource URL, including the MCP path (for example `https://mcp.example.com/mcp`). This is also the required token audience.
- `OAUTH_ISSUER`: exact issuer identifier in tokens.
- `OAUTH_METADATA_URL`: HTTPS discovery document URL containing the matching `issuer` and a `jwks_uri`.
- `MCP_REQUIRED_SCOPES`: whitespace-separated scopes, default `mcp`.

The verifier supports RS256, ES256, and EdDSA JWT signatures. It rejects unsigned tokens, unsupported algorithms, invalid signatures, mismatched issuer/audience, missing or expired expiry, future `nbf`, and missing required scopes. JWKS are cached for five minutes and metadata/key fetches have time and response-size bounds.

## Current security boundary

Remote mode now validates caller identity and token audience before tool dispatch. The existing GitHub tool implementation still uses `GITHUB_TOKEN`/`GH_TOKEN`; per-user GitHub App authorization and repository permission mapping are the next security layer, not part of this remote OAuth boundary. Keep repository access restricted and writes disabled until that layer is configured. Writes require `GITHUB_ENABLE_WRITES=true`.

For local development, run `npm run build` then `npm run start:stdio`. See `.env.example` for configuration names; put real secrets in a secret manager or local untracked environment file.
