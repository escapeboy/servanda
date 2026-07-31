import type {
  BriefInput,
  BriefOutput,
  CommitInput,
  CommitOutput,
  ConfirmInput,
  ConfirmOutput,
  ExpectInput,
  ExpectOutput,
  OpenLoopsInput,
  OpenLoopsOutput,
} from '@servanda/types';

/**
 * The six §7 tools, and nothing else.
 *
 * Deliberately a narrow interface rather than an import of the node package: a client that
 * can only reach what §7 defines is a client that stays interchangeable, which is the whole
 * point of §7 ("clients are interchangeable above this contract"). It also means every
 * surface in this stream can be built and tested against a stand-in today and pointed at a
 * real one later with no change above this line.
 *
 * Method names are the tool names verbatim, `open_loops` included.
 */
export interface NodeClient {
  commit(input: CommitInput): Promise<CommitOutput>;
  expect(input: ExpectInput): Promise<ExpectOutput>;
  confirm(input: ConfirmInput): Promise<ConfirmOutput>;
  open_loops(input: OpenLoopsInput): Promise<OpenLoopsOutput>;
  brief(input: BriefInput): Promise<BriefOutput>;
}
