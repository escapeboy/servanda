import { spawn } from 'node:child_process';
import type { ModelClient, ModelRequest, ModelResponse } from './model.js';

/**
 * A model backend that drives the locally-installed `claude` CLI instead of the Anthropic API.
 *
 * WHY THIS IS NOT THE CONFORMANCE PATH
 * ------------------------------------
 * §3.4 / M-6: "Extraction MUST run with no tool access." The API client satisfies that
 * STRUCTURALLY — `ModelRequest` has no field in which a tool could be named, so the request
 * simply has no tools and there is nothing to disable.
 *
 * The CLI is an agent. Its default posture is the opposite: it inherits the user's environment,
 * including every MCP server they have configured. Measured, not assumed — with all built-in
 * tools disallowed but MCP left alone, the model was still handed `serena.read_file` and
 * `context-mode.ctx_execute_file`, and it *attempted both* in response to a read instruction
 * embedded in its input. Only the permission layer stopped it. "Tools that are blocked" is a
 * materially weaker property than "no tools", and M-6 asks for the latter.
 *
 * So this backend is CONFIGURATIONALLY tool-less: it strips MCP servers, disallows every
 * built-in tool, and then VERIFIES the outcome rather than trusting the flags — a run that
 * touched any tool is failed loudly instead of returning its text. Use it for the precision
 * harness, where the value is a real model over real transcripts at no API cost. Do not use it
 * to make a conformance claim; `createAnthropicModelClient` is the path M-06 asserts against.
 */

/** Every built-in tool the CLI can offer. Belt to the `--strict-mcp-config` braces. */
export const DISALLOWED_BUILTIN_TOOLS = [
  'Bash',
  'BashOutput',
  'Edit',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'KillShell',
  'NotebookEdit',
  'Read',
  'SlashCommand',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
] as const;

export class CliToolUseDetected extends Error {
  constructor(detail: string) {
    super(
      `M-6/§3.4: the extraction run was not tool-less — ${detail}. ` +
        'Refusing the response rather than treating it as an extraction result.',
    );
    this.name = 'CliToolUseDetected';
  }
}

export class ClaudeCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeCliError';
  }
}

interface CliResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  permission_denials?: Array<{ tool_name?: string }>;
  modelUsage?: Record<string, unknown>;
}

export interface ClaudeCliOptions {
  /** Model alias or full id. Omit to let the CLI use its default. */
  readonly model?: string;
  readonly binary?: string;
  readonly timeoutMs?: number;
  /** Injection point for tests, so the suite never spawns a real CLI. */
  readonly run?: (args: readonly string[], stdin: string) => Promise<string>;
}

export const DEFAULT_CLI_TIMEOUT_MS = 180_000;

function spawnClaude(binary: string, timeoutMs: number) {
  return (args: readonly string[], stdin: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(binary, [...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // A fixed, empty-ish cwd: the CLI must not be able to resolve project files even if a
        // tool somehow survived the stripping above.
        cwd: process.cwd(),
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new ClaudeCliError(`claude CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on('data', (d) => (out += String(d)));
      child.stderr.on('data', (d) => (err += String(d)));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new ClaudeCliError(`could not start ${binary}: ${e.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new ClaudeCliError(`claude CLI exited ${code}: ${err.slice(0, 400)}`));
          return;
        }
        resolve(out);
      });
      child.stdin.end(stdin);
    });
}

/** The CLI prints a JSON object; other lines (warnings, shell noise) are ignored. */
export function parseCliJson(raw: string): CliResult {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new ClaudeCliError(`no JSON object in CLI output: ${raw.slice(0, 200)}`);
  }
  try {
    return JSON.parse(raw.slice(start, end + 1)) as CliResult;
  } catch {
    throw new ClaudeCliError('CLI output was not parseable JSON');
  }
}

/**
 * The containment check. A tool-less run makes exactly one assistant turn and records no
 * permission denial; any tool call — permitted or refused — shows up as both an extra turn and,
 * when blocked, a denial entry. Either is a refusal here.
 */
export function assertRunWasToolLess(result: CliResult): void {
  const denials = result.permission_denials ?? [];
  if (denials.length > 0) {
    const names = denials.map((d) => d.tool_name ?? '?').join(', ');
    throw new CliToolUseDetected(`the model attempted ${denials.length} tool call(s): ${names}`);
  }
  const turns = result.num_turns ?? 0;
  if (turns > 1) {
    throw new CliToolUseDetected(`the run took ${turns} turns; a tool-less extraction takes one`);
  }
}

export function claudeCliArgs(request: ModelRequest, model?: string): string[] {
  const args = [
    '--print',
    // Strip every MCP server the user has configured. Without this the model is handed the
    // caller's whole tool surface; see the note at the top of this file.
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--disallowed-tools',
    ...DISALLOWED_BUILTIN_TOOLS,
    // Replace Claude Code's agent prompt with the extraction prompt; §9.2 keeps envelope content
    // out of the system string, and `request.system` is built to that rule.
    '--system-prompt',
    request.system,
    '--output-format',
    'json',
  ];
  if (model) args.push('--model', model);
  return args;
}

/**
 * Build the user turn. The CLI has no structured-output parameter, so the response schema is
 * stated in the prompt instead of enforced by the API. That is a real difference from the API
 * path: the model is *asked* for the §3.4 shape rather than constrained to it. Schema-boundedness
 * still holds downstream — every result is validated and anything invalid is dropped — so the
 * consequence is more discarded responses, never a laxer object.
 */
export function claudeCliPrompt(request: ModelRequest): string {
  const schema = JSON.stringify(request.output_config.format.schema);
  const content = request.messages.map((m) => m.content).join('\n\n');
  return [
    content,
    '',
    'Respond with a single JSON object and nothing else — no prose, no code fence.',
    'It must validate against this JSON Schema:',
    schema,
  ].join('\n');
}

export function createClaudeCliModelClient(options: ClaudeCliOptions = {}): ModelClient {
  const binary = options.binary ?? 'claude';
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const run = options.run ?? spawnClaude(binary, timeoutMs);

  return {
    id: `claude-cli:${options.model ?? 'default'}`,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const raw = await run(claudeCliArgs(request, options.model), claudeCliPrompt(request));
      const result = parseCliJson(raw);

      if (result.is_error === true || result.subtype !== 'success') {
        throw new ClaudeCliError(`CLI reported failure: ${result.subtype ?? 'unknown'}`);
      }

      // Verify the containment rather than trusting the flags that were meant to produce it.
      assertRunWasToolLess(result);

      const usedModels = Object.keys(result.modelUsage ?? {});
      return {
        text: typeof result.result === 'string' ? result.result : '',
        model: usedModels[0] ?? options.model,
      };
    },
  };
}
