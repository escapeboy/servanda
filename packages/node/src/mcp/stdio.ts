import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { callTool, TOOL_DEFINITIONS } from '../tools.js';
import type { ServandaNode } from '../node.js';

/**
 * A minimal MCP server over stdio (spec 2025-11-25): newline-delimited JSON-RPC 2.0 on stdin
 * and stdout, messages containing no embedded newlines, stderr free for logging.
 *
 * Written by hand rather than on @modelcontextprotocol/sdk deliberately. The §7 surface is
 * six tools and no resources, prompts, sampling or tasks; the SDK's value here would be
 * mostly its HTTP transports, and pulling in a dependency whose transitive graph includes a
 * fetch stack would weaken exactly the property GA has to prove — that a conforming node
 * needs no network (M-10). Nothing in this file, or anything it imports, can open a socket.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2024-11-05'] as const;
export const SERVER_INFO = { name: 'servanda-node', version: '0.1.0-pre' } as const;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export class McpServer {
  constructor(private readonly node: ServandaNode) {}

  /**
   * Handle one message. Returns null for notifications (no `id`), which per JSON-RPC MUST NOT
   * be answered.
   */
  handle(message: JsonRpcRequest): JsonRpcResponse | null {
    const { id, method } = message;
    if (id === undefined) return null; // notification, e.g. notifications/initialized

    try {
      switch (method) {
        case 'initialize':
          return ok(id, this.initialize(message.params));
        case 'ping':
          return ok(id, {});
        case 'tools/list':
          return ok(id, {
            tools: TOOL_DEFINITIONS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          });
        case 'tools/call':
          return ok(id, this.callTool(message.params));
        default:
          return fail(id, METHOD_NOT_FOUND, `method not found: ${method}`);
      }
    } catch (err) {
      return fail(id, INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
    }
  }

  private initialize(params: Record<string, unknown> | undefined): unknown {
    const requested = params?.['protocolVersion'];
    const version =
      typeof requested === 'string' &&
      (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
    return {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions:
        'Servanda node (§7). Five tools: commit, expect, confirm, open_loops, brief. ' +
        'A promise is owned by its giver — use `expect` for what someone else said they would do.',
    };
  }

  private callTool(params: Record<string, unknown> | undefined): unknown {
    const name = params?.['name'];
    if (typeof name !== 'string') {
      return { content: [text('tools/call requires a string `name`')], isError: true };
    }
    try {
      const result = callTool(this.node, name, params?.['arguments']);
      // Structured content plus the serialised text block, for clients that read either.
      return {
        content: [text(JSON.stringify(result))],
        structuredContent: result as Record<string, unknown>,
        isError: false,
      };
    } catch (err) {
      // A tool that refuses (M-1, M-2, M-14 …) is reporting a protocol rule, not crashing.
      // It belongs in the result as isError so the model sees WHY, per MCP tool-error guidance.
      return { content: [text(err instanceof Error ? err.message : String(err))], isError: true };
    }
  }

  /** Read newline-delimited JSON-RPC from `input`, write responses to `output`. */
  serve(input: Readable, output: Writable): Promise<void> {
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed === '') return;
      let message: JsonRpcRequest;
      try {
        message = JSON.parse(trimmed) as JsonRpcRequest;
      } catch {
        output.write(`${JSON.stringify(fail(0, INVALID_PARAMS, 'parse error'))}\n`);
        return;
      }
      const response = this.handle(message);
      if (response) output.write(`${JSON.stringify(response)}\n`);
    });
    return new Promise((resolve) => rl.on('close', () => resolve()));
  }
}

function text(value: string): { type: 'text'; text: string } {
  return { type: 'text', text: value };
}

function ok(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function fail(id: string | number, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
