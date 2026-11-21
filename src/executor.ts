import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { newId, now } from './db.js';
import type { Checkpoint, Decider, Decision, DecisionClass, Task } from './types.js';
import { SYSTEM, TeamError, type Team } from './team.js';

export interface ExecutorCheckpoint { ref: string; kind: string; title: string; summary: string; payload: unknown; allowed: string[] }
export interface ExecutorState { status: string; terminal: boolean; ok: boolean; prUrl: string | null; url: string | null; checkpoints: ExecutorCheckpoint[] }
export interface CheckpointResponse { decision: string; comment?: string; answers?: Record<string, string>; edited?: { prompt?: string; planMd?: string; title?: string } }

/** Whatever actually does the coding work. sdlc today; the team layer only knows this interface. */
export interface Executor {
  start(input: { repoPath: string; title: string; prompt: string; pipeline?: string | null }): Promise<{ ref: string }>;
  state(ref: string): Promise<ExecutorState>;
  answer(checkpointRef: string, response: CheckpointResponse): Promise<void>;
}

interface SdlcTask { id: string; status: string; prUrl: string | null }
interface SdlcHil { id: string; kind: string; title: string; summary: string; payload: unknown; allowedDecisions: string[]; status: string }

export class SdlcExecutor implements Executor {
  constructor(private base: string, private token: string) {}

  /** Reads the address and the token of the local sdlc server from its config. */
  static fromLocalConfig(home = process.env.SDLC_HOME ?? path.join(os.homedir(), '.sdlc')): SdlcExecutor {
    const file = path.join(home, 'config.yaml');
    if (!fs.existsSync(file)) throw new Error(`sdlc config not found: ${file}`);
    const cfg = YAML.parse(fs.readFileSync(file, 'utf8')) as { server?: { host?: string; port?: number; token?: string } };
    const host = !cfg.server?.host || cfg.server.host === '0.0.0.0' ? '127.0.0.1' : cfg.server.host;
    if (!cfg.server?.token) throw new Error('sdlc config has no server token yet: start sdlc once');
    return new SdlcExecutor(process.env.SDLC_SERVER ?? `http://${host}:${cfg.server.port ?? 7337}`, cfg.server.token);
  }

  private async call<T>(method: string, p: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.base}/api${p}`, { method, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const j = await r.json().catch(() => ({})) as { error?: string };
    if (!r.ok) throw new Error(`sdlc ${method} ${p}: ${j.error ?? r.status}`);
    return j as T;
  }

  async start(input: { repoPath: string; title: string; prompt: string; pipeline?: string | null }) {
    const t = await this.call<SdlcTask>('POST', '/tasks', { repoPath: input.repoPath, prompt: input.prompt, title: input.title, pipeline: input.pipeline ?? undefined });
    return { ref: t.id };
  }

  async state(ref: string): Promise<ExecutorState> {
    const r = await this.call<{ task: SdlcTask; openHil: SdlcHil[] }>('GET', `/tasks/${ref}`);
    const s = r.task.status;
    const ok = ['pr_open', 'succeeded', 'merged'].includes(s);
    const terminal = ok || ['failed', 'aborted', 'closed'].includes(s);
    return { status: s, terminal, ok, prUrl: r.task.prUrl, url: `${this.base}/tasks/${ref}`, checkpoints: r.openHil.map((h) => ({ ref: h.id, kind: h.kind, title: h.title, summary: h.summary, payload: h.payload, allowed: h.allowedDecisions })) };
  }

  async answer(checkpointRef: string, response: CheckpointResponse) { await this.call('POST', `/hil/${checkpointRef}/respond`, response); }
}

const DECISION_LABELS: Record<string, string> = {
  approve: 'Одобрить', request_changes: 'Вернуть на доработку', abort: 'Прервать задачу', answer: 'Ответить',
  retry: 'Повторить фазу', resume: 'Продолжить', skip: 'Пропустить', allow: 'Разрешить', allow_session: 'Разрешить на сессию', deny: 'Запретить',
};

export interface AnswerProposal extends CheckpointResponse {
  rationale: string; confidence: number; klass: DecisionClass; reversible: boolean; importance: 'low' | 'medium' | 'high';
  proposedPivotal: boolean; proposedDecider: Decider;
}

/** Keeps team tasks in step with the executor and turns its checkpoints into decisions of the team. */
export class ExecutorSync {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private team: Team, public executors: Record<string, Executor>) {}

  private forProject(projectId: string): Executor {
    const p = this.team.project(projectId); const e = this.executors[p.executor];
    if (!e) throw new TeamError(`исполнитель «${p.executor}» не подключён`);
    return e;
  }
  checkpoint(id: string): Checkpoint { const c = this.team.db.get<Checkpoint>('checkpoints', id); if (!c) throw new TeamError(`чекпоинт ${id} не найден`, 404); return c; }
  checkpoints(projectId?: string, status?: string): Checkpoint[] {
    const where: string[] = []; const params: string[] = [];
    if (projectId) { where.push('project_id = ?'); params.push(projectId); }
    if (status) { where.push('status = ?'); params.push(status); }
    return this.team.db.all<Checkpoint>('checkpoints', `${where.join(' AND ') || '1=1'} ORDER BY created_at DESC`, ...params);
  }

  /** Hand a task to the executor. Only after the intake check has passed. */
  async start(taskId: string, agentId: string, prompt: string, pipeline?: string | null): Promise<Task> {
    const { team } = this; const t = team.task(taskId); const p = team.project(t.projectId);
    if (!t.intake?.ready) throw new TeamError('сначала входной контроль: вызови task_intake и закрой пробелы, потом запускай исполнителя');
    if (t.executorRef) throw new TeamError(`задача уже у исполнителя (${t.executorRef})`);
    if (!team.isReady(t) && t.status !== 'in_progress') throw new TeamError('задача заблокирована зависимостями или уже не открыта');
    if (!p.repoPath) throw new TeamError('у проекта не задан репозиторий');
    const { ref } = await this.forProject(p.id).start({ repoPath: p.repoPath, title: t.title, prompt, pipeline: pipeline ?? p.pipeline });
    team.db.update('tasks', t.id, { executorRef: ref, executorStatus: 'created', updatedAt: now() });
    team.emit({ type: 'executor.started', projectId: p.id, actor: { kind: 'agent', id: agentId }, taskId: t.id, summary: `«${t.title}» передана исполнителю (${p.executor}: ${ref})`, payload: { ref, pipeline: pipeline ?? p.pipeline } });
    team.setTaskStatus(t.id, 'in_progress', { kind: 'agent', id: agentId });
    return team.task(t.id);
  }

  /** One pass: statuses, new checkpoints, finished work. */
  async sync(): Promise<void> {
    if (this.busy) return; this.busy = true;
    try {
      const { team } = this;
      for (const t of team.db.all<Task>('tasks', "executor_ref IS NOT NULL AND status = 'in_progress'")) {
        if (team.project(t.projectId).status !== 'active') continue;
        let st: ExecutorState;
        try { st = await this.forProject(t.projectId).state(t.executorRef!); }
        catch (e) { team.emit({ type: 'executor.error', projectId: t.projectId, actor: SYSTEM, taskId: t.id, summary: `Исполнитель не отвечает: ${e instanceof Error ? e.message : String(e)}` }); continue; }
        if (st.status !== t.executorStatus || (st.prUrl && st.prUrl !== t.prUrl)) {
          team.db.update('tasks', t.id, { executorStatus: st.status, prUrl: st.prUrl ?? t.prUrl, updatedAt: now() });
          team.emit({ type: 'executor.status', projectId: t.projectId, actor: SYSTEM, taskId: t.id, summary: `Исполнитель: «${t.title}» — ${st.status}`, payload: { status: st.status, prUrl: st.prUrl, url: st.url } });
        }
        const open = new Set(st.checkpoints.map((c) => c.ref));
        for (const c of st.checkpoints) {
          if (team.db.one<Checkpoint>('checkpoints', 'executor_ref = ?', c.ref)) continue;
          const cp: Checkpoint = { id: newId('c'), projectId: t.projectId, taskId: t.id, executorRef: c.ref, kind: c.kind, title: c.title, summary: c.summary, payload: c.payload, allowed: c.allowed, status: 'open', decisionId: null, response: null, createdAt: now() };
          team.db.insert('checkpoints', cp);
          team.emit({ type: 'checkpoint.opened', projectId: t.projectId, actor: SYSTEM, taskId: t.id, summary: `Чекпоинт исполнителя: ${c.title}`, payload: { checkpointId: cp.id, kind: c.kind } });
          const lead = team.lead(t.projectId) ?? (t.assigneeId ? team.agent(t.assigneeId) : undefined);
          if (lead) team.wake(lead.id, 'checkpoint', { checkpointId: cp.id }, `cp:${cp.id}`);
        }
        // answered from outside (the owner in the executor's own UI): our pending decision is moot
        for (const cp of team.db.all<Checkpoint>('checkpoints', "task_id = ? AND status IN ('open','proposed')", t.id)) {
          if (open.has(cp.executorRef)) continue;
          team.db.update('checkpoints', cp.id, { status: 'gone' });
          if (cp.decisionId) { const d = team.decisions.get(cp.decisionId); if (d.status !== 'resolved' && d.status !== 'cancelled') team.decisions.cancel(d.id, SYSTEM, 'чекпоинт закрыт вне команды'); }
          team.emit({ type: 'checkpoint.gone', projectId: t.projectId, actor: SYSTEM, taskId: t.id, summary: `Чекпоинт «${cp.title}» закрыт вне команды`, payload: { checkpointId: cp.id } });
        }
        if (st.terminal) {
          if (st.ok) { team.setTaskStatus(t.id, 'verify', SYSTEM, `исполнитель: ${st.status}`); if (t.assigneeId) team.wake(t.assigneeId, 'executor_finished', { taskId: t.id, prUrl: st.prUrl, status: st.status }, `fin:${t.id}`); }
          else { team.setTaskStatus(t.id, 'blocked', SYSTEM, `исполнитель: ${st.status}`); if (t.assigneeId) team.wake(t.assigneeId, 'executor_failed', { taskId: t.id, status: st.status }, `fail:${t.id}`); }
        }
      }
      team.decisions.escalateStale();
    } finally { this.busy = false; }
  }

  /** The tech lead's answer to a checkpoint is itself a decision candidate and goes through the decision cycle. */
  proposeAnswer(checkpointId: string, agentId: string, a: AnswerProposal): Decision {
    const { team } = this; const cp = this.checkpoint(checkpointId);
    if (cp.status !== 'open') throw new TeamError(`чекпоинт уже ${cp.status}`);
    if (!cp.allowed.includes(a.decision)) throw new TeamError(`decision должен быть одним из: ${cp.allowed.join(', ')}`);
    const t = team.task(cp.taskId);
    const response: CheckpointResponse = { decision: a.decision, comment: a.comment, answers: a.answers, edited: a.edited };
    const d = team.decisions.propose({
      projectId: cp.projectId, taskId: cp.taskId, agentId, title: `Чекпоинт «${cp.title}» по задаче «${t.title}»`,
      context: [cp.summary, a.comment ? `Комментарий к ответу: ${a.comment}` : '', a.answers ? `Ответы: ${JSON.stringify(a.answers)}` : ''].filter(Boolean).join('\n').slice(0, 4000),
      options: cp.allowed.map((k) => ({ key: k, label: DECISION_LABELS[k] ?? k })), recommendation: a.decision, rationale: a.rationale,
      klass: a.klass, reversible: a.reversible, importance: a.importance, confidence: a.confidence, proposedPivotal: a.proposedPivotal, proposedDecider: a.proposedDecider,
      source: 'checkpoint', sourceRef: cp.id,
    });
    // propose() may already have resolved it (autonomy) and answered the executor
    if (this.checkpoint(cp.id).status === 'open') team.db.update('checkpoints', cp.id, { status: 'proposed', decisionId: d.id, response });
    else team.db.update('checkpoints', cp.id, { decisionId: d.id });
    return team.decisions.get(d.id);
  }

  async answerFromDecision(d: Decision): Promise<void> {
    const { team } = this;
    const cp = d.sourceRef ? team.db.get<Checkpoint>('checkpoints', d.sourceRef) : undefined;
    if (!cp || cp.status === 'answered' || cp.status === 'gone' || !d.chosen) return;
    const draft = (cp.response ?? {}) as CheckpointResponse;
    // the prepared details belong to the recommended answer only; another choice goes with the decider's comment
    const asRecommended = d.chosen === d.recommendation;
    const response: CheckpointResponse = asRecommended
      ? { ...draft, decision: d.chosen, comment: [draft.comment, d.chosenComment && d.resolvedBy !== `agent:${d.agentId}` ? d.chosenComment : ''].filter(Boolean).join('\n\n') || undefined }
      : { decision: d.chosen, comment: d.chosenComment ?? undefined };
    team.db.update('checkpoints', cp.id, { status: 'answered', response });
    try { await this.forProject(cp.projectId).answer(cp.executorRef, response); }
    catch (e) { team.db.update('checkpoints', cp.id, { status: 'proposed' }); throw e; }
    team.emit({ type: 'checkpoint.answered', projectId: cp.projectId, actor: SYSTEM, taskId: cp.taskId, decisionId: d.id, summary: `Исполнителю отвечено: ${DECISION_LABELS[d.chosen] ?? d.chosen} («${cp.title}»)`, payload: { checkpointId: cp.id, response } });
  }

  startTicker(ms = 5000) { if (!this.timer) { this.timer = setInterval(() => { void this.sync().catch(() => {}); }, ms); this.timer.unref(); } }
  stopTicker() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
