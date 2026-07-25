import { z } from 'zod';

/**
 * §3.4: "Extraction MUST ... emit only objects valid against §3.1 or nothing."
 *
 * The model never emits a §3.1 Commitment directly, and that is the point. A commitment's
 * `owner` is a *key* (§3.1); if the model could write that field it could name any owner it
 * liked, and M-1 ("a promise is owned by its giver") would rest on the model behaving. Instead
 * the model emits the shape below — which can only ever *refer* to a party as `local_user` or
 * `other_party` — and this package resolves those references to keys itself. A fooled model
 * cannot forge an owner because it has no way to spell one.
 *
 * Everything the model returns is validated against `ExtractionResponse` before it is looked at.
 */

export const PartyRef = z.enum(['local_user', 'other_party']);
export type PartyRef = z.infer<typeof PartyRef>;

export const OwedToRef = z.enum(['local_user', 'other_party', 'none']);
export type OwedToRef = z.infer<typeof OwedToRef>;

export const RawExtraction = z
  .object({
    /** Which envelope this came from; must match one that was actually in the batch. */
    envelope_id: z.string().min(1),
    /** §3.1 intent: human-readable, ≤ 500 chars. */
    intent: z.string().min(1).max(500),
    owner: PartyRef,
    /** Non-null exactly when `owner === 'other_party'`. */
    owner_label: z.string().min(1).max(200).nullable(),
    owed_to: OwedToRef,
    /** Non-null exactly when `owed_to === 'other_party'`. */
    owed_to_label: z.string().min(1).max(200).nullable(),
    /** RFC 3339, or null (§3.1: null is valid and expected to be the majority). */
    due: z.string().nullable(),
    confidence: z.number().min(0).max(1),
    /** Verbatim span from the envelope payload, so a human can judge the extraction. */
    quote: z.string().min(1).max(2000),
  })
  .strict()
  .refine((r) => (r.owner === 'other_party') === (r.owner_label !== null), {
    message: 'owner_label must be present exactly when owner is other_party',
  })
  .refine((r) => (r.owed_to === 'other_party') === (r.owed_to_label !== null), {
    message: 'owed_to_label must be present exactly when owed_to is other_party',
  });
export type RawExtraction = z.infer<typeof RawExtraction>;

export const ExtractionResponse = z.object({ results: z.array(RawExtraction) }).strict();
export type ExtractionResponse = z.infer<typeof ExtractionResponse>;

/**
 * The same contract as a JSON Schema, for `output_config.format`. Structured outputs constrain
 * the response; the zod pass above still runs on everything that comes back — a constraint the
 * service applies is not a constraint this node has verified.
 *
 * Kept to the documented supported subset: no numeric or string length constraints, every object
 * closed with `additionalProperties: false`, nullability via `anyOf`.
 */
export const EXTRACTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'envelope_id',
          'intent',
          'owner',
          'owner_label',
          'owed_to',
          'owed_to_label',
          'due',
          'confidence',
          'quote',
        ],
        properties: {
          envelope_id: { type: 'string' },
          intent: { type: 'string' },
          owner: { type: 'string', enum: ['local_user', 'other_party'] },
          owner_label: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          owed_to: { type: 'string', enum: ['local_user', 'other_party', 'none'] },
          owed_to_label: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          due: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          confidence: { type: 'number' },
          quote: { type: 'string' },
        },
      },
    },
  },
};

export type ResponseRejection =
  | { readonly reason: 'not-json'; readonly detail: string }
  | { readonly reason: 'schema-invalid'; readonly detail: string };

export type ParsedResponse =
  | { readonly ok: true; readonly value: ExtractionResponse }
  | { readonly ok: false; readonly rejection: ResponseRejection };

/**
 * Parse a model response into validated results, or into nothing.
 *
 * Deliberately all-or-nothing. §3.4 admits "objects valid against §3.1 **or nothing**"; a
 * response carrying one well-formed result and one malformed one is a response this node cannot
 * account for, so it yields zero. Salvaging the good half would be exactly the "partial guess"
 * §3.4 forbids. (Narrowest reading — the spec does not say what to do with a mixed batch.)
 */
export function parseExtractionResponse(text: string): ParsedResponse {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      rejection: { reason: 'not-json', detail: err instanceof Error ? err.message : String(err) },
    };
  }
  const result = ExtractionResponse.safeParse(json);
  if (!result.success) {
    return { ok: false, rejection: { reason: 'schema-invalid', detail: result.error.message } };
  }
  return { ok: true, value: result.data };
}
