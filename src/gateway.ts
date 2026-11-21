import crypto from 'node:crypto';
import { newId, now } from './db.js';
import type { Agent, Contact, Decision, Message, MessageKind, Persona, Project, StyleLesson, TrackerIssue } from './types.js';
import { OWNER, SYSTEM, TeamError, type Team } from './team.js';

/** A way to reach people. Real adapters (Slack, mail) implement this; the mock one only records. */
export interface Channel {
  name: string;
  send(msg: { to: string; text: string; threadId: string | null }): Promise<{ externalId: string; threadId: string }>;
}

export class MockChannel implements Channel {
  sent: { to: string; text: string; threadId: string; externalId: string }[] = [];
  constructor(public name = 'mock') {}
  async send(msg: { to: string; text: string; threadId: string | null }) {
    const externalId = newId('x'); const threadId = msg.threadId ?? newId('th');
    this.sent.push({ to: msg.to, text: msg.text, threadId, externalId });
    return { externalId, threadId };
  }
}

/** The company tracker as the team sees it. The mock one lives in the local database. */
export interface Tracker {
  get(key: string): Promise<TrackerIssue | null>;
  list(project?: string): Promise<TrackerIssue[]>;
  update(key: string, patch: { status?: string; comment?: string; author?: string }): Promise<TrackerIssue>;
}

export class MockTracker implements Tracker {
  constructor(private team: Team) {}
  async get(key: string) { return this.team.db.get<TrackerIssue>('tracker_issues', key, 'key') ?? null; }
  async list(project?: string) { return project ? this.team.db.all<TrackerIssue>('tracker_issues', 'project = ? ORDER BY key', project) : this.team.db.all<TrackerIssue>('tracker_issues', '1=1 ORDER BY key'); }
  create(input: { key: string; project: string; title: string; description?: string; status?: string }): TrackerIssue {
    const i: TrackerIssue = { key: input.key, project: input.project, title: input.title, description: input.description ?? '', status: input.status ?? 'To Do', comments: [], createdAt: now(), updatedAt: now() };
    this.team.db.insert('tracker_issues', i);
    return i;
  }
  async update(key: string, patch: { status?: string; comment?: string; author?: string }) {
    const i = await this.get(key); if (!i) throw new TeamError(`задача ${key} не найдена в трекере`, 404);
    const comments = patch.comment ? [...i.comments, { at: now(), author: patch.author ?? 'team', text: patch.comment }] : i.comments;
    this.team.db.update('tracker_issues', key, { status: patch.status ?? i.status, comments, updatedAt: now() }, 'key');
    return (await this.get(key))!;
  }
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'приватный ключ'],
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{20,}/, 'ключ API'],
  [/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/, 'токен GitHub'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'токен Slack'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'ключ AWS'],
  [/\b(?:password|passwd|пароль|secret|token|api[_-]?key)\b\s*[:=]\s*["']?[^\s"']{6,}/i, 'пароль или секрет в открытом виде'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/, 'токен авторизации'],
];

export interface SubmitInput {
  agentId: string; personaId: string; kind: MessageKind; text: string;
  decisionId?: string | null; taskId?: string | null;
}

/**
 * The only door between the agents and the outside world. Outgoing: contact approval → content policy → the owner's
 * approval (with edits that become style lessons) → the channel, under the agent's alias. Incoming: matched to the
 * thread and handed over as data, never as instructions.
 */
export class Gateway {
  channels = new Map<string, Channel>();
  tracker: Tracker;
  /** Produces the AI stand-in's reply for a persona whose stand-in is switched on. Set by the runtime. */
  substitute: ((persona: Persona, text: string, decision: Decision) => Promise<string>) | null = null;

  constructor(private team: Team) {
    this.channels.set('mock', new MockChannel());
    this.tracker = new MockTracker(team);
  }

  message(id: string): Message { const m = this.team.db.get<Message>('messages', id); if (!m) throw new TeamError(`сообщение ${id} не найдено`, 404); return m; }
  messages(projectId?: string, status?: string): Message[] {
    const where: string[] = []; const params: string[] = [];
    if (projectId) { where.push('project_id = ?'); params.push(projectId); }
    if (status) { where.push('status = ?'); params.push(status); }
    return this.team.db.all<Message>('messages', `${where.join(' AND ') || '1=1'} ORDER BY created_at DESC LIMIT 500`, ...params);
  }

  // ------------------------------------------------------------------ style
  lessons(): StyleLesson[] { return this.team.db.all<StyleLesson>('style_lessons', '1=1 ORDER BY created_at'); }
  /** Lessons that apply to this agent writing to this persona, and a version the agent must quote when sending. */
  styleFor(agent: Agent, personaId: string | null): { version: string; lessons: StyleLesson[] } {
    const lessons = this.lessons().filter((l) => l.active && (l.scope === 'all' || (l.scope === 'role' && l.scopeId === agent.roleId) || (l.scope === 'persona' && l.scopeId === personaId)));
    const version = lessons.length ? crypto.createHash('sha1').update(lessons.map((l) => `${l.id}:${l.text}`).join('|')).digest('hex').slice(0, 8) : '0';
    return { version, lessons };
  }
  addLesson(input: { scope: StyleLesson['scope']; scopeId?: string | null; text: string; source?: StyleLesson['source']; before?: string | null; after?: string | null }): StyleLesson {
    if (input.scope !== 'all' && !input.scopeId) throw new TeamError('для охвата «роль» или «адресат» нужно указать, какая роль или адресат');
    const l: StyleLesson = { id: newId('l'), scope: input.scope, scopeId: input.scope === 'all' ? null : input.scopeId!, text: input.text.trim(), source: input.source ?? 'rule', before: input.before ?? null, after: input.after ?? null, active: true, createdAt: now() };
    if (!l.text) throw new TeamError('пустой урок');
    this.team.db.insert('style_lessons', l);
    this.team.emit({ type: 'style.lesson_added', actor: OWNER, summary: `Урок стиля (${l.scope}): ${l.text.slice(0, 120)}`, payload: { lessonId: l.id, scope: l.scope, scopeId: l.scopeId, source: l.source } });
    return l;
  }
  updateLesson(id: string, patch: { text?: string; active?: boolean; scope?: StyleLesson['scope']; scopeId?: string | null }) {
    this.team.db.update('style_lessons', id, patch);
    this.team.emit({ type: 'style.lesson_updated', actor: OWNER, summary: 'Руководство по стилю изменено', payload: { lessonId: id, ...patch } });
  }

  // ------------------------------------------------------------------ policy and rules
  checkPolicy(project: Project, text: string): string[] {
    const out: string[] = [];
    for (const [re, name] of SECRET_PATTERNS) if (re.test(text)) out.push(`похоже на секрет: ${name}`);
    for (const p of project.policy.denyPatterns) { try { if (new RegExp(p, 'i').test(text)) out.push(`запрещено политикой проекта: ${p}`); } catch { /* a broken pattern blocks nothing */ } }
    if (text.length > project.policy.maxChars) out.push(`слишком длинно: ${text.length} знаков при лимите ${project.policy.maxChars}`);
    if (!project.policy.allowCode) for (const block of text.match(/```[\s\S]*?```/g) ?? []) if (block.split('\n').length > 17) out.push('большой фрагмент кода: политика проекта не разрешает отправлять код наружу');
    return out;
  }
  requiresApproval(kind: MessageKind, personaId: string | null): boolean {
    const rows = this.team.db.all<{ kind: string; personaId: string; requireApproval: boolean }>('approval_rules', 'kind = ?', kind);
    const hit = rows.find((r) => r.personaId === personaId) ?? rows.find((r) => r.personaId === '*');
    return hit ? hit.requireApproval : true;
  }
  setApprovalRule(kind: MessageKind, personaId: string, requireApproval: boolean) {
    this.team.db.run('INSERT INTO approval_rules (kind, persona_id, require_approval) VALUES (?,?,?) ON CONFLICT(kind, persona_id) DO UPDATE SET require_approval = excluded.require_approval', kind, personaId, requireApproval ? 1 : 0);
    this.team.emit({ type: 'gateway.rule_changed', actor: OWNER, summary: `Одобрение сообщений «${kind}»${personaId === '*' ? '' : ` для ${this.team.persona(personaId).name}`}: ${requireApproval ? 'обязательно' : 'снято'}`, payload: { kind, personaId, requireApproval } });
  }
  approvalRules() { return this.team.db.all<{ kind: string; personaId: string; requireApproval: boolean }>('approval_rules'); }

  // ------------------------------------------------------------------ contacts
  contact(agentId: string, personaId: string): Contact | undefined { return this.team.db.one<Contact>('contacts', 'agent_id = ? AND persona_id = ?', agentId, personaId); }
  contacts(): Contact[] { return this.team.db.all<Contact>('contacts', '1=1 ORDER BY created_at DESC'); }
  setContact(agentId: string, personaId: string, status: Contact['status']) {
    const a = this.team.agent(agentId); const p = this.team.persona(personaId);
    this.team.db.run('INSERT INTO contacts (agent_id, persona_id, status, created_at) VALUES (?,?,?,?) ON CONFLICT(agent_id, persona_id) DO UPDATE SET status = excluded.status', agentId, personaId, status, now());
    if (status !== 'pending') this.team.emit({ type: 'gateway.contact', projectId: a.projectId, actor: OWNER, summary: `Контакт ${a.alias} → ${p.name}: ${status === 'approved' ? 'утверждён' : 'отклонён'}`, payload: { agentId, personaId, status } });
    // messages that were waiting for this decision
    for (const m of this.team.db.all<Message>('messages', "agent_id = ? AND persona_id = ? AND status = 'pending_contact'", agentId, personaId)) {
      if (status === 'approved') void this.advance(m.id);
      else if (status === 'denied') this.reject(m.id, `Владелец не утвердил контакт с ${p.name}.`);
    }
  }

  // ------------------------------------------------------------------ outgoing
  async submit(input: SubmitInput): Promise<Message> {
    const { team } = this;
    const agent = team.agent(input.agentId); const persona = team.persona(input.personaId); const project = team.project(agent.projectId);
    if (persona.contactLimitPerWeek != null) {
      const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const n = team.db.query<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE persona_id = ? AND direction = 'out' AND status = 'sent' AND sent_at > ?", persona.id, weekAgo)[0]!.n;
      if (n >= persona.contactLimitPerWeek) throw new TeamError(`лимит обращений к ${persona.name} исчерпан (${persona.contactLimitPerWeek} в неделю). Объедини вопросы или предложи владельцу решить самому.`);
    }
    const contact = this.contact(agent.id, persona.id);
    if (contact?.status === 'denied') throw new TeamError(`владелец не утвердил твой контакт с ${persona.name}`);
    const violations = this.checkPolicy(project, input.text);
    const m: Message = {
      id: newId('m'), projectId: project.id, direction: 'out', channel: persona.channel, agentId: agent.id, personaId: persona.id, kind: input.kind,
      threadId: this.threadFor(input.decisionId ?? null, persona.id), decisionId: input.decisionId ?? null, taskId: input.taskId ?? null,
      draftText: input.text, finalText: null, status: violations.length ? 'blocked' : contact?.status === 'approved' ? 'pending_approval' : 'pending_contact',
      edited: false, violations, externalId: null, rejectReason: null, action: null, createdAt: now(), sentAt: null,
    };
    team.db.insert('messages', m);
    if (violations.length) { team.emit({ type: 'gateway.blocked', projectId: project.id, actor: { kind: 'agent', id: agent.id }, decisionId: m.decisionId, taskId: m.taskId, summary: `Сообщение ${agent.alias} → ${persona.name} остановлено политикой: ${violations.join('; ')}`, payload: { messageId: m.id, violations } }); return m; }
    team.emit({ type: 'gateway.drafted', projectId: project.id, actor: { kind: 'agent', id: agent.id }, decisionId: m.decisionId, taskId: m.taskId, summary: `Черновик ${agent.alias} → ${persona.name}`, payload: { messageId: m.id, kind: m.kind } });
    if (!contact) { this.team.db.run('INSERT INTO contacts (agent_id, persona_id, status, created_at) VALUES (?,?,?,?)', agent.id, persona.id, 'pending', now()); team.emit({ type: 'gateway.contact_requested', projectId: project.id, actor: { kind: 'agent', id: agent.id }, summary: `${agent.alias} просит утвердить контакт с ${persona.name}`, payload: { agentId: agent.id, personaId: persona.id } }); }
    if (m.status === 'pending_approval') await this.advance(m.id);
    return this.message(m.id);
  }

  /** A write to the company tracker: the same door, the same approval and log. */
  async submitTracker(input: { agentId: string; key: string; status?: string; comment?: string; taskId?: string | null }): Promise<Message> {
    const { team } = this; const agent = team.agent(input.agentId); const project = team.project(agent.projectId);
    if (!(await this.tracker.get(input.key))) throw new TeamError(`задача ${input.key} не найдена в трекере`);
    const text = [input.status ? `Статус → ${input.status}` : '', input.comment ? `Комментарий: ${input.comment}` : ''].filter(Boolean).join('\n');
    if (!text) throw new TeamError('нужен статус или комментарий');
    const violations = this.checkPolicy(project, input.comment ?? '');
    const m: Message = {
      id: newId('m'), projectId: project.id, direction: 'out', channel: 'tracker', agentId: agent.id, personaId: null, kind: 'tracker', threadId: input.key, decisionId: null, taskId: input.taskId ?? null,
      draftText: text, finalText: null, status: violations.length ? 'blocked' : 'pending_approval', edited: false, violations, externalId: null, rejectReason: null,
      action: { type: 'tracker_update', key: input.key, status: input.status, comment: input.comment }, createdAt: now(), sentAt: null,
    };
    team.db.insert('messages', m);
    if (violations.length) { team.emit({ type: 'gateway.blocked', projectId: project.id, actor: { kind: 'agent', id: agent.id }, summary: `Запись в трекер остановлена политикой: ${violations.join('; ')}`, payload: { messageId: m.id, violations } }); return m; }
    team.emit({ type: 'gateway.drafted', projectId: project.id, actor: { kind: 'agent', id: agent.id }, taskId: m.taskId, summary: `Запись в трекер ${input.key}: ${text.replace(/\n/g, '; ')}`, payload: { messageId: m.id, kind: 'tracker' } });
    await this.advance(m.id);
    return this.message(m.id);
  }

  private threadFor(decisionId: string | null, personaId: string): string | null {
    if (!decisionId) return null;
    return this.team.db.one<Message>('messages', 'decision_id = ? AND persona_id = ? AND thread_id IS NOT NULL', decisionId, personaId)?.threadId ?? null;
  }

  /** Past the contact check: either wait for the owner or go out. */
  private async advance(id: string) {
    const m = this.message(id);
    if (this.requiresApproval(m.kind, m.personaId)) {
      if (m.status !== 'pending_approval') this.team.db.update('messages', m.id, { status: 'pending_approval' });
      this.team.emit({ type: 'gateway.approval_needed', projectId: m.projectId, actor: SYSTEM, decisionId: m.decisionId, taskId: m.taskId, summary: 'Сообщение ждёт одобрения владельца', payload: { messageId: m.id } });
      return;
    }
    await this.deliver(m.id, m.draftText);
  }

  /** The owner lets a message out, possibly edited. The edit can be kept as a style lesson of the chosen scope. */
  async approve(id: string, input: { text?: string; lesson?: { scope: StyleLesson['scope']; text?: string } } = {}): Promise<Message> {
    const m = this.message(id);
    if (m.status !== 'pending_approval') throw new TeamError(`сообщение в статусе ${m.status}`, 409);
    const text = (input.text ?? m.draftText).trim();
    const edited = text !== m.draftText.trim();
    if (input.lesson && (edited || input.lesson.text)) {
      const agent = m.agentId ? this.team.agent(m.agentId) : null;
      const scopeId = input.lesson.scope === 'persona' ? m.personaId : input.lesson.scope === 'role' ? agent?.roleId ?? null : null;
      if (input.lesson.scope === 'all' || scopeId) this.addLesson({ scope: input.lesson.scope, scopeId, text: input.lesson.text?.trim() || 'Пиши так, как в исправленном варианте (см. пример «было → стало»).', source: 'edit', before: edited ? m.draftText : null, after: edited ? text : null });
    }
    this.team.db.update('messages', m.id, { edited });
    this.team.emit({ type: 'gateway.approved', projectId: m.projectId, actor: OWNER, decisionId: m.decisionId, taskId: m.taskId, summary: edited ? 'Владелец поправил и одобрил сообщение' : 'Владелец одобрил сообщение без правок', payload: { messageId: m.id, edited } });
    return this.deliver(m.id, text);
  }

  reject(id: string, reason: string, lessonScope?: StyleLesson['scope']): Message {
    const m = this.message(id);
    if (m.status === 'sent') throw new TeamError('сообщение уже отправлено', 409);
    this.team.db.update('messages', m.id, { status: 'rejected', rejectReason: reason });
    this.team.emit({ type: 'gateway.rejected', projectId: m.projectId, actor: OWNER, decisionId: m.decisionId, taskId: m.taskId, summary: `Сообщение отклонено: ${reason}`, payload: { messageId: m.id } });
    if (lessonScope && m.agentId) {
      const scopeId = lessonScope === 'persona' ? m.personaId : lessonScope === 'role' ? this.team.agent(m.agentId).roleId : null;
      if (lessonScope === 'all' || scopeId) this.addLesson({ scope: lessonScope, scopeId, text: reason, source: 'reject', before: m.draftText });
    }
    if (m.agentId) this.team.wake(m.agentId, 'message_rejected', { messageId: m.id });
    return this.message(m.id);
  }

  private async deliver(id: string, text: string): Promise<Message> {
    const { team } = this; const m = this.message(id);
    const agent = m.agentId ? team.agent(m.agentId) : null;
    const signed = agent ? `[${agent.alias} · ${team.role(agent.roleId).title}] ${text}` : text;
    let externalId: string | null = null; let threadId = m.threadId;
    if (m.action?.type === 'tracker_update') {
      await this.tracker.update(m.action.key, { status: m.action.status, comment: m.action.comment ? (agent ? `[${agent.alias} · ${team.role(agent.roleId).title}] ${m.action.comment}` : m.action.comment) : undefined, author: agent?.alias });
    } else {
      const persona = team.persona(m.personaId!);
      const channel = this.channels.get(m.channel);
      if (!channel) throw new TeamError(`канал «${m.channel}» не подключён`);
      const r = await channel.send({ to: persona.address || persona.name, text: signed, threadId: m.threadId });
      externalId = r.externalId; threadId = r.threadId;
    }
    team.db.update('messages', m.id, { status: 'sent', finalText: signed, externalId, threadId, sentAt: now() });
    team.emit({ type: 'gateway.sent', projectId: m.projectId, actor: agent ? { kind: 'agent', id: agent.id } : SYSTEM, decisionId: m.decisionId, taskId: m.taskId, summary: m.action ? `В трекер ${m.action.key}: ${m.draftText.replace(/\n/g, '; ')}` : `Отправлено ${agent?.alias ?? ''} → ${team.persona(m.personaId!).name}`, payload: { messageId: m.id, channel: m.channel } });
    const sent = this.message(m.id);
    void this.maybeSubstitute(sent).catch((e) => team.emit({ type: 'gateway.error', projectId: m.projectId, actor: SYSTEM, summary: `ИИ-подмена не ответила: ${e instanceof Error ? e.message : String(e)}` }));
    return sent;
  }

  /** The persona's AI stand-in answers instead of the human, for the classes the owner allowed. */
  private async maybeSubstitute(m: Message) {
    if (!m.personaId || !m.decisionId || !this.substitute) return;
    const persona = this.team.persona(m.personaId); const d = this.team.decisions.get(m.decisionId);
    if (!persona.substituteOn || !persona.substituteClasses.includes(d.klass) || !d.reversible) return;
    const reply = await this.substitute(persona, m.finalText ?? m.draftText, d);
    this.receive({ threadId: m.threadId!, text: reply, bySubstitute: true });
  }

  // ------------------------------------------------------------------ incoming
  /** Something arrived from outside. It is matched to its thread and passed on as data. */
  receive(input: { threadId?: string; replyTo?: string; text: string; bySubstitute?: boolean }): Message {
    const { team } = this;
    const origin = input.replyTo ? this.message(input.replyTo) : team.db.one<Message>('messages', "thread_id = ? AND direction = 'out' ORDER BY created_at DESC", input.threadId ?? '');
    if (!origin || !origin.personaId) throw new TeamError('не нашёл, на какое сообщение это ответ', 404);
    const persona = team.persona(origin.personaId);
    const m: Message = {
      id: newId('m'), projectId: origin.projectId, direction: 'in', channel: origin.channel, agentId: origin.agentId, personaId: persona.id, kind: origin.kind,
      threadId: origin.threadId, decisionId: origin.decisionId, taskId: origin.taskId, draftText: input.text, finalText: input.text, status: 'received', edited: false,
      violations: [], externalId: null, rejectReason: null, action: null, createdAt: now(), sentAt: null,
    };
    team.db.insert('messages', m);
    team.emit({ type: 'gateway.received', projectId: m.projectId, actor: { kind: 'persona', id: persona.id }, decisionId: m.decisionId, taskId: m.taskId, summary: `Ответ от ${persona.name}${input.bySubstitute ? ' (ИИ-подмена)' : ''}: ${input.text.slice(0, 140)}`, payload: { messageId: m.id, bySubstitute: !!input.bySubstitute } });
    if (m.decisionId) {
      const d = team.decisions.get(m.decisionId);
      if (d.status === 'awaiting' && d.decider?.kind === 'persona' && d.decider.id === persona.id) {
        const parsed = this.parseChoice(d, input.text);
        if (parsed) { team.decisions.resolve(d.id, parsed.chosen, { kind: 'persona', id: persona.id }, parsed.comment, { bySubstitute: input.bySubstitute }); return m; }
        team.emit({ type: 'decision.reply_unparsed', projectId: m.projectId, actor: SYSTEM, decisionId: d.id, summary: `Ответ ${persona.name} не содержит однозначного выбора варианта`, payload: { messageId: m.id } });
      }
    }
    if (m.agentId) team.wake(m.agentId, 'message_reply', { messageId: m.id });
    return m;
  }

  /** A structured answer names an option first: "Вариант B. Комментарий…" or just "B — …". */
  parseChoice(d: Decision, text: string): { chosen: string; comment: string } | null {
    const t = text.trim();
    const m = /^(?:вариант|option|выбор|выбираю|ответ)?\s*[:\-—]?\s*[«"']?([\p{L}\p{N}_-]+)[»"']?[\s.:,;—-]*([\s\S]*)$/iu.exec(t);
    if (m) { const hit = d.options.find((o) => o.key.toLowerCase() === m[1]!.toLowerCase()); if (hit) return { chosen: hit.key, comment: m[2]!.trim() }; }
    const byLabel = d.options.filter((o) => t.toLowerCase().includes(o.label.toLowerCase()));
    if (byLabel.length === 1) return { chosen: byLabel[0]!.key, comment: t };
    return null;
  }

  /** Share of messages that went out unedited, per kind: the basis for lifting mandatory approval. */
  stats(projectId?: string) {
    const rows = this.team.db.query<{ kind: string; sent: number; edited: number; rejected: number; blocked: number }>(
      `SELECT kind, SUM(status = 'sent') sent, SUM(status = 'sent' AND edited = 1) edited, SUM(status = 'rejected') rejected, SUM(status = 'blocked') blocked
       FROM messages WHERE direction = 'out' ${projectId ? 'AND project_id = ?' : ''} GROUP BY kind`, ...(projectId ? [projectId] : []));
    return rows.map((r) => ({ ...r, unedited: r.sent ? (r.sent - r.edited) / r.sent : null, requireApproval: this.requiresApproval(r.kind as MessageKind, '*') }));
  }
}
