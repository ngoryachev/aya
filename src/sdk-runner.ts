import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { callTool } from './tools.js';
import type { AgentRunner, RunResult, RunSpec } from './runtime.js';

const BLOCKED = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'AskUserQuestion', 'TodoWrite'];

/** The agent's own process must not look like a nested Claude Code session. */
function cleanEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) { if (k === 'CLAUDECODE' || k === 'CLAUDE_CODE_ENTRYPOINT' || k.startsWith('AYA_')) continue; out[k] = v; }
  return out;
}

const userMessage = (text: string): SDKUserMessage => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage);

/** Runs an agent's turn as a Claude session with the team tools as an in-process MCP server and read-only file tools. */
export class SdkRunner implements AgentRunner {
  constructor(private opts: { maxTurns?: number } = {}) {}

  async run(spec: RunSpec): Promise<RunResult> {
    const server = createSdkMcpServer({
      name: 'team', version: '1.0.0',
      tools: spec.tools.map((t) => tool(t.name, t.description, t.schema, async (args: unknown) => {
        const r = await callTool(t, spec.ctx, args);
        return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError };
      })),
    });
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    spec.signal.addEventListener('abort', onAbort);
    // streaming input keeps the session open for the in-process tools; it is closed once the result arrives
    let finish!: () => void; const finished = new Promise<void>((r) => { finish = r; });
    async function* input(): AsyncGenerator<SDKUserMessage> { yield userMessage(spec.prompt); await finished; }

    const result: RunResult = { sessionId: spec.resume, costUsd: 0, turns: 0, text: '' };
    try {
      const q = query({
        prompt: input(),
        options: {
          cwd: spec.cwd, systemPrompt: spec.systemPrompt, model: spec.model ?? undefined, resume: spec.resume ?? undefined,
          mcpServers: { team: server }, allowedTools: [...spec.tools.map((t) => `mcp__team__${t.name}`), 'Read', 'Glob', 'Grep'], disallowedTools: BLOCKED,
          permissionMode: 'dontAsk', maxTurns: this.opts.maxTurns ?? 40, settingSources: [], abortController, env: cleanEnv(),
        },
      });
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init') result.sessionId = m.session_id;
        if (m.type === 'assistant') { for (const b of m.message.content) if (b.type === 'text' && b.text.trim()) spec.onProgress?.(b.text); }
        if (m.type === 'result') {
          result.sessionId = m.session_id || result.sessionId; result.costUsd = m.total_cost_usd ?? 0; result.turns = m.num_turns ?? 0;
          if (m.subtype === 'success') result.text = m.result ?? '';
          else result.error = `${m.subtype}${'errors' in m && Array.isArray(m.errors) && m.errors.length ? `: ${m.errors.join('; ')}` : ''}`;
          finish();
          break;
        }
      }
    } catch (e) {
      if (!result.text && !result.error) result.error = e instanceof Error ? e.message : String(e);
    } finally { finish(); spec.signal.removeEventListener('abort', onAbort); }
    return result;
  }

  async brief(system: string, prompt: string): Promise<string> {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 60_000);
    try {
      const q = query({ prompt, options: { systemPrompt: system, maxTurns: 1, permissionMode: 'dontAsk', disallowedTools: [...BLOCKED, 'Read', 'Glob', 'Grep'], settingSources: [], abortController, env: cleanEnv() } });
      for await (const m of q) if (m.type === 'result') return m.subtype === 'success' ? m.result : '';
      return '';
    } finally { clearTimeout(timer); }
  }
}
