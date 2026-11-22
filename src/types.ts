/** Domain types of the team layer. Field names are camelCase here and snake_case in SQLite (see db.ts). */

export const DECISION_CLASSES = ['architecture', 'data', 'api', 'product', 'security', 'infra', 'process'] as const;
export type DecisionClass = typeof DECISION_CLASSES[number];
export const CLASS_TITLES: Record<DecisionClass, string> = {
  architecture: 'Архитектура', data: 'Данные', api: 'Контракты и API', product: 'Продукт и интерфейс',
  security: 'Безопасность', infra: 'Инфраструктура и релизы', process: 'Процесс',
};

export interface Node { id: string; name: string; kind: 'local' | 'remote'; address: string | null; status: 'online' | 'offline' }

export interface Persona {
  id: string; name: string; title: string; expertise: string;
  channel: string; address: string; timezone: string | null;
  /** After this many hours without a reply the decision goes up to the owner. */
  responseHours: number;
  contactLimitPerWeek: number | null;
  /** Decision classes where this person's answer is binding / only advice. */
  classesRequired: DecisionClass[]; classesAdvisory: DecisionClass[];
  /** AI stand-in, switched on by the owner by hand, allowed for the listed classes only. */
  substituteOn: boolean; substituteClasses: DecisionClass[];
  notes: string; isOwner: boolean; createdAt: string;
}

export interface Role {
  id: string; name: string; title: string; responsibilities: string;
  /** Path of the prompt file (relative to prompts/) or inline text. */
  prompt: string; tools: string[]; model: string | null;
  /** Classes this role may decide when the owner routes a decision to it. */
  canDecide: DecisionClass[];
}

export type AgentStatus = 'idle' | 'working' | 'paused';
export interface Agent {
  id: string; alias: string; roleId: string; projectId: string; nodeId: string;
  /** Agent id of the superior; null means the owner. */
  reportsTo: string | null; model: string | null; status: AgentStatus;
  sessionId: string | null; memory: string; createdAt: string;
}

export interface ContentPolicy { denyPatterns: string[]; maxChars: number; allowCode: boolean }
export interface Project {
  id: string; name: string; goal: string; repoPath: string | null;
  executor: string; pipeline: string | null; trackerProject: string | null;
  policy: ContentPolicy; status: 'active' | 'paused'; memory: string;
  budgetUsd: number | null; createdAt: string;
  /** Who merges accepted work: the owner, or the tech lead when the owner delegated it. */
  mergeBy: 'owner' | 'techlead';
}

export const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'verify', 'done', 'cancelled', 'obsolete'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export interface IntakeGap { what: string; resolution: 'self' | 'human'; note?: string }
export interface Task {
  id: string; projectId: string; parentId: string | null; title: string; description: string;
  status: TaskStatus; assigneeId: string | null; createdBy: string; priority: number;
  externalKey: string | null; externalUrl: string | null;
  intake: { ready: boolean; gaps: IntakeGap[]; at: string } | null;
  executorRef: string | null; executorStatus: string | null; prUrl: string | null;
  obsoleteReason: string | null; packageId: string | null; takenOver: boolean;
  /** The executor's branch with this task's work. */
  branch: string | null;
  /** The unfinished dependency whose branch this task was started from (stacked work). */
  baseTaskId: string | null;
  /** The base went back to rework after this task was started from it: the work must be brought up to date. */
  staleBase: boolean;
  /** The work is merged into the branch it was based on. */
  merged: boolean;
  createdAt: string; updatedAt: string;
}

export interface DecisionOption { key: string; label: string; consequences?: string }
export type DeciderKind = 'self' | 'agent' | 'persona' | 'owner';
export interface Decider { kind: DeciderKind; id?: string | null }
export type DecisionStatus = 'candidate' | 'awaiting' | 'resolved' | 'cancelled';
export interface Reinforcement {
  pivotalMatch?: boolean; deciderMatch?: boolean; classMatch?: boolean; recommendationMatch?: boolean;
  ownerNote?: string; overridden?: boolean;
}
export interface Decision {
  id: string; projectId: string; taskId: string | null; agentId: string;
  title: string; context: string; options: DecisionOption[];
  // the agent's self-assessment and the auto contour's proposal
  recommendation: string; rationale: string; klass: DecisionClass; reversible: boolean;
  importance: 'low' | 'medium' | 'high'; confidence: number;
  proposedPivotal: boolean; proposedDecider: Decider;
  // what actually happened
  status: DecisionStatus; pivotal: boolean | null; decider: Decider | null;
  classifiedBy: 'owner' | 'autonomy' | null;
  chosen: string | null; chosenComment: string | null; resolvedBy: string | null;
  bySubstitute: boolean; needsReview: boolean; reviewed: boolean;
  reinforcement: Reinforcement;
  source: 'agent' | 'checkpoint' | 'intake' | 'obsolete'; sourceRef: string | null;
  createdAt: string; classifiedAt: string | null; resolvedAt: string | null;
}

export type MessageKind = 'decision_package' | 'question' | 'status' | 'qa_handoff' | 'tracker';
export type MessageStatus = 'pending_contact' | 'pending_approval' | 'sent' | 'blocked' | 'rejected' | 'received';
export interface Message {
  id: string; projectId: string; direction: 'out' | 'in'; channel: string;
  agentId: string | null; personaId: string | null; kind: MessageKind;
  threadId: string | null; decisionId: string | null; taskId: string | null;
  draftText: string; finalText: string | null; status: MessageStatus; edited: boolean;
  violations: string[]; externalId: string | null; rejectReason: string | null;
  /** tracker writes: what to do on the outside when the message is sent */
  action: { type: 'tracker_update'; key: string; status?: string; comment?: string } | null;
  createdAt: string; sentAt: string | null;
}

export interface StyleLesson {
  id: string; scope: 'all' | 'role' | 'persona'; scopeId: string | null;
  text: string; source: 'edit' | 'rule' | 'reject'; before: string | null; after: string | null;
  active: boolean; createdAt: string;
}

export interface Contact { agentId: string; personaId: string; status: 'pending' | 'approved' | 'denied'; createdAt: string }

export interface Checkpoint {
  id: string; projectId: string; taskId: string; executorRef: string; kind: string; title: string; summary: string;
  payload: unknown; allowed: string[]; status: 'open' | 'proposed' | 'answered' | 'gone';
  decisionId: string | null; response: unknown; createdAt: string;
}

export interface Package {
  id: string; projectId: string; title: string; taskIds: string[];
  status: 'open' | 'sent' | 'passed' | 'failed'; notes: string; createdAt: string;
}

export interface Wakeup {
  id: string; agentId: string; reason: string; payload: Record<string, unknown>;
  status: 'queued' | 'running' | 'done' | 'failed' | 'dropped'; error: string | null; createdAt: string; startedAt: string | null; endedAt: string | null;
}

export interface AgentRun {
  id: string; agentId: string; wakeupId: string; sessionId: string | null; status: 'running' | 'done' | 'failed' | 'aborted';
  costUsd: number; turns: number; summary: string; error: string | null; startedAt: string; endedAt: string | null;
}

export interface TrackerIssue {
  key: string; project: string; title: string; description: string; status: string;
  comments: { at: string; author: string; text: string }[]; createdAt: string; updatedAt: string;
}

export interface TeamEvent {
  id: number; ts: string; projectId: string | null; type: string;
  actorKind: 'agent' | 'owner' | 'persona' | 'system'; actorId: string | null;
  taskId: string | null; decisionId: string | null; summary: string; payload: Record<string, unknown>;
}
