import { PersonaId } from '@servanda/types';
import type { Envelope } from '@servanda/types';
import type { ModelClient, ModelRequest } from './model.js';
import { DEFAULT_MODEL } from './model.js';
import { buildUserContent, SYSTEM_PROMPT } from './prompt.js';
import { EXTRACTION_JSON_SCHEMA, parseExtractionResponse } from './schema.js';
import type { RawExtraction, ResponseRejection } from './schema.js';
import { route } from './routing.js';
import type { Routed, RoutingContext, RoutingFailure } from './routing.js';

/**
 * §3.4 extraction over a batch of §2 envelopes.
 *
 * Three properties are enforced here rather than documented:
 *   - **M-5, single-persona context.** The persona is a constructor argument, checked against
 *     every envelope on every call. An extractor cannot be re-pointed at another persona, and a
 *     batch cannot be mixed: `extract` refuses the whole batch rather than filtering it, because
 *     silently dropping the foreign envelopes would make a mixing bug invisible.
 *   - **M-6, tool-less.** The request is a `ModelRequest`, which has no field for a tool.
 *   - **Schema-bound.** Anything the model returns that does not validate yields zero
 *     commitments (§3.4: "objects valid against §3.1 or nothing").
 */

export class PersonaMixingError extends Error {
  constructor(
    readonly bound: string,
    readonly found: string,
    readonly envelopeId: string,
  ) {
    super(
      `M-5: extractor is bound to persona ${bound} but envelope ${envelopeId} belongs to ${found}; ` +
        `no org-context mixing in any pipeline`,
    );
    this.name = 'PersonaMixingError';
  }
}

export interface ExtractorOptions {
  /** Construction-time binding (M-5). One extractor, one persona, for its whole life. */
  readonly persona: string;
  readonly model: ModelClient;
  readonly maxTokens?: number;
  readonly resolveParty?: (label: string) => string | null;
  /** Injectable clock so runs are reproducible in tests and in `--dry-run`. */
  readonly now?: () => string;
}

export interface ExtractedItem {
  readonly raw: RawExtraction;
  readonly routed: Routed;
  readonly envelope: Envelope;
}

export type RunRejection =
  | { readonly stage: 'response'; readonly rejection: ResponseRejection }
  | { readonly stage: 'attribution'; readonly detail: string }
  | { readonly stage: 'routing'; readonly failure: RoutingFailure }
  /**
   * The model could not be reached at all. Distinct from every rejection above, which are
   * statements about what the model SAID; this one says it never spoke. A reader judging
   * precision must be able to tell "the model produced nothing usable" from "we never asked".
   */
  | { readonly stage: 'transport'; readonly detail: string };

export interface ExtractionRun {
  readonly persona: string;
  readonly envelopeIds: readonly string[];
  readonly items: readonly ExtractedItem[];
  /** Set when the response was discarded whole; `items` is then empty. */
  readonly rejection?: RunRejection;
  readonly modelId: string;
}

export class Extractor {
  readonly #persona: string;
  readonly #model: ModelClient;
  readonly #maxTokens: number;
  readonly #resolveParty: ((label: string) => string | null) | undefined;
  readonly #now: () => string;

  constructor(options: ExtractorOptions) {
    const persona = PersonaId.safeParse(options.persona);
    if (!persona.success) {
      throw new TypeError(`extractor persona must be a persona_id: ${persona.error.message}`);
    }
    this.#persona = persona.data;
    this.#model = options.model;
    this.#maxTokens = options.maxTokens ?? 8192;
    this.#resolveParty = options.resolveParty;
    this.#now = options.now ?? (() => new Date().toISOString().replace(/\.\d+Z$/, 'Z'));
  }

  get persona(): string {
    return this.#persona;
  }

  /** M-5: called before anything is read from the batch, let alone sent to a model. */
  #assertSinglePersona(envelopes: readonly Envelope[]): void {
    for (const envelope of envelopes) {
      if (envelope.persona !== this.#persona) {
        throw new PersonaMixingError(this.#persona, envelope.persona, envelope.id);
      }
    }
  }

  buildRequest(envelopes: readonly Envelope[]): ModelRequest {
    this.#assertSinglePersona(envelopes);
    return {
      model: DEFAULT_MODEL,
      max_tokens: this.#maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserContent(envelopes) }],
      output_config: { format: { type: 'json_schema', schema: EXTRACTION_JSON_SCHEMA } },
    };
  }

  async extract(envelopes: readonly Envelope[]): Promise<ExtractionRun> {
    this.#assertSinglePersona(envelopes);
    const envelopeIds = envelopes.map((e) => e.id);
    const empty = { persona: this.#persona, envelopeIds, modelId: this.#model.id } as const;

    if (envelopes.length === 0) return { ...empty, items: [] };

    const response = await this.#model.complete(this.buildRequest(envelopes));
    const parsed = parseExtractionResponse(response.text);
    if (!parsed.ok) {
      return { ...empty, items: [], rejection: { stage: 'response', rejection: parsed.rejection } };
    }

    const byId = new Map(envelopes.map((e) => [e.id, e]));
    const ctx: RoutingContext = {
      persona: this.#persona,
      createdAt: this.#now(),
      ...(this.#resolveParty ? { resolveParty: this.#resolveParty } : {}),
    };

    const items: ExtractedItem[] = [];
    for (const raw of parsed.value.results) {
      const envelope = byId.get(raw.envelope_id);
      if (envelope === undefined) {
        // A result attributed to an envelope that was not in the batch is not evidence of
        // anything. Discard the whole response rather than keep the rest.
        return {
          ...empty,
          items: [],
          rejection: {
            stage: 'attribution',
            detail: `result cites envelope ${raw.envelope_id}, which was not in the batch`,
          },
        };
      }
      const outcome = route(raw, ctx);
      if (!outcome.ok) {
        return { ...empty, items: [], rejection: { stage: 'routing', failure: outcome.failure } };
      }
      items.push({ raw, routed: outcome.routed, envelope });
    }

    return { ...empty, items };
  }
}
