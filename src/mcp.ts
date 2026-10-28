import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { commands } from "./commands.js";
import { DocError, type Principal } from "./doc.js";
import type { DocsService } from "./service.js";
import { VERSION } from "./version.js";

/**
 * Tools mirror the CLI commands, named `doc_<command>`. The author is fixed when the
 * server starts. A tool call cannot claim another identity.
 */
export function createMcpServer(service: DocsService, author: Principal | undefined): McpServer {
  const server = new McpServer({ name: "agentic-documents", version: VERSION });
  for (const command of commands) {
    server.registerTool(
      `doc_${command.name}`,
      { description: command.description, inputSchema: command.shape, annotations: { readOnlyHint: command.readOnly } },
      async (input) => {
        try {
          const result = await command.run(service, input, author);
          return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) }] };
        } catch (error) {
          if (!(error instanceof DocError)) throw error;
          const body = { error: { code: error.code, message: error.message, matches: error.matches } };
          return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError: true };
        }
      },
    );
  }
  return server;
}

export async function startMcp(service: DocsService, author: Principal | undefined): Promise<void> {
  await createMcpServer(service, author).connect(new StdioServerTransport());
}
