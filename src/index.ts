import { McpServer } from "@modelcontextprotocol/server";
import { createServer as createHttpServer } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { authenticateRequest } from "./middleware.js";
import { initializeAuth } from "./auth.js";
import { z } from "zod";

function createMcpServer() {
  const server = new McpServer({ name: "github-issues", version: "1.0.0" });

  const repositorySchema = z
    .string()
    .regex(
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
      "Repository must be in owner/repo format",
    );

  async function githubRequest<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ticketready-github-issues-mcp",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
      };
      const detail = body.message ? `: ${body.message}` : "";
      if (response.status === 401)
        throw new Error(
          `GitHub authentication failed${detail}. Check GITHUB_TOKEN or GH_TOKEN.`,
        );
      if (response.status === 403 || response.status === 429)
        throw new Error(
          `GitHub API rate limit or access restriction${detail}. Set GITHUB_TOKEN for a higher limit or private repository access.`,
        );
      if (response.status === 404)
        throw new Error(
          `GitHub resource not found${detail}. Check the repository name, issue number, and repository access.`,
        );
      if (response.status === 422)
        throw new Error(
          `GitHub rejected the request${detail}. Check the issue fields, labels, assignees, and milestone.`,
        );
      throw new Error(
        `GitHub API request failed (${response.status})${detail}`,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  function repositoryPath(repository: string, suffix: string): string {
    const [owner, name] = repository.split("/");
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`;
  }

  type GitHubIssue = {
    number: number;
    title: string;
    body: string | null;
    state: string;
    html_url: string;
    user: { login: string } | null;
    labels: Array<{ name: string }>;
    created_at: string;
    updated_at: string;
    comments: number;
    pull_request?: { url: string };
    assignees?: Array<{ login: string }>;
    milestone?: { title: string } | null;
  };

  type GitHubComment = {
    id: number;
    user: { login: string } | null;
    body: string | null;
    created_at: string;
    updated_at?: string;
    html_url: string;
  };

  function issueSummary(issue: GitHubIssue) {
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      url: issue.html_url,
      author: issue.user?.login ?? null,
      labels: issue.labels.map((label) => label.name),
      assignees: issue.assignees?.map((assignee) => assignee.login) ?? [],
      milestone: issue.milestone?.title ?? null,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      comments: issue.comments,
    };
  }

  server.registerTool(
    "search_issues",
    {
      description:
        "Check whether an issue matching a description already exists in a GitHub repository. Returns only true or false.",
      inputSchema: z.object({
        repository: repositorySchema.describe(
          "GitHub repository in owner/repo format",
        ),
        query: z
          .string()
          .min(1)
          .describe("Issue description or keywords to search for"),
        state: z.enum(["open", "closed", "all"]).default("all"),
      }),
    },
    async ({ repository, query, state }) => {
      const params = new URLSearchParams({
        q: `repo:${repository} is:issue ${state === "all" ? "" : `state:${state} `}${query}`,
        per_page: "1",
        sort: "best-match",
      });
      const result = await githubRequest<{ items: GitHubIssue[] }>(
        `/search/issues?${params}`,
      );
      const exists = result.items.some((issue) => !issue.pull_request);
      return {
        content: [{ type: "text", text: String(exists) }],
        structuredContent: { exists },
      };
    },
  );

  server.registerTool(
    "get_issue",
    {
      description:
        "Retrieve a GitHub issue and its comments by repository and issue number.",
      inputSchema: z.object({
        repository: repositorySchema.describe(
          "GitHub repository in owner/repo format",
        ),
        issue_number: z.number().int().positive(),
      }),
    },
    async ({ repository, issue_number }) => {
      const [issue, comments] = await Promise.all([
        githubRequest<GitHubIssue>(
          repositoryPath(repository, `/issues/${issue_number}`),
        ),
        githubRequest<GitHubComment[]>(
          `${repositoryPath(repository, `/issues/${issue_number}/comments`)}?per_page=100`,
        ),
      ]);
      const output = {
        repository,
        ...issueSummary(issue),
        commentsList: comments.map((comment) => ({
          id: comment.id,
          author: comment.user?.login ?? null,
          body: comment.body,
          createdAt: comment.created_at,
          url: comment.html_url,
        })),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "list_repository_issues",
    {
      description:
        "Browse repository issues with filters and pagination. Pull requests are excluded.",
      inputSchema: z.object({
        repository: repositorySchema.describe(
          "GitHub repository in owner/repo format",
        ),
        state: z.enum(["open", "closed", "all"]).default("open"),
        labels: z
          .array(z.string().min(1))
          .default([])
          .describe("Issues must have all of these labels"),
        assignee: z.string().optional(),
        creator: z.string().optional(),
        since: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe("Only issues updated since this ISO 8601 timestamp"),
        sort: z.enum(["created", "updated", "comments"]).default("created"),
        direction: z.enum(["asc", "desc"]).default("desc"),
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(1).max(100).default(30),
      }),
    },
    async ({
      repository,
      state,
      labels,
      assignee,
      creator,
      since,
      sort,
      direction,
      page,
      per_page,
    }) => {
      const params = new URLSearchParams({
        state,
        sort,
        direction,
        page: String(page),
        per_page: String(per_page),
      });
      if (labels.length) params.set("labels", labels.join(","));
      if (assignee) params.set("assignee", assignee);
      if (creator) params.set("creator", creator);
      if (since) params.set("since", since);
      const issues = await githubRequest<GitHubIssue[]>(
        `${repositoryPath(repository, "/issues")}?${params}`,
      );
      const output = {
        repository,
        page,
        perPage: per_page,
        issues: issues.filter((issue) => !issue.pull_request).map(issueSummary),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "create_issue",
    {
      description:
        "Create a GitHub issue after user approval. Set approved to true only after the user has approved the exact issue details.",
      inputSchema: z.object({
        repository: repositorySchema.describe(
          "GitHub repository in owner/repo format",
        ),
        title: z.string().trim().min(1).max(256),
        body: z.string().optional(),
        labels: z.array(z.string()).optional(),
        assignees: z.array(z.string()).optional(),
        milestone: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Milestone number"),
        approved: z
          .literal(true)
          .describe(
            "The user has approved creating this issue with these exact details",
          ),
      }),
    },
    async ({ repository, title, body, labels, assignees, milestone }) => {
      const issue = await githubRequest<GitHubIssue>(
        repositoryPath(repository, "/issues"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            ...(body !== undefined ? { body } : {}),
            ...(labels ? { labels } : {}),
            ...(assignees ? { assignees } : {}),
            ...(milestone ? { milestone } : {}),
          }),
        },
      );
      const output = { repository, ...issueSummary(issue) };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "list_issue_comments",
    {
      description:
        "Read comments on a GitHub issue with pagination and sort order.",
      inputSchema: z.object({
        repository: repositorySchema.describe(
          "GitHub repository in owner/repo format",
        ),
        issue_number: z.number().int().positive(),
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(1).max(100).default(30),
        sort: z.enum(["created", "updated"]).default("created"),
        direction: z.enum(["asc", "desc"]).default("asc"),
      }),
    },
    async ({ repository, issue_number, page, per_page, sort, direction }) => {
      const params = new URLSearchParams({
        page: String(page),
        per_page: String(per_page),
        sort,
        direction,
      });
      const comments = await githubRequest<GitHubComment[]>(
        `${repositoryPath(repository, `/issues/${issue_number}/comments`)}?${params}`,
      );
      const output = {
        repository,
        issueNumber: issue_number,
        page,
        perPage: per_page,
        comments: comments.map((comment) => ({
          id: comment.id,
          author: comment.user?.login ?? null,
          body: comment.body,
          createdAt: comment.created_at,
          updatedAt: comment.updated_at ?? null,
          url: comment.html_url,
        })),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "add_issue_comment",
    {
      description:
        "Add a comment to a GitHub issue after user approval. Set approved to true only after the user approves the exact comment.",
      inputSchema: z.object({
        repository: repositorySchema.describe(
          "GitHub repository in owner/repo format",
        ),
        issue_number: z.number().int().positive(),
        body: z.string().trim().min(1).max(65536),
        approved: z
          .literal(true)
          .describe("The user has approved posting this exact comment"),
      }),
    },
    async ({ repository, issue_number, body }) => {
      const comment = await githubRequest<GitHubComment>(
        repositoryPath(repository, `/issues/${issue_number}/comments`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        },
      );
      const output = {
        repository,
        issueNumber: issue_number,
        id: comment.id,
        author: comment.user?.login ?? null,
        body: comment.body,
        createdAt: comment.created_at,
        url: comment.html_url,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );
  return server;
}
if (process.argv.includes("--http")) {
  const issuer = process.env.OAUTH_ISSUER;
  const metadataUrl = process.env.OAUTH_METADATA_URL;
  const audience = process.env.MCP_PUBLIC_URL;

  if (!issuer || !metadataUrl || !audience) {
    throw new Error(
      "OAUTH_ISSUER, OAUTH_METADATA_URL, and MCP_PUBLIC_URL must be configured",
    );
  }

  await initializeAuth({
    issuer,
    metadataUrl,
    audience,
    requiredScopes: (process.env.MCP_REQUIRED_SCOPES ?? "mcp:tools")
      .split(/\s+/)
      .filter(Boolean),
  });
  const handler = createMcpHandler(createMcpServer);
  const nodeHandler = toNodeHandler(handler);

  const httpServer = createHttpServer(async (req, res) => {
    const metadataPath = "/.well-known/oauth-protected-resource/mcp";

    if (req.url?.split("?")[0] === metadataPath) {
      const resource = process.env.MCP_PUBLIC_URL;
      const issuer = process.env.OAUTH_ISSUER;

      if (!resource || !issuer) {
        res.writeHead(500);
        res.end("OAuth configuration missing");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      });

      res.end(
        JSON.stringify({
          resource,
          authorization_servers: [issuer],
          scopes_supported: (process.env.MCP_REQUIRED_SCOPES ?? "mcp:tools")
            .split(/\s+/)
            .filter(Boolean),
          bearer_methods_supported: ["header"],
        }),
      );

      return;
    }

    if (req.url?.split("?")[0] !== "/mcp") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    try {
      const authenticated = await authenticateRequest(req, res);

      if (!authenticated) {
        return;
      }

      nodeHandler(req, res);
    } catch (error) {
      console.error("MCP request error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  const port = Number(process.env.PORT ?? 3000);

  httpServer.listen(port, "127.0.0.1", () => {
    console.log(`MCP HTTP server listening on http://127.0.0.1:${port}/mcp`);
  });
} else {
  await serveStdio(createMcpServer, {
    onerror: (error) => console.error("GitHub issues MCP error:", error),
  });
}
