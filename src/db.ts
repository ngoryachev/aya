import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { customAlphabet } from 'nanoid';

const nano = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);
export const newId = (prefix: string) => `${prefix}_${nano()}`;
export const now = () => new Date().toISOString();

/** Append only: an existing entry is never edited. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, address TEXT, status TEXT NOT NULL);
  CREATE TABLE personas (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', expertise TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT 'mock', address TEXT NOT NULL DEFAULT '', timezone TEXT, response_hours REAL NOT NULL DEFAULT 24,
    contact_limit_per_week INTEGER, classes_required TEXT NOT NULL DEFAULT '[]', classes_advisory TEXT NOT NULL DEFAULT '[]',
    substitute_on INTEGER NOT NULL DEFAULT 0, substitute_classes TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '',
    is_owner INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE TABLE roles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, title TEXT NOT NULL, responsibilities TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL, tools TEXT NOT NULL DEFAULT '[]', model TEXT, can_decide TEXT NOT NULL DEFAULT '[]');
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', repo_path TEXT, executor TEXT NOT NULL DEFAULT 'sdlc',
    pipeline TEXT, tracker_project TEXT, policy TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', memory TEXT NOT NULL DEFAULT '',
    budget_usd REAL, created_at TEXT NOT NULL);
  CREATE TABLE agents (
    id TEXT PRIMARY KEY, alias TEXT NOT NULL, role_id TEXT NOT NULL, project_id TEXT NOT NULL, node_id TEXT NOT NULL,
    reports_to TEXT, model TEXT, status TEXT NOT NULL DEFAULT 'idle', session_id TEXT, memory TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open', assignee_id TEXT, created_by TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
    external_key TEXT, external_url TEXT, intake TEXT, executor_ref TEXT, executor_status TEXT, pr_url TEXT,
    obsolete_reason TEXT, package_id TEXT, taken_over INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE task_deps (task_id TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY (task_id, depends_on));
  CREATE TABLE decisions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT, agent_id TEXT NOT NULL, title TEXT NOT NULL, context TEXT NOT NULL DEFAULT '',
    options TEXT NOT NULL, recommendation TEXT NOT NULL, rationale TEXT NOT NULL DEFAULT '', klass TEXT NOT NULL, reversible INTEGER NOT NULL,
    importance TEXT NOT NULL, confidence REAL NOT NULL, proposed_pivotal INTEGER NOT NULL, proposed_decider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate', pivotal INTEGER, decider TEXT, classified_by TEXT, chosen TEXT, chosen_comment TEXT, resolved_by TEXT,
    by_substitute INTEGER NOT NULL DEFAULT 0, needs_review INTEGER NOT NULL DEFAULT 0, reviewed INTEGER NOT NULL DEFAULT 0,
    reinforcement TEXT NOT NULL DEFAULT '{}', source TEXT NOT NULL DEFAULT 'agent', source_ref TEXT,
    created_at TEXT NOT NULL, classified_at TEXT, resolved_at TEXT);
  CREATE TABLE autonomy (role_id TEXT NOT NULL, klass TEXT NOT NULL, level INTEGER NOT NULL, PRIMARY KEY (role_id, klass));
  CREATE TABLE contacts (agent_id TEXT NOT NULL, persona_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (agent_id, persona_id));
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, direction TEXT NOT NULL, channel TEXT NOT NULL, agent_id TEXT, persona_id TEXT, kind TEXT NOT NULL,
    thread_id TEXT, decision_id TEXT, task_id TEXT, draft_text TEXT NOT NULL, final_text TEXT, status TEXT NOT NULL, edited INTEGER NOT NULL DEFAULT 0,
    violations TEXT NOT NULL DEFAULT '[]', external_id TEXT, reject_reason TEXT, action TEXT, created_at TEXT NOT NULL, sent_at TEXT);
  CREATE TABLE style_lessons (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_id TEXT, text TEXT NOT NULL, source TEXT NOT NULL, before TEXT, after TEXT,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
  CREATE TABLE approval_rules (kind TEXT NOT NULL, persona_id TEXT NOT NULL, require_approval INTEGER NOT NULL, PRIMARY KEY (kind, persona_id));
  CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL, executor_ref TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '', payload TEXT, allowed TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open', decision_id TEXT,
    response TEXT, created_at TEXT NOT NULL);
  CREATE TABLE packages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, task_ids TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
  CREATE TABLE wakeups (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, reason TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'queued',
    error TEXT, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT);
  CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, wakeup_id TEXT NOT NULL, session_id TEXT, status TEXT NOT NULL, cost_usd REAL NOT NULL DEFAULT 0,
    turns INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', error TEXT, started_at TEXT NOT NULL, ended_at TEXT);
  CREATE TABLE tracker_issues (
    key TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'To Do',
    comments TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, project_id TEXT, type TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT,
    task_id TEXT, decision_id TEXT, summary TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE INDEX idx_tasks_project ON tasks(project_id);
  CREATE INDEX idx_decisions_status ON decisions(status);
  CREATE INDEX idx_wakeups_agent ON wakeups(agent_id, status);
  CREATE INDEX idx_events_project ON events(project_id, id);
  `,
  // stacked work: a task remembers its branch, the task whose branch it was started from, and whether that base moved since
  `
  ALTER TABLE tasks ADD COLUMN branch TEXT;
  ALTER TABLE tasks ADD COLUMN base_task_id TEXT;
  ALTER TABLE tasks ADD COLUMN stale_base INTEGER NOT NULL DEFAULT 0;
  `,
];

/** Columns stored as JSON text / as 0-1 integers, per table. Everything else is passed through. */
const JSON_COLS: Record<string, string[]> = {
  personas: ['classes_required', 'classes_advisory', 'substitute_classes'],
  roles: ['tools', 'can_decide'], projects: ['policy'], tasks: ['intake'],
  decisions: ['options', 'proposed_decider', 'decider', 'reinforcement'],
  messages: ['violations', 'action'], checkpoints: ['payload', 'allowed', 'response'],
  packages: ['task_ids'], wakeups: ['payload'], tracker_issues: ['comments'], events: ['payload'],
};
const BOOL_COLS: Record<string, string[]> = {
  personas: ['substitute_on', 'is_owner'], tasks: ['taken_over', 'stale_base'],
  decisions: ['reversible', 'proposed_pivotal', 'pivotal', 'by_substitute', 'needs_review', 'reviewed'],
  messages: ['edited'], style_lessons: ['active'], approval_rules: ['require_approval'],
};

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

type Row = Record<string, unknown>;
type SqlValue = string | number | bigint | null | Uint8Array;

export class Db {
  readonly raw: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate() {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)');
    const cur = (this.raw.prepare('SELECT MAX(v) v FROM schema_version').get() as { v: number | null }).v ?? 0;
    for (let i = cur; i < MIGRATIONS.length; i++) {
      this.raw.exec('BEGIN');
      try { this.raw.exec(MIGRATIONS[i]!); this.raw.prepare('INSERT INTO schema_version (v) VALUES (?)').run(i + 1); this.raw.exec('COMMIT'); }
      catch (e) { this.raw.exec('ROLLBACK'); throw e; }
    }
  }

  private enc(table: string, col: string, v: unknown): SqlValue {
    if (v === undefined || v === null) return null;
    if (JSON_COLS[table]?.includes(col)) return JSON.stringify(v);
    if (BOOL_COLS[table]?.includes(col)) return v ? 1 : 0;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v as SqlValue;
  }

  private dec<T>(table: string, row: Row | undefined): T | undefined {
    if (!row) return undefined;
    const out: Row = {};
    for (const [k, v] of Object.entries(row)) {
      let val: unknown = v;
      if (v !== null && JSON_COLS[table]?.includes(k)) { try { val = JSON.parse(v as string); } catch { val = null; } }
      else if (BOOL_COLS[table]?.includes(k)) val = v === null ? null : v === 1;
      out[camel(k)] = val;
    }
    return out as T;
  }

  insert<T extends object>(table: string, obj: T): T {
    const cols = Object.keys(obj).map(snake);
    const vals = Object.entries(obj).map(([k, v]) => this.enc(table, snake(k), v));
    this.raw.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
    return obj;
  }

  update(table: string, id: string, patch: object, idCol = 'id'): void {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (!entries.length) return;
    const sets = entries.map(([k]) => `${snake(k)} = ?`).join(', ');
    const vals = entries.map(([k, v]) => this.enc(table, snake(k), v));
    this.raw.prepare(`UPDATE ${table} SET ${sets} WHERE ${idCol} = ?`).run(...vals, id);
  }

  get<T>(table: string, id: string, idCol = 'id'): T | undefined {
    return this.dec<T>(table, this.raw.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ?`).get(id) as Row | undefined);
  }

  /** `where` is raw SQL after WHERE (or empty); rows come back decoded for `table`. */
  all<T>(table: string, where = '', ...params: SqlValue[]): T[] {
    const sql = `SELECT * FROM ${table}${where ? ` WHERE ${where}` : ''}`;
    return (this.raw.prepare(sql).all(...params) as Row[]).map((r) => this.dec<T>(table, r)!);
  }

  one<T>(table: string, where: string, ...params: SqlValue[]): T | undefined { return this.all<T>(table, `${where} LIMIT 1`, ...params)[0]; }

  query<T = Row>(sql: string, ...params: SqlValue[]): T[] { return this.raw.prepare(sql).all(...params) as T[]; }
  run(sql: string, ...params: SqlValue[]) { return this.raw.prepare(sql).run(...params); }

  setting(key: string): string | null { return (this.raw.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null; }
  setSetting(key: string, value: string) { this.raw.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); }

  close() { this.raw.close(); }
}
