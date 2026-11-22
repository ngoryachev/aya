import { Db, newId, now } from './db.js';
import type { Agent, Persona, Project, Role, Task, TaskStatus, TeamEvent, Wakeup, IntakeGap } from './types.js';
import { Decisions } from './decisions.js';
import { Gateway } from './gateway.js';
import { ExecutorSync, type Executor } from './executor.js';

export class TeamError extends Error { constructor(message: string, public status = 400) { super(message); } }

export interface Actor { kind: 'agent' | 'owner' | 'persona' | 'system'; id?: string | null }
export const OWNER: Actor = { kind: 'owner' };
export const SYSTEM: Actor = { kind: 'system' };

type EventInput = { type: string; projectId?: string | null; actor: Actor; taskId?: string | null; decisionId?: string | null; summary: string; payload?: Record<string, unknown> };

export interface TeamOptions {
  db: Db;
  executors?: Record<string, Executor>;
  /** Share of fully autonomous (level 3) decisions flagged for a spot check, 0..1. */
  auditRate?: number;
  random?: () => number;
}

/**
 * The team layer: the single place that changes state. Agents reach it through tools, the owner through HTTP,
 * the outside world through the gateway. Every change is written to the event log.
 */
export class Team {
  readonly db: Db;
  readonly decisions: Decisions;
  readonly gateway: Gateway;
  readonly exec: ExecutorSync;
  readonly auditRate: number;
  readonly random: () => number;
  private listeners = new Set<(e: TeamEvent) => void>();
  private wakeListeners = new Set<(w: Wakeup) => void>();

  constructor(opts: TeamOptions) {
    this.db = opts.db;
    this.auditRate = opts.auditRate ?? 0.2;
    this.random = opts.random ?? Math.random;
    this.decisions = new Decisions(this);
    this.gateway = new Gateway(this);
    this.exec = new ExecutorSync(this, opts.executors ?? {});
  }

  // ------------------------------------------------------------------ events
  emit(e: EventInput): TeamEvent {
    const ts = now();
    const r = this.db.run(
      'INSERT INTO events (ts, project_id, type, actor_kind, actor_id, task_id, decision_id, summary, payload) VALUES (?,?,?,?,?,?,?,?,?)',
      ts, e.projectId ?? null, e.type, e.actor.kind, e.actor.id ?? null, e.taskId ?? null, e.decisionId ?? null, e.summary, JSON.stringify(e.payload ?? {}),
    );
    const ev: TeamEvent = { id: Number(r.lastInsertRowid), ts, projectId: e.projectId ?? null, type: e.type, actorKind: e.actor.kind, actorId: e.actor.id ?? null, taskId: e.taskId ?? null, decisionId: e.decisionId ?? null, summary: e.summary, payload: e.payload ?? {} };
    for (const l of this.listeners) { try { l(ev); } catch { /* a broken listener must not break the change */ } }
    return ev;
  }
  onEvent(l: (e: TeamEvent) => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
  events(opts: { since?: number; projectId?: string; limit?: number; taskId?: string; decisionId?: string } = {}): TeamEvent[] {
    const where: string[] = ['id > ?']; const params: (string | number)[] = [opts.since ?? 0];
    if (opts.projectId) { where.push('project_id = ?'); params.push(opts.projectId); }
    if (opts.taskId) { where.push('task_id = ?'); params.push(opts.taskId); }
    if (opts.decisionId) { where.push('decision_id = ?'); params.push(opts.decisionId); }
    const rows = this.db.all<TeamEvent>('events', `${where.join(' AND ')} ORDER BY id DESC LIMIT ${Math.min(opts.limit ?? 200, 2000)}`, ...params);
    return rows.reverse();
  }

  // ------------------------------------------------------------------ lookups
  project(id: string): Project { const p = this.db.get<Project>('projects', id); if (!p) throw new TeamError(`проект ${id} не найден`, 404); return p; }
  agent(id: string): Agent { const a = this.db.get<Agent>('agents', id); if (!a) throw new TeamError(`агент ${id} не найден`, 404); return a; }
  role(id: string): Role { const r = this.db.get<Role>('roles', id); if (!r) throw new TeamError(`роль ${id} не найдена`, 404); return r; }
  persona(id: string): Persona { const p = this.db.get<Persona>('personas', id); if (!p) throw new TeamError(`персона ${id} не найдена`, 404); return p; }
  task(id: string): Task { const t = this.db.get<Task>('tasks', id); if (!t) throw new TeamError(`задача ${id} не найдена`, 404); return t; }
  agents(projectId: string): Agent[] { return this.db.all<Agent>('agents', 'project_id = ? ORDER BY created_at', projectId); }
  personas(): Persona[] { return this.db.all<Persona>('personas', '1=1 ORDER BY is_owner DESC, name'); }
  owner(): Persona | undefined { return this.db.one<Persona>('personas', 'is_owner = 1'); }
  agentByAlias(projectId: string, alias: string): Agent {
    const a = this.agents(projectId).find((x) => x.alias.toLowerCase() === alias.trim().toLowerCase() || x.id === alias);
    if (!a) throw new TeamError(`агент «${alias}» не найден в команде. Список: ${this.agents(projectId).map((x) => x.alias).join(', ')}`);
    return a;
  }
  personaByName(name: string): Persona {
    const n = name.trim().toLowerCase();
    const p = this.personas().find((x) => x.id === name || x.name.toLowerCase() === n || x.name.toLowerCase().includes(n));
    if (!p) throw new TeamError(`персона «${name}» не найдена. Список: ${this.personas().map((x) => x.name).join(', ')}`);
    return p;
  }
  agentsByRole(projectId: string, roleName: string): Agent[] {
    const role = this.db.one<Role>('roles', 'name = ?', roleName);
    return role ? this.agents(projectId).filter((a) => a.roleId === role.id) : [];
  }
  lead(projectId: string): Agent | undefined { return this.agentsByRole(projectId, 'techlead')[0]; }
  pm(projectId: string): Agent | undefined { return this.agentsByRole(projectId, 'pm')[0]; }
  actorName(a: Actor): string {
    if (a.kind === 'owner') return 'владелец';
    if (a.kind === 'system') return 'система';
    if (a.kind === 'agent' && a.id) return this.db.get<Agent>('agents', a.id)?.alias ?? a.id;
    if (a.kind === 'persona' && a.id) return this.db.get<Persona>('personas', a.id)?.name ?? a.id;
    return a.kind;
  }

  // ------------------------------------------------------------------ wakeups (an agent's inbox)
  onWake(l: (w: Wakeup) => void) { this.wakeListeners.add(l); return () => this.wakeListeners.delete(l); }
  /** Queue work for an agent. `dedupeKey` collapses repeated notifications of the same kind while one is still queued. */
  wake(agentId: string, reason: string, payload: Record<string, unknown> = {}, dedupeKey?: string): Wakeup | null {
    if (dedupeKey) {
      const dup = this.db.all<Wakeup>('wakeups', "agent_id = ? AND reason = ? AND status = 'queued'", agentId, reason).find((w) => w.payload.dedupeKey === dedupeKey);
      if (dup) return null;
      payload = { ...payload, dedupeKey };
    }
    const w: Wakeup = { id: newId('w'), agentId, reason, payload, status: 'queued', error: null, createdAt: now(), startedAt: null, endedAt: null };
    this.db.insert('wakeups', w);
    for (const l of this.wakeListeners) { try { l(w); } catch { /* ignore */ } }
    return w;
  }

  // ------------------------------------------------------------------ tasks
  deps(taskId: string): string[] { return this.db.query<{ depends_on: string }>('SELECT depends_on FROM task_deps WHERE task_id = ?', taskId).map((r) => r.depends_on); }
  dependents(taskId: string): string[] { return this.db.query<{ task_id: string }>('SELECT task_id FROM task_deps WHERE depends_on = ?', taskId).map((r) => r.task_id); }
  tasks(projectId: string): Task[] { return this.db.all<Task>('tasks', 'project_id = ? ORDER BY priority DESC, created_at', projectId); }
  /** A task can be worked on when everything it depends on is finished (or no longer relevant). */
  isReady(t: Task): boolean {
    if (t.status !== 'open') return false;
    const ok = this.deps(t.id).every((d) => { const s = this.db.get<Task>('tasks', d)?.status; return s === 'done' || s === 'verify' || s === 'obsolete' || s === 'cancelled' || s === undefined; });
    return ok && this.stackBase(t) !== undefined;
  }

  /**
   * Stacked work: a task whose dependency is finished by the executor but not merged yet starts from that dependency's
   * branch instead of waiting for a human to merge. A branch has one base, so with several such dependencies one of
   * them must already contain the others (they form a chain). Returns the task to start from, null when the main
   * branch will do, undefined when the dependencies do not form a chain yet and the task has to wait.
   */
  stackBase(t: Task): Task | null | undefined {
    const pending = this.deps(t.id).map((d) => this.db.get<Task>('tasks', d)).filter((d): d is Task => !!d && d.status === 'verify');
    if (!pending.length) return null;
    const chain = (x: Task) => { const ids = new Set<string>(); for (let cur: Task | undefined = x, i = 0; cur && i < 50; i++) { ids.add(cur.id); cur = cur.baseTaskId ? this.db.get<Task>('tasks', cur.baseTaskId) : undefined; } return ids; };
    return pending.find((top) => { const ids = chain(top); return pending.every((p) => ids.has(p.id)); });
  }

  createTask(input: { projectId: string; title: string; description?: string; parentId?: string | null; dependsOn?: string[]; assigneeId?: string | null; externalKey?: string | null; externalUrl?: string | null; priority?: number }, by: Actor): Task {
    const p = this.project(input.projectId);
    if (input.parentId) this.task(input.parentId);
    for (const d of input.dependsOn ?? []) this.task(d);
    const t: Task = {
      id: newId('t'), projectId: p.id, parentId: input.parentId ?? null, title: input.title.trim(), description: input.description ?? '',
      status: 'open', assigneeId: null, createdBy: by.kind === 'agent' ? by.id! : by.kind, priority: input.priority ?? 0,
      externalKey: input.externalKey ?? null, externalUrl: input.externalUrl ?? null, intake: null, executorRef: null, executorStatus: null, prUrl: null,
      obsoleteReason: null, packageId: null, takenOver: false, branch: null, baseTaskId: null, staleBase: false, merged: false, createdAt: now(), updatedAt: now(),
    };
    if (!t.title) throw new TeamError('у задачи должен быть заголовок');
    this.db.insert('tasks', t);
    for (const d of input.dependsOn ?? []) this.db.run('INSERT OR IGNORE INTO task_deps (task_id, depends_on) VALUES (?, ?)', t.id, d);
    this.emit({ type: 'task.created', projectId: p.id, actor: by, taskId: t.id, summary: `Задача «${t.title}»`, payload: { dependsOn: input.dependsOn ?? [], externalKey: t.externalKey } });
    if (input.assigneeId) this.assignTask(t.id, input.assigneeId, by);
    else this.notifyUnassigned(p.id);
    return this.task(t.id);
  }

  private notifyUnassigned(projectId: string) {
    const lead = this.lead(projectId);
    if (lead && this.tasks(projectId).some((t) => !t.assigneeId && !t.takenOver && this.isReady(t))) this.wake(lead.id, 'tasks_to_assign', {}, 'assign');
  }

  assignTask(taskId: string, agentId: string, by: Actor): Task {
    const t = this.task(taskId); const a = this.agent(agentId);
    if (a.projectId !== t.projectId) throw new TeamError('агент из другого проекта');
    this.db.update('tasks', t.id, { assigneeId: a.id, takenOver: false, updatedAt: now() });
    this.emit({ type: 'task.assigned', projectId: t.projectId, actor: by, taskId: t.id, summary: `«${t.title}» → ${a.alias}`, payload: { agentId: a.id } });
    if (this.isReady(this.task(t.id))) this.wake(a.id, 'task_assigned', { taskId: t.id }, `task:${t.id}`);
    return this.task(t.id);
  }

  updateTask(taskId: string, patch: { title?: string; description?: string; priority?: number; externalKey?: string | null; externalUrl?: string | null; prUrl?: string | null }, by: Actor): Task {
    const t = this.task(taskId);
    this.db.update('tasks', t.id, { ...patch, updatedAt: now() });
    this.emit({ type: 'task.updated', projectId: t.projectId, actor: by, taskId: t.id, summary: `«${t.title}»: ${Object.keys(patch).join(', ')}`, payload: patch });
    return this.task(t.id);
  }

  setTaskStatus(taskId: string, status: TaskStatus, by: Actor, note?: string): Task {
    const t = this.task(taskId);
    if (t.status === status) return t;
    this.db.update('tasks', t.id, { status, updatedAt: now() });
    this.emit({ type: 'task.status', projectId: t.projectId, actor: by, taskId: t.id, summary: `«${t.title}»: ${t.status} → ${status}${note ? ` (${note})` : ''}`, payload: { from: t.status, to: status, note } });
    if (status === 'done' || status === 'verify' || status === 'obsolete' || status === 'cancelled') {
      // dependents may have become workable: tell their assignees, and the lead about the unassigned ones
      for (const id of this.dependents(t.id)) {
        const d = this.task(id);
        if (this.isReady(d) && d.assigneeId) this.wake(d.assigneeId, 'task_assigned', { taskId: d.id }, `task:${d.id}`);
      }
      this.notifyUnassigned(t.projectId);
    }
    // a finished task went back to rework: whatever was started from its branch is now behind
    if (t.status === 'verify' && (status === 'open' || status === 'in_progress' || status === 'blocked')) {
      for (const d of this.db.all<Task>('tasks', "base_task_id = ? AND status NOT IN ('done','obsolete','cancelled')", t.id)) {
        this.db.update('tasks', d.id, { staleBase: true });
        this.emit({ type: 'task.base_moved', projectId: t.projectId, actor: SYSTEM, taskId: d.id, summary: `«${d.title}» стоит на ветке задачи «${t.title}», которая ушла на доработку`, payload: { baseTaskId: t.id } });
      }
    }
    // …and came back: the tasks stacked on it can be brought up to date
    if (status === 'verify') {
      for (const d of this.db.all<Task>('tasks', 'base_task_id = ? AND stale_base = 1', t.id)) if (d.assigneeId) this.wake(d.assigneeId, 'base_changed', { taskId: d.id, baseTaskId: t.id }, `base:${d.id}`);
    }
    // work stacked on an accepted task has finished: the lead can merge what was waiting for it
    if (status === 'verify' && this.project(t.projectId).mergeBy === 'techlead' && this.tasks(t.projectId).some((x) => x.status === 'done' && x.executorRef && !x.merged)) { const lead = this.lead(t.projectId); if (lead) this.wake(lead.id, 'tasks_to_land', {}, 'land'); }
    // finished by the executor: the PM gathers such tasks into packages for the human testers
    if (status === 'verify') { const pm = this.pm(t.projectId); if (pm) this.wake(pm.id, 'tasks_to_package', {}, 'package'); }
    // accepted work is merged by the tech lead when the owner delegated merging
    if (status === 'done' && t.executorRef && !t.merged && this.project(t.projectId).mergeBy === 'techlead') { const lead = this.lead(t.projectId); if (lead) this.wake(lead.id, 'tasks_to_land', {}, 'land'); }
    if (status === 'blocked') { const lead = this.lead(t.projectId); if (lead && lead.id !== by.id) this.wake(lead.id, 'task_blocked', { taskId: t.id, note }, `blocked:${t.id}`); }
    return this.task(t.id);
  }

  recordIntake(taskId: string, agentId: string, ready: boolean, gaps: IntakeGap[]): Task {
    const t = this.task(taskId);
    this.db.update('tasks', t.id, { intake: { ready, gaps, at: now() }, updatedAt: now() });
    this.emit({ type: 'task.intake', projectId: t.projectId, actor: { kind: 'agent', id: agentId }, taskId: t.id, summary: ready ? `Входной контроль пройден: «${t.title}»` : `Входной контроль: пробелов ${gaps.length} в «${t.title}»`, payload: { ready, gaps } });
    return this.task(t.id);
  }

  /**
   * A task that is no longer needed. Nothing is deleted. Untouched tasks are closed by the caller directly;
   * a task with code or a counterpart in the company tracker goes through a decision.
   */
  markObsolete(taskId: string, reason: string, by: Actor): { applied: boolean; decisionId?: string } {
    const t = this.task(taskId);
    const touched = !!(t.executorRef || t.prUrl || t.externalKey);
    if (touched && by.kind === 'agent') {
      const d = this.decisions.propose({
        projectId: t.projectId, taskId: t.id, agentId: by.id!, title: `Признать задачу «${t.title}» неактуальной`,
        context: `Причина: ${reason}. По задаче уже есть ${[t.executorRef || t.prUrl ? 'наработки' : '', t.externalKey ? `связь с ${t.externalKey}` : ''].filter(Boolean).join(' и ')}.`,
        options: [{ key: 'obsolete', label: 'Признать неактуальной', consequences: 'Работа останавливается, ветка и наработки сохраняются.' }, { key: 'keep', label: 'Оставить в работе' }],
        recommendation: 'obsolete', rationale: reason, klass: 'product', reversible: true, importance: 'medium', confidence: 0.7,
        proposedPivotal: false, proposedDecider: { kind: 'owner' }, source: 'obsolete', sourceRef: reason,
      });
      return { applied: false, decisionId: d.id };
    }
    this.applyObsolete(t.id, reason, by);
    return { applied: true };
  }

  applyObsolete(taskId: string, reason: string, by: Actor) {
    const t = this.task(taskId);
    this.db.update('tasks', t.id, { obsoleteReason: reason });
    this.setTaskStatus(t.id, 'obsolete', by, reason);
    const affected = this.dependents(t.id);
    if (affected.length) {
      this.emit({ type: 'task.review_needed', projectId: t.projectId, actor: SYSTEM, taskId: t.id, summary: `Зависимые задачи требуют пересмотра: ${affected.length}`, payload: { tasks: affected } });
      const pm = this.pm(t.projectId); if (pm) this.wake(pm.id, 'dependents_review', { obsoleteTaskId: t.id, tasks: affected }, `obs:${t.id}`);
    }
  }

  /** The owner takes a task away from the team. */
  takeOver(taskId: string): Task {
    const t = this.task(taskId);
    this.db.update('tasks', t.id, { takenOver: true, assigneeId: null, updatedAt: now() });
    this.emit({ type: 'intervention.takeover', projectId: t.projectId, actor: OWNER, taskId: t.id, summary: `Владелец забрал задачу «${t.title}»`, payload: { previousAssignee: t.assigneeId } });
    return this.task(t.id);
  }

  /**
   * Safety net against a silent stall: an assigned task that could be worked on, with nothing pending around it
   * (no open decision, no executor run, its assignee idle with an empty queue) and no movement for a while.
   * The assignee is reminded, at most once per `everyMs`.
   */
  nudgeStalled(idleMs = 10 * 60_000, everyMs = 30 * 60_000, nowMs = Date.now()): Task[] {
    const out: Task[] = [];
    for (const t of this.db.all<Task>('tasks', "assignee_id IS NOT NULL AND taken_over = 0 AND executor_ref IS NULL AND status = 'open'")) {
      if (!this.isReady(t) || this.project(t.projectId).status !== 'active') continue;
      const a = this.db.get<Agent>('agents', t.assigneeId!); if (!a || a.status !== 'idle') continue;
      if (this.db.query<{ n: number }>("SELECT COUNT(*) n FROM wakeups WHERE agent_id = ? AND status IN ('queued','running')", a.id)[0]!.n) continue;
      if (this.db.query<{ n: number }>("SELECT COUNT(*) n FROM decisions WHERE task_id = ? AND status IN ('candidate','awaiting')", t.id)[0]!.n) continue;
      const last = this.db.query<{ ts: string | null }>('SELECT MAX(ts) ts FROM events WHERE task_id = ?', t.id)[0]!.ts ?? t.updatedAt;
      const nudged = this.db.query<{ ts: string | null }>("SELECT MAX(ts) ts FROM events WHERE task_id = ? AND type = 'task.nudged'", t.id)[0]!.ts;
      if (nowMs - Date.parse(last) < idleMs || (nudged && nowMs - Date.parse(nudged) < everyMs)) continue;
      this.emit({ type: 'task.nudged', projectId: t.projectId, actor: SYSTEM, taskId: t.id, summary: `«${t.title}» стоит без движения: ${a.alias} получает напоминание`, payload: { agentId: a.id } });
      this.wake(a.id, 'task_stalled', { taskId: t.id }, `stall:${t.id}`);
      out.push(t);
    }
    return out;
  }

  // ------------------------------------------------------------------ memory
  appendMemory(scope: 'agent' | 'project', id: string, text: string, by: Actor) {
    const table = scope === 'agent' ? 'agents' : 'projects';
    const cur = this.db.get<{ memory: string }>(table, id)?.memory ?? '';
    const line = `- ${now().slice(0, 10)}: ${text.trim()}`;
    this.db.update(table, id, { memory: (cur ? `${cur}\n` : '') + line });
    const projectId = scope === 'project' ? id : this.agent(id).projectId;
    this.emit({ type: 'memory.appended', projectId, actor: by, summary: `Память (${scope === 'agent' ? 'агент' : 'проект'}): ${text.trim().slice(0, 120)}`, payload: { scope, id } });
  }

  // ------------------------------------------------------------------ pause / resume
  setProjectStatus(projectId: string, status: 'active' | 'paused') {
    this.db.update('projects', projectId, { status });
    this.emit({ type: status === 'paused' ? 'intervention.project_paused' : 'intervention.project_resumed', projectId, actor: OWNER, summary: status === 'paused' ? 'Проект поставлен на паузу' : 'Проект возобновлён' });
    if (status === 'active') for (const l of this.wakeListeners) { try { l({} as Wakeup); } catch { /* ignore */ } }
  }
  setAgentStatus(agentId: string, status: 'idle' | 'paused') {
    const a = this.agent(agentId);
    this.db.update('agents', a.id, { status });
    this.emit({ type: status === 'paused' ? 'intervention.agent_paused' : 'intervention.agent_resumed', projectId: a.projectId, actor: OWNER, summary: `${a.alias}: ${status === 'paused' ? 'пауза' : 'возобновлён'}`, payload: { agentId: a.id } });
    if (status === 'idle') for (const l of this.wakeListeners) { try { l({} as Wakeup); } catch { /* ignore */ } }
  }
}
