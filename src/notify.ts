import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import type { TeamEvent } from './types.js';
import type { Team } from './team.js';

/** Where the owner is told that something needs them. */
export interface NotifyTarget { send(text: string): Promise<void> }

export class TelegramTarget implements NotifyTarget {
  constructor(private token: string, private chatId: string) {}

  /** The bot the local sdlc server already uses: its token and chat. One-way sends only, so the two do not interfere. */
  static fromSdlc(home = process.env.SDLC_HOME ?? path.join(os.homedir(), '.sdlc')): TelegramTarget {
    const cfgFile = path.join(home, 'config.yaml'); const envFile = path.join(home, 'env');
    const cfg = (fs.existsSync(cfgFile) ? YAML.parse(fs.readFileSync(cfgFile, 'utf8')) : {}) as { telegram?: { bot_token?: string; chat_id?: string | number } };
    const fromEnv = fs.existsSync(envFile) ? /^SDLC_TELEGRAM_TOKEN=(.+)$/m.exec(fs.readFileSync(envFile, 'utf8'))?.[1]?.trim().replace(/^["']|["']$/g, '') : undefined;
    const token = fromEnv ?? cfg.telegram?.bot_token; const chat = cfg.telegram?.chat_id;
    if (!token || !chat) throw new Error('sdlc has no Telegram bot configured (token or chat_id is missing)');
    return new TelegramTarget(token, String(chat));
  }

  async send(text: string) {
    const r = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: this.chatId, text: text.slice(0, 3900), disable_web_page_preview: true }), signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`telegram: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
}

/**
 * Tells the owner, outside the console, about what waits for them: decisions to classify or make, messages and
 * contacts to approve, blocked work, and a few milestones. Events are gathered for a few seconds into one message.
 */
export class OwnerNotifier {
  private lines = new Map<string, string[]>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private team: Team, private target: NotifyTarget, private publicUrl: string, private delayMs = 5000) { team.onEvent((e) => this.onEvent(e)); }

  private line(e: TeamEvent): { text: string; page: string } | null {
    const p = e.payload as Record<string, any>;
    switch (e.type) {
      case 'decision.candidate': return null;   // decided below, once autonomy had its say
      case 'decision.classified': { if (!e.decisionId) return null; const d = this.team.decisions.get(e.decisionId); return d.status === 'awaiting' && d.decider?.kind === 'owner' ? { text: `Решение ждёт твоего выбора: «${d.title}»`, page: 'decisions' } : null; }
      case 'decision.resolved': { if (!e.decisionId) return null; const d = this.team.decisions.get(e.decisionId); return d.needsReview && !d.reviewed ? { text: `Принято без тебя, посмотри: ${e.summary}`, page: 'decisions' } : null; }
      case 'decision.escalated': case 'decision.reply_unparsed': return { text: e.summary, page: 'decisions' };
      case 'gateway.approval_needed': { const m = this.team.gateway.message(p.messageId); const who = m.agentId ? this.team.agent(m.agentId).alias : ''; const to = m.personaId ? this.team.persona(m.personaId).name : m.action ? `трекер ${m.action.key}` : ''; return { text: `Сообщение ждёт одобрения: ${who} → ${to}`, page: 'messages' }; }
      case 'gateway.contact_requested': return { text: e.summary, page: 'messages' };
      case 'task.status': return p.to === 'blocked' ? { text: `Задача заблокирована: ${e.summary}`, page: 'tasks' } : null;
      case 'runtime.budget_exhausted': case 'runtime.rate_limited': case 'agent.run_failed': return { text: e.summary, page: 'team' };
      case 'package.result': case 'task.merged': return { text: e.summary, page: 'tasks' };
      default: return null;
    }
  }

  private onEvent(e: TeamEvent) {
    if (e.type === 'decision.candidate' && e.decisionId) {
      // autonomy may classify it right away; the owner is told only about what really waits for them
      const id = e.decisionId;
      setTimeout(() => { try { const d = this.team.decisions.get(id); if (d.status === 'candidate') this.push(e.projectId, `Решение ждёт классификации: «${d.title}» (${this.team.agent(d.agentId).alias})`, 'decisions'); } catch { /* gone */ } }, 50).unref();
      return;
    }
    let l: { text: string; page: string } | null = null;
    try { l = this.line(e); } catch { /* a notification must never break the change */ }
    if (l) this.push(e.projectId, l.text, l.page);
  }

  private push(projectId: string | null, text: string, page: string) {
    const key = projectId ?? '';
    const list = this.lines.get(key) ?? []; list.push(`• ${text}\n  ${this.publicUrl}/#${page}`); this.lines.set(key, list);
    if (!this.timer) { this.timer = setTimeout(() => { void this.flush(); }, this.delayMs); this.timer.unref(); }
  }

  async flush() {
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    const batches = [...this.lines.entries()]; this.lines.clear();
    for (const [projectId, list] of batches) {
      const name = projectId ? this.team.db.get<{ name: string }>('projects', projectId)?.name : null;
      try { await this.target.send(`aya${name ? ` · ${name}` : ''}\n${list.join('\n')}`); }
      catch (e) { console.error('[aya] notification failed:', e instanceof Error ? e.message : e); }
    }
  }
}
