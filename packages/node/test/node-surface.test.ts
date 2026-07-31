import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BriefOutput,
  CommitOutput,
  ConfirmOutput,
  ExpectOutput,
  NODE_TOOL_NAMES,
  OpenLoopsOutput,
} from '@servanda/types';
import { McpServer } from '../src/mcp/stdio.js';
import { callTool, TOOL_DEFINITIONS } from '../src/tools.js';
import { makeFixture, nodeAs, syncEdge, type Fixture } from './support/fixture.js';

let fx: Fixture;
beforeAll(() => {
  fx = makeFixture();
});
afterAll(() => fx.cleanup());

describe('§7 node surface: exactly six tools, exactly the spec’s shapes', () => {
  it('exposes precisely the six tools §8 requires for the conforming-node claim', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([...NODE_TOOL_NAMES].sort());
    expect(TOOL_DEFINITIONS).toHaveLength(6);
  });

  it('commit returns the §7 output shape', () => {
    const out = callTool(fx.node, 'commit', {
      intent: 'ship it',
      owed_to: fx.personas[1]!,
      due: null,
      propose: true,
    });
    expect(() => CommitOutput.parse(out)).not.toThrow();
    expect((out as { state: string }).state).toBe('proposed');
  });

  it('expect returns the §7 output shape and touches no wire', () => {
    const out = callTool(fx.node, 'expect', { expect: 'their draft', from: 'them' });
    expect(() => ExpectOutput.parse(out)).not.toThrow();
  });

  it('confirm returns the §7 output shape', () => {
    const edgeId = fx.node.commit({
      intent: 'confirmable',
      owed_to: fx.personas[1]!,
      due: null,
      persona: null,
      propose: true,
    }).edge_id!;
    syncEdge(fx, 0, 1, edgeId);
    const out = callTool(nodeAs(fx, 1), 'confirm', { id: edgeId, decision: 'confirm' });
    expect(() => ConfirmOutput.parse(out)).not.toThrow();
  });

  it('open_loops returns the §7 output shape for every view', () => {
    for (const view of ['owe', 'waiting', 'closed', 'all']) {
      const out = callTool(fx.node, 'open_loops', { view, limit: 10 });
      expect(() => OpenLoopsOutput.parse(out)).not.toThrow();
      expect((out as { items: unknown[] }).items.length).toBeLessThanOrEqual(10);
    }
  });

  it('brief returns the §7 output shape', () => {
    const out = callTool(fx.node, 'brief', { persona: null });
    expect(() => BriefOutput.parse(out)).not.toThrow();
  });

  it('rejects a tool that is not one of the five', () => {
    expect(() => callTool(fx.node, 'publish', {})).toThrow(/no such tool/);
  });
});

describe('§7 over MCP stdio', () => {
  it('initialises, lists the six tools, and calls them', () => {
    const server = new McpServer(fx.node);

    const init = server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect((init?.result as { serverInfo: { name: string } }).serverInfo.name).toBe('servanda-node');

    // A notification carries no id and MUST NOT be answered.
    expect(server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();

    const list = server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((list?.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort()).toEqual(
      [...NODE_TOOL_NAMES].sort(),
    );

    const call = server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'brief', arguments: { persona: null } },
    });
    const result = call?.result as { isError: boolean; structuredContent: unknown };
    expect(result.isError).toBe(false);
    expect(() => BriefOutput.parse(result.structuredContent)).not.toThrow();
  });

  it('reports a refused tool as an error result, not a transport failure', () => {
    const server = new McpServer(fx.node);
    const call = server.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'commit', arguments: { intent: 'theirs', owed_to: null, owner: 'x' } },
    });
    const result = call?.result as { isError: boolean; content: { text: string }[] };
    expect(call?.error).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/M-1/);
  });

  it('returns method-not-found for anything outside the contract', () => {
    const server = new McpServer(fx.node);
    const r = server.handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
    expect(r?.error?.code).toBe(-32601);
  });
});
