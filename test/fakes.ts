import { Db } from '../src/db.js';
import { Team } from '../src/team.js';
import { Runtime, type AgentRunner, type RunResult, type RunSpec } from '../src/runtime.js';
import { callTool } from '../src/tools.js';
import type { CheckpointResponse, Executor, ExecutorCheckpoint, ExecutorState } from '../src/executor.js';
import type { Wakeup } from '../src/types.js';
import { ensureBasics } from '../src/seed.js';

/** An executor whose tasks stop at scripted checkpoints and finish when those are answered. */
export class FakeExecutor implements Executor {
  tasks = new Map<string, { prompt: string; title: string; status: string; prUrl: string | null; pending: ExecutorCheckpoint[]; answers: { ref: string; response: CheckpointResponse }[] }>();
  /** Checkpoints every new task goes through, in order. */
  plan: Omit<ExecutorCheckpoint, 'ref'>[] = [{ kind: 'approve_plan', title: 'Утвердить план', summary: 'План готов', payload: { planMd: '1. сделать' }, allowed: ['approve', 'request_changes', 'abort'] }];
  private n = 0;
  async start(input: { repoPath: string; title: string; prompt: string }) {
    const ref = `x${++this.n}`;
    this.tasks.set(ref, { prompt: input.prompt, title: input.title, status: this.plan.length ? 'waiting_hil' : 'pr_open', prUrl: this.plan.length ? null : `https://example.test/pr/${this.n}`, pending: this.plan.map((c, i) => ({ ...c, ref: `${ref}-h${i}` })), answers: [] });
    return { ref };
  }
  async state(ref: string): Promise<ExecutorState> {
    const t = this.tasks.get(ref)!;
    const ok = t.status === 'pr_open'; const terminal = ok || t.status === 'failed' || t.status === 'aborted';
    return { status: t.status, terminal, ok, prUrl: t.prUrl, url: null, checkpoints: t.pending.slice(0, 1) };
  }
  async answer(checkpointRef: string, response: CheckpointResponse) {
    for (const [ref, t] of this.tasks) {
      if (t.pending[0]?.ref !== checkpointRef) continue;
      t.answers.push({ ref: checkpointRef, response });
      if (response.decision === 'abort') { t.status = 'aborted'; t.pending = []; return; }
      if (response.decision === 'request_changes') return;   // the same checkpoint comes back
      t.pending.shift();
      if (!t.pending.length) { t.status = 'pr_open'; t.prUrl = `https://example.test/pr/${ref}`; }
      return;
    }
    throw new Error(`unknown checkpoint ${checkpointRef}`);
  }
}

export type Call = (tool: string, args?: Record<string, unknown>) => Promise<any>;
export type Script = (w: Wakeup, call: Call, spec: RunSpec) => Promise<void> | void;

/** Plays agents by role: for every wakeup the role's script calls tools the way a model would. */
export class ScriptRunner implements AgentRunner {
  scripts: Record<string, Script> = {};
  log: { alias: string; tool: string; args: unknown; result: any; isError: boolean }[] = [];
  briefReply = 'Вариант A. Так проще.';
  async run(spec: RunSpec): Promise<RunResult> {
    const call: Call = async (name, args = {}) => {
      const tool = spec.tools.find((t) => t.name === name);
      if (!tool) throw new Error(`role ${spec.role.name} has no tool ${name}`);
      const r = await callTool(tool, spec.ctx, args);
      let result: any = r.text; try { result = JSON.parse(r.text); } catch { /* plain text */ }
      this.log.push({ alias: spec.agent.alias, tool: name, args, result, isError: r.isError });
      return result;
    };
    const script = this.scripts[spec.role.name];
    for (const w of spec.wakeups) if (script) await script(w, call, spec);
    return { sessionId: `s-${spec.agent.id}`, costUsd: 0.01, turns: 1, text: `ход: ${spec.wakeups.map((w) => w.reason).join(', ')}` };
  }
  async brief() { return this.briefReply; }
  calls(tool: string) { return this.log.filter((l) => l.tool === tool); }
}

export function makeTeam() {
  const db = new Db(':memory:');
  const executor = new FakeExecutor();
  const team = new Team({ db, executors: { fake: executor }, random: () => 0.99 });
  ensureBasics(team);
  const runner = new ScriptRunner();
  const runtime = new Runtime(team, runner, { maxRunsPerHour: 1000 });
  return { db, team, executor, runner, runtime };
}
