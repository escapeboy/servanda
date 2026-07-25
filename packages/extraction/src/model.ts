/**
 * The model surface available to extraction.
 *
 * §3.4 / §9.2 / M-6: "Extraction MUST run with no tool access."  The containment is structural,
 * not a convention: `ModelRequest` has no field in which a tool could be named, so no call site
 * — present or future — can hand the extraction model a capability. The Anthropic adapter below
 * builds its request body from this type alone and then re-asserts the absence at the boundary,
 * because that boundary is the only place the guarantee is observable from the outside.
 */

/** The complete set of knobs extraction is allowed to turn. No tools. No MCP servers. */
export interface ModelRequest {
  readonly model: string;
  readonly max_tokens: number;
  /** Single system string; envelope content never appears here (§9.2: content is data). */
  readonly system: string;
  readonly messages: ReadonlyArray<{ readonly role: 'user'; readonly content: string }>;
  /** Structured outputs: the response is constrained to the §3.4 extraction schema. */
  readonly output_config: {
    readonly format: { readonly type: 'json_schema'; readonly schema: Record<string, unknown> };
  };
}

export interface ModelResponse {
  /** The raw text the model produced. Never interpreted as anything but JSON to be validated. */
  readonly text: string;
  /** Informative only; absent on the stub path. */
  readonly model?: string;
}

export interface ModelClient {
  readonly id: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/**
 * The exact shape handed to the Anthropic SDK. Kept as a plain record so a test can inspect
 * every key that crosses the wire (M-06 asserts no tool-bearing key is present).
 */
export type MessagesCreateBody = Record<string, unknown>;
export type MessagesCreateFn = (body: MessagesCreateBody) => Promise<unknown>;

/** Keys that would grant the model a capability. None may appear in an extraction request. */
export const FORBIDDEN_REQUEST_KEYS = [
  'tools',
  'tool_choice',
  'mcp_servers',
  'container',
  'skills',
  'betas',
] as const;

export class ToolAccessError extends Error {
  constructor(key: string) {
    super(`M-6/§3.4: extraction request carries a capability key: ${key}`);
    this.name = 'ToolAccessError';
  }
}

/** Belt-and-braces check at the one place a capability could leak into the API call. */
export function assertToolLess(body: MessagesCreateBody): void {
  for (const key of FORBIDDEN_REQUEST_KEYS) {
    if (key in body) throw new ToolAccessError(key);
  }
}

export function toMessagesCreateBody(request: ModelRequest): MessagesCreateBody {
  const body: MessagesCreateBody = {
    model: request.model,
    max_tokens: request.max_tokens,
    system: request.system,
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    output_config: request.output_config,
  };
  assertToolLess(body);
  return body;
}

export interface AnthropicClientOptions {
  readonly model?: string;
  /**
   * Injection point for the SDK's `messages.create`. Defaults to a lazily-imported
   * `new Anthropic().messages.create`, so importing this module never requires the SDK.
   */
  readonly create?: MessagesCreateFn;
}

/** Model id used when none is given. */
export const DEFAULT_MODEL = 'claude-sonnet-5';

async function defaultCreate(): Promise<MessagesCreateFn> {
  // Non-literal specifier: the SDK is an optional runtime dependency, so this module must
  // typecheck and load on machines (and in gates) where it is not installed.
  const specifier = '@anthropic-ai/sdk';
  const mod = await import(specifier);
  const Anthropic = mod.default ?? mod.Anthropic;
  const client = new Anthropic();
  return (body: MessagesCreateBody) => client.messages.create(body);
}

function readText(response: unknown): string {
  const content = (response as { content?: unknown })?.content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const t = (block as { text?: unknown }).text;
      if (typeof t === 'string') text += t;
    }
  }
  return text;
}

/**
 * The one allowed external service (§ implementation brief). Tool-less by construction:
 * the body it sends is `toMessagesCreateBody(request)` and nothing else.
 */
export function createAnthropicModelClient(options: AnthropicClientOptions = {}): ModelClient {
  const model = options.model ?? DEFAULT_MODEL;
  let create = options.create;
  return {
    id: `anthropic:${model}`,
    async complete(request: ModelRequest): Promise<ModelResponse> {
      create ??= await defaultCreate();
      const body = toMessagesCreateBody({ ...request, model });
      const response = await create(body);
      return { text: readText(response), model };
    },
  };
}
