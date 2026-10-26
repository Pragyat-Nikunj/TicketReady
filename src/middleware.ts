
import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyAccessToken } from "./auth.js";

export async function authenticateRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const authorization = req.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    res.writeHead(401, {
      "WWW-Authenticate":
        'Bearer resource_metadata="https://YOUR_PUBLIC_HOST/.well-known/oauth-protected-resource/mcp"',
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({ error: "Missing bearer token" }));
    return false;
  }

  const token = authorization.slice("Bearer ".length).trim();

  try {
    await verifyAccessToken(token);
    return true;
  } catch (error) {
    console.error(
      "Access token rejected:",
      error instanceof Error ? error.message : "Unknown error",
    );

    res.writeHead(401, {
      "WWW-Authenticate": "Bearer error=\"invalid_token\"",
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({ error: "Invalid access token" }));
    return false;
  }
}
