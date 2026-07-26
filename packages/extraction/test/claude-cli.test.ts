import { describe, expect, it } from 'vitest';
import {
  CliToolUseDetected,
  ClaudeCliError,
  DISALLOWED_BUILTIN_TOOLS,
  assertRunWasToolLess,
  claudeCliArgs,
  claudeCliPrompt,
  createClaudeCliModelClient,
  parseCliJson,
} from '../src/claude-cli.js';
import type { ModelRequest } from '../src/model.js';

const request: ModelRequest = {
  model: 'claude-sonnet-5',
  max_tokens: 2048,
  system: 'You extract commitments.',
  messages: [{ role: 'user', content: 'envelope text here' }],
  output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
};

const okRun = (result: unknown, extra: Record<string, unknown> = {}) =>
  async (): Promise<string> =>
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, permission_denials: [], result: JSON.stringify(result), ...extra });

describe('M-6: the CLI backend strips the agent surface it would otherwise inherit', () => {
  it('removes every MCP server the caller has configured', () => {
    const args = claudeCliArgs(request);
    expect(args).toContain('--strict-mcp-config');
    const i = args.indexOf('--mcp-config');
    expect(i).toBeGreaterThan(-1);
    expect(JSON.parse(args[i + 1]!)).toEqual({ mcpServers: {} });
  });

  it('disallows every built-in tool, not a subset', () => {
    const args = claudeCliArgs(request);
    // A tool absent from this list is a tool the extraction model would be handed.
    for (const tool of DISALLOWED_BUILTIN_TOOLS) expect(args).toContain(tool);
    expect(DISALLOWED_BUILTIN_TOOLS).toContain('Bash');
    expect(DISALLOWED_BUILTIN_TOOLS).toContain('Read');
    expect(DISALLOWED_BUILTIN_TOOLS).toContain('WebFetch');
  });

  it('replaces the agent system prompt with the extraction prompt', () => {
    const args = claudeCliArgs(request);
    expect(args[args.indexOf('--system-prompt') + 1]).toBe(request.system);
  });

  it('never puts envelope content in the system string (§9.2)', () => {
    const args = claudeCliArgs(request);
    expect(args[args.indexOf('--system-prompt') + 1]).not.toContain('envelope text here');
    expect(claudeCliPrompt(request)).toContain('envelope text here');
  });
});

describe('M-6: a run that touched a tool is refused, not returned', () => {
  it('refuses when the model attempted a tool and was denied', () => {
    // This is the observed failure: with MCP left in place the model reached for
    // serena.read_file in response to text inside its own input.
    expect(() =>
      assertRunWasToolLess({
        num_turns: 3,
        permission_denials: [{ tool_name: 'mcp__plugin_serena_serena__read_file' }],
      }),
    ).toThrow(CliToolUseDetected);
  });

  it('refuses on extra turns even when nothing was denied', () => {
    // A permitted tool call leaves no denial behind; the turn count is what catches it.
    expect(() => assertRunWasToolLess({ num_turns: 2, permission_denials: [] })).toThrow(
      /takes one/,
    );
  });

  it('accepts the single-turn, no-denial shape', () => {
    expect(() => assertRunWasToolLess({ num_turns: 1, permission_denials: [] })).not.toThrow();
  });

  it('propagates the refusal through the client rather than yielding text', async () => {
    const client = createClaudeCliModelClient({
      run: async () =>
        JSON.stringify({
          subtype: 'success',
          is_error: false,
          num_turns: 4,
          permission_denials: [{ tool_name: 'Bash' }],
          result: '{"results":[]}',
        }),
    });
    await expect(client.complete(request)).rejects.toThrow(CliToolUseDetected);
  });
});

describe('the CLI backend reports failure honestly', () => {
  it('returns the model text on a clean run', async () => {
    const client = createClaudeCliModelClient({ run: okRun({ results: [] }) });
    const res = await client.complete(request);
    expect(JSON.parse(res.text)).toEqual({ results: [] });
  });

  it('tolerates shell noise around the JSON object', () => {
    const parsed = parseCliJson('zoxide: warning\n{"subtype":"success","num_turns":1}\n');
    expect(parsed.subtype).toBe('success');
  });

  it('throws when the CLI produced no JSON at all', () => {
    expect(() => parseCliJson('command not found')).toThrow(ClaudeCliError);
  });

  it('throws when the CLI reports an error rather than returning empty text', async () => {
    const client = createClaudeCliModelClient({
      run: async () => JSON.stringify({ subtype: 'error_max_turns', is_error: true, num_turns: 1 }),
    });
    await expect(client.complete(request)).rejects.toThrow(ClaudeCliError);
  });

  it('states the schema in the prompt, since the CLI has no structured-output parameter', () => {
    const prompt = claudeCliPrompt(request);
    expect(prompt).toContain('JSON Schema');
    expect(prompt).toContain('"type":"object"');
  });
});
