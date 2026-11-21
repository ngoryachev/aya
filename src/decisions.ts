import { newId, now } from './db.js';
import { DECISION_CLASSES, type Decider, type Decision, type DecisionClass, type DecisionOption, type Reinforcement } from './types.js';
import { OWNER, SYSTEM, TeamError, type Actor, type Team } from './team.js';

export interface ProposeInput {
  projectId: string; taskId?: string | null; agentId: string; title: string; context: string; options: DecisionOption[];
  recommendation: string; rationale: string; klass: DecisionClass; reversible: boolean; importance: 'low' | 'medium' | 'high'; confidence: number;
  proposedPivotal: boolean; proposedDecider: Decider; source?: Decision['source']; sourceRef?: string | null;
}
export interface ClassifyInput {
  pivotal: boolean; decider: Decider; klass?: DecisionClass; note?: string;
  /** When the owner is the decider the choice may come with the classification. */
  chosen?: string; comment?: string;
}

const tokens = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3));

/**
 * The decision cycle: candidate with the agent's self-assessment → classification (the owner, or autonomy granted for
 * the class) → the decider chooses → reinforcement is recorded → the result becomes a precedent.
 */
export class Decisions {
  constructor(private team: Team) {}

  get(id: string): Decision { const d = this.team.db.get<Decision>('decisions', id); if (!d) throw new TeamError(`решение ${id} не найдено`, 404); return d; }
  list(projectId?: string, status?: string): Decision[] {
    const where: string[] = []; const params: string[] = [];
    if (projectId) { where.push('project_id = ?'); params.push(projectId); }
    if (status) { where.push('status = ?'); params.push(status); }
    return this.team.db.all<Decision>('decisions', `${where.join(' AND ') || '1=1'} ORDER BY created_at DESC`, ...params);
  }

  // ------------------------------------------------------------------ autonomy
  level(roleId: string, klass: DecisionClass): number {
    return (this.team.db.query<{ level: number }>('SELECT level FROM autonomy WHERE role_id = ? AND klass = ?', roleId, klass)[0]?.level) ?? 1;
  }
  setLevel(roleId: string, klass: DecisionClass, level: number) {
    if (![1, 2, 3].includes(level)) throw new TeamError('уровень автономии: 1, 2 или 3');
    const role = this.team.role(roleId);
    this.team.db.run('INSERT INTO autonomy (role_id, klass, level) VALUES (?,?,?) ON CONFLICT(role_id, klass) DO UPDATE SET level = excluded.level', roleId, klass, level);
    this.team.emit({ type: 'autonomy.changed', actor: OWNER, summary: `Автономия: ${role.title} / ${klass} → ступень ${level}`, payload: { roleId, klass, level } });
  }

  // ------------------------------------------------------------------ propose
  propose(input: ProposeInput): Decision {
    const { team } = this;
    if (!DECISION_CLASSES.includes(input.klass)) throw new TeamError(`класс решения должен быть одним из: ${DECISION_CLASSES.join(', ')}`);
    if (input.options.length < 2) throw new TeamError('нужно минимум два варианта');
    const keys = input.options.map((o) => o.key);
    if (new Set(keys).size !== keys.length) throw new TeamError('ключи вариантов должны быть разными');
    if (!keys.includes(input.recommendation)) throw new TeamError(`recommendation должен быть ключом одного из вариантов: ${keys.join(', ')}`);
    const agent = team.agent(input.agentId);
    this.checkDecider(input.projectId, input.proposedDecider);
    const d: Decision = {
      id: newId('d'), projectId: input.projectId, taskId: input.taskId ?? null, agentId: agent.id, title: input.title.trim(), context: input.context,
      options: input.options, recommendation: input.recommendation, rationale: input.rationale, klass: input.klass, reversible: input.reversible,
      importance: input.importance, confidence: Math.max(0, Math.min(1, input.confidence)), proposedPivotal: input.proposedPivotal, proposedDecider: input.proposedDecider,
      status: 'candidate', pivotal: null, decider: null, classifiedBy: null, chosen: null, chosenComment: null, resolvedBy: null,
      bySubstitute: false, needsReview: false, reviewed: false, reinforcement: {}, source: input.source ?? 'agent', sourceRef: input.sourceRef ?? null,
      createdAt: now(), classifiedAt: null, resolvedAt: null,
    };
    team.db.insert('decisions', d);
    team.emit({ type: 'decision.candidate', projectId: d.projectId, actor: { kind: 'agent', id: agent.id }, taskId: d.taskId, decisionId: d.id, summary: `Кандидат в решения: «${d.title}»`, payload: { klass: d.klass, reversible: d.reversible, importance: d.importance, confidence: d.confidence, recommendation: d.recommendation, proposedPivotal: d.proposedPivotal, proposedDecider: d.proposedDecider } });

    // autonomy granted for the class: the agent's own classification is trusted. Irreversible decisions never qualify.
    const level = d.reversible ? this.level(agent.roleId, d.klass) : 1;
    if (level >= 2) {
      const needsReview = level === 2 || team.random() < team.auditRate;
      team.db.update('decisions', d.id, { pivotal: d.proposedPivotal, classifiedBy: 'autonomy', classifiedAt: now(), needsReview });
      team.emit({ type: 'decision.classified', projectId: d.projectId, actor: SYSTEM, taskId: d.taskId, decisionId: d.id, summary: `Классифицировано автономно (ступень ${level}): «${d.title}»`, payload: { level, needsReview } });
      this.route(d.id, d.proposedDecider, undefined, undefined, true);
    }
    return this.get(d.id);
  }

  private checkDecider(projectId: string, decider: Decider) {
    if (decider.kind === 'agent') { if (!decider.id) throw new TeamError('для decider.kind=agent нужен id агента'); const a = this.team.agent(decider.id); if (a.projectId !== projectId) throw new TeamError('агент из другого проекта'); }
    if (decider.kind === 'persona') { if (!decider.id) throw new TeamError('для decider.kind=persona нужен id персоны'); this.team.persona(decider.id); }
  }

  // ------------------------------------------------------------------ classify (owner)
  classify(id: string, input: ClassifyInput): Decision {
    const d = this.get(id);
    if (d.status !== 'candidate' && d.status !== 'awaiting') throw new TeamError(`решение уже ${d.status}`, 409);
    this.checkDecider(d.projectId, input.decider);
    const sameDecider = input.decider.kind === d.proposedDecider.kind && (input.decider.id ?? null) === (d.proposedDecider.id ?? null);
    const klass = input.klass ?? d.klass;
    const reinforcement: Reinforcement = { ...d.reinforcement, pivotalMatch: input.pivotal === d.proposedPivotal, deciderMatch: sameDecider, classMatch: klass === d.klass, ownerNote: input.note || d.reinforcement.ownerNote };
    this.team.db.update('decisions', d.id, { pivotal: input.pivotal, klass, classifiedBy: 'owner', classifiedAt: now(), reinforcement });
    this.team.emit({ type: 'decision.classified', projectId: d.projectId, actor: OWNER, taskId: d.taskId, decisionId: d.id, summary: `Классификация: «${d.title}» — ${input.pivotal ? 'разворотное' : 'рядовое'}, решает ${this.deciderName(input.decider, d)}`, payload: { ...input, reinforcement } });
    this.route(d.id, input.decider, input.chosen, input.comment, false);
    return this.get(d.id);
  }

  deciderName(decider: Decider, d: Decision): string {
    if (decider.kind === 'self') return this.team.agent(d.agentId).alias;
    if (decider.kind === 'agent') return this.team.agent(decider.id!).alias;
    if (decider.kind === 'persona') return this.team.persona(decider.id!).name;
    return 'владелец';
  }

  private route(id: string, decider: Decider, chosen: string | undefined, comment: string | undefined, quiet: boolean) {
    const { team } = this; const d = this.get(id);
    // a persona that is the owner is simply the owner
    if (decider.kind === 'persona' && team.persona(decider.id!).isOwner) decider = { kind: 'owner' };
    // "another agent" that is the proposing agent itself is "self"
    if (decider.kind === 'agent' && decider.id === d.agentId) decider = { kind: 'self' };
    team.db.update('decisions', d.id, { decider, status: 'awaiting' });
    if (decider.kind === 'self') { this.resolve(d.id, d.recommendation, { kind: 'agent', id: d.agentId }, 'Решает сам агент по своей рекомендации.', { quiet }); return; }
    if (decider.kind === 'agent') { team.wake(decider.id!, 'decision_to_decide', { decisionId: d.id }, `decide:${d.id}`); return; }
    if (decider.kind === 'persona') { team.wake(d.agentId, 'decision_send_package', { decisionId: d.id, personaId: decider.id }, `pkg:${d.id}`); return; }
    if (chosen) this.resolve(d.id, chosen, OWNER, comment);
  }

  // ------------------------------------------------------------------ resolve
  resolve(id: string, chosen: string, by: Actor, comment?: string, opts: { quiet?: boolean; bySubstitute?: boolean } = {}): Decision {
    const { team } = this; const d = this.get(id);
    if (d.status === 'resolved') throw new TeamError('решение уже принято; изменить его может владелец через отмену решения', 409);
    if (d.status === 'cancelled') throw new TeamError('решение отменено', 409);
    if (!d.options.some((o) => o.key === chosen)) throw new TeamError(`вариант должен быть одним из: ${d.options.map((o) => o.key).join(', ')}`);
    const reinforcement: Reinforcement = { ...d.reinforcement, recommendationMatch: chosen === d.recommendation };
    team.db.update('decisions', d.id, {
      status: 'resolved', chosen, chosenComment: comment ?? null, resolvedBy: `${by.kind}${by.id ? `:${by.id}` : ''}`, resolvedAt: now(), reinforcement,
      bySubstitute: !!opts.bySubstitute, needsReview: d.needsReview || !!opts.bySubstitute,
    });
    team.emit({ type: 'decision.resolved', projectId: d.projectId, actor: by, taskId: d.taskId, decisionId: d.id, summary: `Решение «${d.title}»: ${this.label(d, chosen)} (${team.actorName(by)}${opts.bySubstitute ? ', ИИ-подмена' : ''})`, payload: { chosen, comment, recommendationMatch: reinforcement.recommendationMatch, bySubstitute: !!opts.bySubstitute } });
    this.applyEffects(this.get(d.id), by);
    if (!opts.quiet) team.wake(d.agentId, 'decision_resolved', { decisionId: d.id }, `res:${d.id}`);
    return this.get(d.id);
  }

  label(d: Decision, key: string) { return d.options.find((o) => o.key === key)?.label ?? key; }

  private applyEffects(d: Decision, by: Actor) {
    if (d.source === 'checkpoint') void this.team.exec.answerFromDecision(d).catch((e) => this.team.emit({ type: 'executor.error', projectId: d.projectId, actor: SYSTEM, decisionId: d.id, taskId: d.taskId, summary: `Не удалось ответить исполнителю: ${e instanceof Error ? e.message : String(e)}` }));
    if (d.source === 'obsolete' && d.taskId && d.chosen === 'obsolete') this.team.applyObsolete(d.taskId, d.sourceRef ?? d.rationale, by);
  }

  /** An agent the owner made the decider (the tech lead, the architect) chooses. */
  decideByAgent(id: string, agentId: string, chosen: string, comment: string): Decision {
    const d = this.get(id); const a = this.team.agent(agentId); const role = this.team.role(a.roleId);
    if (d.status !== 'awaiting' || d.decider?.kind !== 'agent' || d.decider.id !== agentId) throw new TeamError('это решение не назначено тебе');
    if (!role.canDecide.includes(d.klass)) throw new TeamError(`роль «${role.title}» не вправе решать класс «${d.klass}»; предложи владельцу другого решающего`);
    return this.resolve(id, chosen, { kind: 'agent', id: agentId }, comment);
  }

  /** The owner changes a decision at any moment, including one already made. Counts as reinforcement. */
  override(id: string, chosen: string, comment?: string): Decision {
    const { team } = this; const d = this.get(id);
    if (!d.options.some((o) => o.key === chosen)) throw new TeamError(`вариант должен быть одним из: ${d.options.map((o) => o.key).join(', ')}`);
    const wasResolved = d.status === 'resolved';
    const reinforcement: Reinforcement = { ...d.reinforcement, recommendationMatch: chosen === d.recommendation, overridden: wasResolved && d.chosen !== chosen ? true : d.reinforcement.overridden, ownerNote: comment || d.reinforcement.ownerNote };
    team.db.update('decisions', d.id, { status: 'resolved', chosen, chosenComment: comment ?? null, resolvedBy: 'owner', resolvedAt: now(), reinforcement, pivotal: d.pivotal ?? true, decider: { kind: 'owner' }, classifiedBy: d.classifiedBy ?? 'owner', classifiedAt: d.classifiedAt ?? now(), reviewed: true });
    team.emit({ type: 'intervention.override', projectId: d.projectId, actor: OWNER, taskId: d.taskId, decisionId: d.id, summary: `Владелец ${wasResolved ? 'изменил' : 'принял'} решение «${d.title}»: ${this.label(d, chosen)}`, payload: { chosen, previous: d.chosen, comment } });
    this.applyEffects(this.get(d.id), OWNER);
    team.wake(d.agentId, wasResolved ? 'decision_overridden' : 'decision_resolved', { decisionId: d.id }, `res:${d.id}:${chosen}`);
    return this.get(d.id);
  }

  /** The owner looks at a decision made without them (autonomy stage 2, spot check, AI stand-in). */
  review(id: string, ok: boolean, note?: string): Decision {
    const d = this.get(id);
    this.team.db.update('decisions', d.id, { reviewed: true, reinforcement: { ...d.reinforcement, ownerNote: note || d.reinforcement.ownerNote, ...(ok ? {} : { overridden: true }) } });
    this.team.emit({ type: 'decision.reviewed', projectId: d.projectId, actor: OWNER, decisionId: d.id, taskId: d.taskId, summary: `Проверка решения «${d.title}»: ${ok ? 'согласен' : 'не согласен'}`, payload: { ok, note } });
    return this.get(d.id);
  }

  cancel(id: string, by: Actor, reason?: string): Decision {
    const d = this.get(id);
    if (d.status === 'resolved') throw new TeamError('решение уже принято', 409);
    this.team.db.update('decisions', d.id, { status: 'cancelled', chosenComment: reason ?? null });
    this.team.emit({ type: 'decision.cancelled', projectId: d.projectId, actor: by, decisionId: d.id, taskId: d.taskId, summary: `Решение отменено: «${d.title}»`, payload: { reason } });
    return this.get(d.id);
  }

  /** An expert who stays silent longer than agreed: the decision goes up to the owner. */
  escalateStale(nowMs = Date.now()): Decision[] {
    const out: Decision[] = [];
    for (const d of this.list(undefined, 'awaiting')) {
      if (d.decider?.kind !== 'persona' || !d.classifiedAt) continue;
      const p = this.team.persona(d.decider.id!);
      if (nowMs - Date.parse(d.classifiedAt) < p.responseHours * 3_600_000) continue;
      this.team.db.update('decisions', d.id, { decider: { kind: 'owner' } });
      this.team.emit({ type: 'decision.escalated', projectId: d.projectId, actor: SYSTEM, decisionId: d.id, taskId: d.taskId, summary: `${p.name} не ответил за ${p.responseHours} ч: решение «${d.title}» поднято владельцу`, payload: { personaId: p.id } });
      out.push(this.get(d.id));
    }
    return out;
  }

  /** Earlier decisions that look like this question, so the same thing is not asked twice. */
  precedents(projectId: string, text: string, klass?: DecisionClass, limit = 3): { decision: Decision; score: number }[] {
    const q = tokens(text); if (!q.size) return [];
    return this.list(projectId, 'resolved')
      .map((d) => { const t = tokens(`${d.title} ${d.context}`); let hit = 0; for (const w of q) if (t.has(w)) hit++; return { decision: d, score: hit / Math.max(1, Math.min(q.size, t.size)) + (klass && d.klass === klass ? 0.1 : 0) }; })
      .filter((x) => x.score >= 0.35).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** How well each role's self-assessment matches the owner, per decision class: the basis for granting autonomy. */
  stats(projectId?: string) {
    const rows: Record<string, { roleId: string; roleTitle: string; klass: DecisionClass; level: number; classified: number; matched: number; resolved: number; recommended: number; overridden: number; autonomous: number }> = {};
    for (const d of this.list(projectId)) {
      const a = this.team.db.get<{ roleId: string }>('agents', d.agentId); if (!a) continue;
      const key = `${a.roleId}:${d.klass}`;
      const r = rows[key] ??= { roleId: a.roleId, roleTitle: this.team.role(a.roleId).title, klass: d.klass, level: this.level(a.roleId, d.klass), classified: 0, matched: 0, resolved: 0, recommended: 0, overridden: 0, autonomous: 0 };
      if (d.classifiedBy === 'owner') { r.classified++; if (d.reinforcement.pivotalMatch && d.reinforcement.deciderMatch && d.reinforcement.classMatch) r.matched++; }
      if (d.classifiedBy === 'autonomy') r.autonomous++;
      if (d.status === 'resolved') { r.resolved++; if (d.reinforcement.recommendationMatch) r.recommended++; }
      if (d.reinforcement.overridden) r.overridden++;
    }
    return Object.values(rows).sort((a, b) => a.roleTitle.localeCompare(b.roleTitle) || a.klass.localeCompare(b.klass));
  }
}
