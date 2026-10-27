# TicketReady MCP Server

**An MCP server for interacting with GitHub issues using AI assistants.**

TicketReady connects AI assistants to GitHub through the Model Context Protocol (MCP). It exposes GitHub issue operations as tools that an MCP-compatible client can discover and invoke, enabling users to explore repositories, find issues, retrieve issue information, and create GitHub issues through natural language.

## Features

- **GitHub Issue Search** — Search for issues across repositories using available GitHub tools.
- **Issue Details** — Retrieve relevant information about GitHub issues.
- **Create Issues** — Create GitHub issues with a title, description, labels, assignees, and milestone when provided.
- **Structured Tool Responses** — Return readable text and structured data to supported MCP clients.
- **MCP Integration** — Connect AI assistants to GitHub functionality through standardized MCP tools.
- **HTTP and STDIO Transports** — Run the server over HTTP or as a local STDIO-based MCP server.
- **TypeScript** — Built with TypeScript for type safety and maintainability.

## Tech Stack

- TypeScript
- Node.js
- Model Context Protocol (MCP)
- GitHub REST API
- GitHub Personal Access Token
- HTTP and STDIO transports

## Architecture

```text
User
  |
  v
AI Assistant / MCP Client
  |
  v
TicketReady MCP Server
  |
  v
GitHub REST API
  |
  v
GitHub Issues
```

The AI assistant invokes the tools exposed by TicketReady. The server processes each request, communicates with the GitHub API, and returns the result through MCP. The assistant then uses that result to respond to the user.

## Getting Started

### Prerequisites

- Node.js
- npm
- A GitHub account
- A GitHub Personal Access Token with the repository permissions required by your intended operations
- An MCP-compatible client

### 1. Clone the Repository

```bash
git clone https://github.com/Pragyat-Nikunj/TicketReady.git
cd TicketReady
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Create a `.env` file in the project root:

```env
GITHUB_TOKEN=your_github_token
PORT=3000
```

Replace `your_github_token` with your GitHub Personal Access Token.

Use a token with only the permissions your tools require. Creating or modifying issues requires write access to the relevant repository.

**Security:** Never commit your `.env` file or expose your GitHub token in client-side code, logs, or public repositories.

### 4. Build the Project

```bash
npm run build
```

### 5. Run the MCP Server

**HTTP transport**

```bash
node --env-file=.env build/index.js --http
```

The server listens on the configured port, defaulting to `3000`, and exposes the MCP endpoint at:

```text
http://localhost:3000/mcp
```

**STDIO transport**

```bash
node --env-file=.env build/index.js
```

Use STDIO when configuring a compatible local MCP client. Configure the client to launch the server using the appropriate Node.js command and working directory.

## Available Capabilities

TicketReady exposes GitHub issue functionality through MCP tools.

| Capability | Description |
|---|---|
| Search issues | Find GitHub issues using the available search tool. |
| Retrieve issue information | Access relevant issue details through the available tools. |
| Create an issue | Create an issue in a specified repository. |
| Optional issue fields | Provide a body, labels, assignees, and milestone when supported by the tool inputs. |

The exact tool names and input schemas are defined by the server implementation.

## Example Use Cases

Once connected to an MCP-compatible AI assistant, you can make requests such as:

- "Find open issues in `owner/repository`."
- "Search for beginner-friendly issues related to Java."
- "Show me the details of this GitHub issue."
- "Create an issue in `owner/repository` titled 'Add input validation'."
- "Create an issue with a description and appropriate labels."

The assistant selects an available tool, sends the required arguments to TicketReady, and uses the returned result to formulate its response.

## How Tool Responses Work

TicketReady returns tool results through MCP so that the connected AI assistant can interpret them.

For example, a successful issue-creation operation can return:

```json
{
  "repository": "owner/repository",
  "number": 42,
  "title": "Add input validation",
  "url": "https://github.com/owner/repository/issues/42"
}
```

The fields shown here are illustrative. Actual fields depend on the response produced by the server's issue-summary function.

The server can return both text content and structured content, allowing compatible clients to display the result or work with its fields.

## Deployment

TicketReady can be deployed to a hosting provider that supports Node.js applications, such as Render.

Typical deployment configuration:

**Build command**

```bash
npm ci && npm run build
```

**Start command**

```bash
node build/index.js --http
```

Configure `GITHUB_TOKEN` and any required environment variables through the hosting provider's environment settings. Do not upload your local `.env` file.

After deployment, the MCP endpoint follows this pattern:

```text
https://your-service.example.com/mcp
```

For the current deployment, the endpoint is:

```text
https://ticketready.onrender.com/mcp
```

## Security Considerations

The current HTTP configuration is intended for testing and development without OAuth authentication.

- The HTTP endpoint does not authenticate incoming MCP requests.
- Anyone who can reach a publicly deployed endpoint may be able to invoke its exposed tools.
- GitHub operations run using the permissions of the configured GitHub token.
- Use a token with the minimum necessary permissions.
- Avoid exposing sensitive repositories or write operations through an unrestricted public endpoint.
- Add an appropriate authentication and authorization layer before using the service in a production environment.


## Project Goals

TicketReady demonstrates how the Model Context Protocol can connect AI assistants with external developer tools. By exposing GitHub issue operations through a standardized interface, it makes repository exploration and issue management accessible through natural language.

The project also provides practical experience with TypeScript, API integration, MCP tool definitions, asynchronous programming, and structured tool responses.

## Author

**Pragyat Nikunj**

GitHub: [@Pragyat-Nikunj](https://github.com/Pragyat-Nikunj)

