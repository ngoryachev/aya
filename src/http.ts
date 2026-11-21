import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { CLASS_TITLES, DECISION_CLASSES, TASK_STATUSES, type Agent, type AgentRun, type Package, type Project, type Role, type Wakeup } from './types.js';
import { OWNER, TeamError, type Team } from './team.js';
import { MockTracker } from './gateway.js';
import { createPersona, createProject } from './seed.js';
import { REASON_TITLES, type Runtime } from './runtime.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const klass = z.enum(DECISION_CLASSES);
const decider = z.object({ kind: z.enum(['self', 'agent', 'persona', 'owner']), id: z.string().nullable().optional() });
const scope = z.enum(['all', 'role', 'persona']);
const personaBody = z.object({
  name: z.string().min(1), title: z.string().optional(), expertise: z.string().optional(), channel: z.string().optional(), address: z.string().optional(), timezone: z.string().nullable().optional(),
  responseHours: z.number().positive().optional(), contactLimitPerWeek: z.number().int().positive().nullable().optional(), classesRequired: z.array(klass).optional(), classesAdvisory: z.array(klass).optional(),
  substituteOn: z.boolean().optional(), substituteClasses: z.array(klass).optional(), notes: z.string().optional(),
});

function safeEq(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); }

export function ensureToken(team: Team): string {
  let t = team.db.setting('token');
  if (!t) { t = crypto.randomBytes(24).toString('base64url'); team.db.setSetting('token', t); }
  return t;
}

export function createHttpApp(team: Team, runtime: Runtime) {
  const token = ensureToken(team);
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof TeamError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof z.ZodError) return c.json({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400);
    console.error(`[http] ${c.req.method} ${c.req.path}:`, err);
    return c.json({ error: err.message }, 500);
  });

  // ?t=<token> sets the cookie once; after that the cookie or a Bearer header is accepted
  app.use('*', async (c, next) => {
    const t = c.req.query('t');
    if (t) {
      if (!safeEq(t, token)) return c.text('bad token', 401);
      setCookie(c, 'aya_token', t, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 30 });
      const u = new URL(c.req.url); u.searchParams.delete('t');
      return c.redirect(u.pathname + (u.search || ''));
    }
    await next();
  });
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health') return next();
    const auth = c.req.header('authorization'); const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined; const cookie = getCookie(c, 'aya_token');
    if ((bearer && safeEq(bearer, token)) || (cookie && safeEq(cookie, token))) return next();
    return c.json({ error: 'unauthorized' }, 401);
  });

  app.get('/api/health', (c) => c.json({ ok: true, name: 'aya' }));

  // ------------------------------------------------------------------ everything the UI shows, in one read
  app.get('/api/state', (c) => {
    const { db } = team;
    const projects = db.all<Project>('projects', '1=1 ORDER BY created_at DESC');
    const projectId = c.req.query('project') || projects[0]?.id;
    const roles = db.all<Role>('roles');
    const base = { projects, projectId: projectId ?? null, roles, personas: team.personas(), classes: CLASS_TITLES, taskStatuses: TASK_STATUSES, reasonTitles: REASON_TITLES, lessons: team.gateway.lessons(), approvalRules: team.gateway.approvalRules(), tracker: db.all('tracker_issues', '1=1 ORDER BY key'), nodes: db.all('nodes') };
    if (!projectId) return c.json(base);
    const agents = team.agents(projectId).map((a) => ({
      ...a, running: runtime.isRunning(a.id),
      queued: db.all<Wakeup>('wakeups', "agent_id = ? AND status = 'queued' ORDER BY created_at", a.id).map((w) => ({ id: w.id, reason: w.reason, title: REASON_TITLES[w.reason] ?? w.reason })),
      lastRun: db.one<AgentRun>('agent_runs', 'agent_id = ? ORDER BY started_at DESC', a.id) ?? null,
      costUsd: db.query<{ s: number | null }>('SELECT SUM(cost_usd) s FROM agent_runs WHERE agent_id = ?', a.id)[0]!.s ?? 0,
    }));
    const tasks = team.tasks(projectId).map((t) => ({ ...t, dependsOn: team.deps(t.id), ready: team.isReady(t) }));
    const decisions = team.decisions.list(projectId).map((d) => ({ ...d, precedents: d.status === 'candidate' ? team.decisions.precedents(projectId, `${d.title} ${d.context}`, d.klass).filter((x) => x.decision.id !== d.id).map((x) => ({ id: x.decision.id, title: x.decision.title, chosen: x.decision.chosen, label: team.decisions.label(x.decision, x.decision.chosen ?? '') })) : [] }));
    const spent = agents.reduce((s, a) => s + a.costUsd, 0);
    const ownerActions = db.query<{ n: number }>("SELECT COUNT(*) n FROM events WHERE project_id = ? AND actor_kind = 'owner'", projectId)[0]!.n;
    const classified = decisions.filter((d) => d.classifiedBy === 'owner');
    const metrics = {
      spentUsd: spent, ownerActions,
      decisions: { total: decisions.length, open: decisions.filter((d) => d.status === 'candidate' || d.status === 'awaiting').length, autonomous: decisions.filter((d) => d.classifiedBy === 'autonomy').length },
      selfAssessmentMatch: classified.length ? classified.filter((d) => d.reinforcement.pivotalMatch && d.reinforcement.deciderMatch && d.reinforcement.classMatch).length / classified.length : null,
      recommendationMatch: (() => { const r = decisions.filter((d) => d.status === 'resolved'); return r.length ? r.filter((d) => d.reinforcement.recommendationMatch).length / r.length : null; })(),
      misses: decisions.filter((d) => d.classifiedBy === 'autonomy' && d.reinforcement.overridden).length,
      expertRequests: db.query<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE project_id = ? AND direction = 'out' AND status = 'sent' AND kind IN ('decision_package','question')", projectId)[0]!.n,
    };
    return c.json({
      ...base, agents, tasks, decisions, metrics,
      messages: team.gateway.messages(projectId), contacts: team.gateway.contacts().filter((x) => agents.some((a) => a.id === x.agentId)),
      checkpoints: team.exec.checkpoints(projectId), packages: db.all<Package>('packages', 'project_id = ? ORDER BY created_at DESC', projectId),
      autonomy: team.decisions.stats(projectId), autonomyLevels: db.query('SELECT role_id roleId, klass, level FROM autonomy'), messageStats: team.gateway.stats(projectId),
    });
  });

  app.get('/api/events/history', (c) => c.json({ events: team.events({ since: Number(c.req.query('since') ?? 0), projectId: c.req.query('project') || undefined, taskId: c.req.query('task') || undefined, decisionId: c.req.query('decision') || undefined, limit: Number(c.req.query('limit') ?? 300) }) }));
  app.get('/api/events', (c) => streamSSE(c, async (stream) => {
    let closed = false; const queue: string[] = []; let wake: (() => void) | null = null;
    stream.onAbort(() => { closed = true; wake?.(); });
    const off = team.onEvent((e) => { queue.push(JSON.stringify(e)); wake?.(); });
    await stream.writeSSE({ event: 'hello', data: '{}' });
    try {
      while (!closed) {
        if (!queue.length) { await Promise.race([new Promise<void>((r) => { wake = r; }), new Promise<void>((r) => setTimeout(r, 15_000))]); wake = null; if (!queue.length && !closed) { await stream.writeSSE({ event: 'ping', data: '' }); continue; } }
        while (queue.length && !closed) await stream.writeSSE({ event: 'event', data: queue.shift()! });
      }
    } finally { off(); }
  }));

  // ------------------------------------------------------------------ projects, personas, agents
  app.post('/api/projects', async (c) => {
    const b = z.object({ name: z.string().min(1), goal: z.string(), repoPath: z.string().nullable().optional(), executor: z.string().optional(), pipeline: z.string().nullable().optional(), trackerProject: z.string().nullable().optional(), budgetUsd: z.number().positive().nullable().optional(), start: z.boolean().optional() }).parse(await c.req.json());
    if (b.repoPath && !fs.existsSync(b.repoPath)) throw new TeamError(`каталог ${b.repoPath} не найден`);
    return c.json(createProject(team, b), 201);
  });
  app.patch('/api/projects/:id', async (c) => {
    const b = z.object({ status: z.enum(['active', 'paused']).optional(), goal: z.string().optional(), budgetUsd: z.number().positive().nullable().optional(), pipeline: z.string().nullable().optional(), trackerProject: z.string().nullable().optional(), policy: z.object({ denyPatterns: z.array(z.string()), maxChars: z.number().int().positive(), allowCode: z.boolean() }).optional() }).parse(await c.req.json());
    const p = team.project(c.req.param('id'));
    const { status, ...rest } = b;
    if (Object.keys(rest).length) { team.db.update('projects', p.id, rest); team.emit({ type: 'project.updated', projectId: p.id, actor: OWNER, summary: `Проект изменён: ${Object.keys(rest).join(', ')}`, payload: rest }); }
    if (status && status !== p.status) team.setProjectStatus(p.id, status);
    return c.json(team.project(p.id));
  });
  app.post('/api/personas', async (c) => c.json(createPersona(team, personaBody.parse(await c.req.json())), 201));
  app.patch('/api/personas/:id', async (c) => {
    const p = team.persona(c.req.param('id')); const b = personaBody.partial().parse(await c.req.json());
    team.db.update('personas', p.id, b);
    team.emit({ type: b.substituteOn !== undefined && b.substituteOn !== p.substituteOn ? 'persona.substitute' : 'persona.updated', actor: OWNER, summary: b.substituteOn !== undefined && b.substituteOn !== p.substituteOn ? `ИИ-подмена для ${p.name}: ${b.substituteOn ? 'включена' : 'выключена'}` : `Персона ${p.name} изменена`, payload: { personaId: p.id, ...b } });
    return c.json(team.persona(p.id));
  });
  app.patch('/api/agents/:id', async (c) => {
    const a = team.agent(c.req.param('id')); const b = z.object({ status: z.enum(['idle', 'paused']).optional(), alias: z.string().min(1).optional(), model: z.string().nullable().optional(), reportsTo: z.string().nullable().optional() }).parse(await c.req.json());
    const { status, ...rest } = b;
    if (Object.keys(rest).length) { team.db.update('agents', a.id, rest); team.emit({ type: 'agent.updated', projectId: a.projectId, actor: OWNER, summary: `${a.alias}: ${Object.keys(rest).join(', ')}`, payload: rest }); }
    if (status === 'paused') { team.setAgentStatus(a.id, 'paused'); runtime.interrupt(a.id); }
    if (status === 'idle' && a.status === 'paused') team.setAgentStatus(a.id, 'idle');
    return c.json(team.agent(a.id));
  });
  app.post('/api/agents/:id/interrupt', (c) => { const a = team.agent(c.req.param('id')); runtime.interrupt(a.id); team.emit({ type: 'intervention.interrupt', projectId: a.projectId, actor: OWNER, summary: `Владелец прервал ход ${a.alias}`, payload: { agentId: a.id } }); return c.json({ ok: true }); });
  app.post('/api/agents/:id/note', async (c) => {
    const a = team.agent(c.req.param('id')); const b = z.object({ text: z.string().min(1), taskId: z.string().nullable().optional() }).parse(await c.req.json());
    team.emit({ type: 'intervention.note', projectId: a.projectId, actor: OWNER, taskId: b.taskId ?? null, summary: `Владелец → ${a.alias}: ${b.text.slice(0, 160)}`, payload: { agentId: a.id, text: b.text } });
    team.wake(a.id, 'owner_note', { text: b.text, taskId: b.taskId ?? null });
    return c.json({ ok: true });
  });
  app.get('/api/agents/:id/runs', (c) => c.json({ runs: team.db.all<AgentRun>('agent_runs', 'agent_id = ? ORDER BY started_at DESC LIMIT 50', c.req.param('id')) }));
  app.patch('/api/agents/:id/memory', async (c) => { const a = team.agent(c.req.param('id')); const b = z.object({ memory: z.string() }).parse(await c.req.json()); team.db.update('agents', a.id, { memory: b.memory }); team.emit({ type: 'memory.edited', projectId: a.projectId, actor: OWNER, summary: `Владелец поправил память ${a.alias}` }); return c.json({ ok: true }); });

  // ------------------------------------------------------------------ tasks
  app.post('/api/tasks', async (c) => {
    const b = z.object({ projectId: z.string(), title: z.string().min(1), description: z.string().optional(), parentId: z.string().nullable().optional(), dependsOn: z.array(z.string()).optional(), assigneeId: z.string().nullable().optional(), externalKey: z.string().nullable().optional(), priority: z.number().int().optional() }).parse(await c.req.json());
    return c.json(team.createTask(b, OWNER), 201);
  });
  app.patch('/api/tasks/:id', async (c) => {
    const b = z.object({ status: z.enum(TASK_STATUSES).optional(), note: z.string().optional(), assigneeId: z.string().nullable().optional(), takeOver: z.boolean().optional(), priority: z.number().int().optional(), title: z.string().optional(), description: z.string().optional() }).parse(await c.req.json());
    const t = team.task(c.req.param('id'));
    if (b.takeOver) team.takeOver(t.id);
    if (b.priority !== undefined || b.title !== undefined || b.description !== undefined) team.updateTask(t.id, { priority: b.priority, title: b.title, description: b.description }, OWNER);
    if (b.assigneeId) team.assignTask(t.id, b.assigneeId, OWNER);
    if (b.status === 'obsolete') team.markObsolete(t.id, b.note ?? 'решение владельца', OWNER);
    else if (b.status) team.setTaskStatus(t.id, b.status, OWNER, b.note);
    return c.json(team.task(t.id));
  });

  // ------------------------------------------------------------------ decisions
  app.post('/api/decisions/:id/classify', async (c) => c.json(team.decisions.classify(c.req.param('id'), z.object({ pivotal: z.boolean(), decider, klass: klass.optional(), note: z.string().optional(), chosen: z.string().optional(), comment: z.string().optional() }).parse(await c.req.json()))));
  app.post('/api/decisions/:id/override', async (c) => { const b = z.object({ chosen: z.string(), comment: z.string().optional() }).parse(await c.req.json()); return c.json(team.decisions.override(c.req.param('id'), b.chosen, b.comment)); });
  app.post('/api/decisions/:id/review', async (c) => { const b = z.object({ ok: z.boolean(), note: z.string().optional() }).parse(await c.req.json()); return c.json(team.decisions.review(c.req.param('id'), b.ok, b.note)); });
  app.post('/api/decisions/:id/cancel', async (c) => { const b = z.object({ reason: z.string().optional() }).parse(await c.req.json().catch(() => ({}))); return c.json(team.decisions.cancel(c.req.param('id'), OWNER, b.reason)); });
  app.post('/api/autonomy', async (c) => { const b = z.object({ roleId: z.string(), klass, level: z.number().int().min(1).max(3) }).parse(await c.req.json()); team.decisions.setLevel(b.roleId, b.klass, b.level); return c.json({ ok: true }); });

  // ------------------------------------------------------------------ gateway
  app.post('/api/messages/:id/approve', async (c) => { const b = z.object({ text: z.string().optional(), lesson: z.object({ scope, text: z.string().optional() }).optional() }).parse(await c.req.json().catch(() => ({}))); return c.json(await team.gateway.approve(c.req.param('id'), b)); });
  app.post('/api/messages/:id/reject', async (c) => { const b = z.object({ reason: z.string().min(1), lessonScope: scope.optional() }).parse(await c.req.json()); return c.json(team.gateway.reject(c.req.param('id'), b.reason, b.lessonScope)); });
  app.post('/api/contacts', async (c) => { const b = z.object({ agentId: z.string(), personaId: z.string(), status: z.enum(['approved', 'denied']) }).parse(await c.req.json()); team.gateway.setContact(b.agentId, b.personaId, b.status); return c.json({ ok: true }); });
  app.post('/api/lessons', async (c) => c.json(team.gateway.addLesson(z.object({ scope, scopeId: z.string().nullable().optional(), text: z.string().min(1) }).parse(await c.req.json())), 201));
  app.patch('/api/lessons/:id', async (c) => { team.gateway.updateLesson(c.req.param('id'), z.object({ text: z.string().min(1).optional(), active: z.boolean().optional() }).parse(await c.req.json())); return c.json({ ok: true }); });
  app.post('/api/approval-rules', async (c) => { const b = z.object({ kind: z.enum(['decision_package', 'question', 'status', 'qa_handoff', 'tracker']), personaId: z.string().default('*'), requireApproval: z.boolean() }).parse(await c.req.json()); team.gateway.setApprovalRule(b.kind, b.personaId, b.requireApproval); return c.json({ ok: true }); });

  // ------------------------------------------------------------------ executor
  app.post('/api/sync', async (c) => { await team.exec.sync(); return c.json({ ok: true }); });

  // ------------------------------------------------------------------ the simulated outside world (mock channel and tracker)
  app.post('/api/sim/reply', async (c) => { const b = z.object({ messageId: z.string(), text: z.string().min(1) }).parse(await c.req.json()); return c.json(team.gateway.receive({ replyTo: b.messageId, text: b.text })); });
  app.post('/api/sim/tracker', async (c) => {
    const b = z.object({ key: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/), title: z.string().min(1), description: z.string().optional(), projectId: z.string().optional() }).parse(await c.req.json());
    if (!(team.gateway.tracker instanceof MockTracker)) throw new TeamError('подключён настоящий трекер: задачи заводятся в нём');
    const issue = team.gateway.tracker.create({ key: b.key, project: b.key.split('-')[0]!, title: b.title, description: b.description });
    if (b.projectId) { const pm = team.pm(b.projectId); team.emit({ type: 'tracker.issue', projectId: b.projectId, actor: { kind: 'system' }, summary: `В трекере появилась задача ${b.key}: ${b.title}`, payload: { key: b.key } }); if (pm) team.wake(pm.id, 'external_issue', { key: b.key }); }
    return c.json(issue, 201);
  });

  // ------------------------------------------------------------------ static UI
  app.get('/*', (c) => {
    const rel = c.req.path === '/' ? 'index.html' : c.req.path.replace(/^\/+/, '');
    const file = path.join(UI_DIR, path.normalize(rel));
    const target = file.startsWith(UI_DIR) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(UI_DIR, 'index.html');
    if (!fs.existsSync(target)) return c.text('UI is not built', 404);
    return c.body(fs.readFileSync(target), 200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  });

  return app;
}
