import { newId, now } from './db.js';
import type { Agent, DecisionClass, Node, Persona, Project, Role } from './types.js';
import { OWNER, TeamError, type Team } from './team.js';

const ROLES: (Omit<Role, 'id' | 'tools' | 'model'>)[] = [
  { name: 'pm', title: 'ПМ', prompt: 'pm.md', responsibilities: 'Отвечает за продукт: что делаем и в каком порядке. Ведёт задачи, связь с трекером компании, пакеты для тестировщиков.', canDecide: ['process'] },
  { name: 'techlead', title: 'Техлид', prompt: 'techlead.md', responsibilities: 'Решает, кто и как делает задачу. Отвечает на чекпоинты исполнителя, принимает технические решения внутри задачи.', canDecide: ['process', 'api', 'architecture'] },
  { name: 'architect', title: 'Архитектор', prompt: 'architect.md', responsibilities: 'Отвечает за решения, общие для многих задач: структура, контракты, модель данных, выбор технологий.', canDecide: ['architecture', 'api', 'data', 'infra'] },
  { name: 'developer', title: 'Разработчик', prompt: 'developer.md', responsibilities: 'Фулстек. Ведёт задачу от входного контроля до передачи исполнителю и следит за результатом.', canDecide: [] },
];

/** Built-in roles, the local node and the owner's card. Safe to call on every start. */
export function ensureBasics(team: Team, ownerName = 'Владелец') {
  const { db } = team;
  for (const r of ROLES) if (!db.one<Role>('roles', 'name = ?', r.name)) db.insert('roles', { id: newId('role'), ...r, tools: [], model: null } satisfies Role);
  if (!db.one<Node>('nodes', "kind = 'local'")) db.insert('nodes', { id: 'local', name: 'Основной узел', kind: 'local', address: null, status: 'online' } satisfies Node);
  if (!team.owner()) createPersona(team, { name: ownerName, title: 'Владелец', expertise: 'Все решения, которые не закрыты экспертами', isOwner: true });
}

export function createPersona(team: Team, input: Partial<Persona> & { name: string }): Persona {
  const p: Persona = {
    id: newId('per'), name: input.name.trim(), title: input.title ?? '', expertise: input.expertise ?? '', channel: input.channel ?? 'mock', address: input.address ?? '',
    timezone: input.timezone ?? null, responseHours: input.responseHours ?? 24, contactLimitPerWeek: input.contactLimitPerWeek ?? null,
    classesRequired: (input.classesRequired ?? []) as DecisionClass[], classesAdvisory: (input.classesAdvisory ?? []) as DecisionClass[],
    substituteOn: input.substituteOn ?? false, substituteClasses: (input.substituteClasses ?? []) as DecisionClass[], notes: input.notes ?? '', isOwner: input.isOwner ?? false, createdAt: now(),
  };
  if (!p.name) throw new TeamError('у персоны должно быть имя');
  team.db.insert('personas', p);
  team.emit({ type: 'persona.created', actor: OWNER, summary: `Персона: ${p.name}${p.title ? `, ${p.title}` : ''}`, payload: { personaId: p.id } });
  return p;
}

const DEFAULT_TEAM: { alias: string; role: string; boss?: string }[] = [
  { alias: 'Майя', role: 'pm' },
  { alias: 'Тимур', role: 'techlead' },
  { alias: 'Артём', role: 'architect' },
  { alias: 'Даша', role: 'developer', boss: 'Тимур' },
  { alias: 'Дима', role: 'developer', boss: 'Тимур' },
];

export interface ProjectInput {
  name: string; goal: string; repoPath?: string | null; executor?: string; pipeline?: string | null; trackerProject?: string | null;
  budgetUsd?: number | null; mergeBy?: 'owner' | 'techlead'; team?: { alias: string; role: string; boss?: string }[]; start?: boolean;
}

/** A project with its team: PM, tech lead, architect, two developers of one full-stack role. */
export function createProject(team: Team, input: ProjectInput): Project {
  ensureBasics(team);
  const p: Project = {
    id: newId('prj'), name: input.name.trim(), goal: input.goal, repoPath: input.repoPath ?? null, executor: input.executor ?? 'sdlc', pipeline: input.pipeline ?? null,
    trackerProject: input.trackerProject ?? null, policy: { denyPatterns: [], maxChars: 4000, allowCode: false }, status: 'active', memory: '', budgetUsd: input.budgetUsd ?? null, createdAt: now(), mergeBy: input.mergeBy ?? 'owner',
  };
  if (!p.name) throw new TeamError('у проекта должно быть название');
  team.db.insert('projects', p);
  team.emit({ type: 'project.created', projectId: p.id, actor: OWNER, summary: `Проект «${p.name}»`, payload: { goal: p.goal } });
  const byAlias = new Map<string, string>();
  for (const m of input.team ?? DEFAULT_TEAM) {
    const role = team.db.one<Role>('roles', 'name = ?', m.role); if (!role) throw new TeamError(`роль ${m.role} не найдена`);
    const a: Agent = { id: newId('a'), alias: m.alias, roleId: role.id, projectId: p.id, nodeId: 'local', reportsTo: m.boss ? byAlias.get(m.boss) ?? null : null, model: null, status: 'idle', sessionId: null, memory: '', createdAt: now() };
    team.db.insert('agents', a); byAlias.set(m.alias, a.id);
    team.emit({ type: 'agent.created', projectId: p.id, actor: OWNER, summary: `${a.alias}, ${role.title}`, payload: { agentId: a.id, role: role.name } });
  }
  if (input.start !== false) { const pm = team.pm(p.id); if (pm) team.wake(pm.id, 'project_started', {}); }
  return p;
}
