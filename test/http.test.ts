import { describe, expect, it } from 'vitest';
import { makeTeam } from './fakes.js';
import { createHttpApp, ensureToken } from '../src/http.js';
import { createPersona } from '../src/seed.js';

function setup() {
  const c = makeTeam();
  const app = createHttpApp(c.team, c.runtime);
  const token = ensureToken(c.team);
  const call = async (method: string, path: string, body?: unknown, auth = true) => {
    const r = await app.request(`/api${path}`, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  };
  return { ...c, app, call, token };
}

describe('http', () => {
  it('refuses requests without the token', async () => {
    const { call } = setup();
    expect((await call('GET', '/state', undefined, false)).status).toBe(401);
    expect((await call('GET', '/health', undefined, false)).status).toBe(200);
  });

  it('drives a decision from the owner side: classify, then change it', async () => {
    const { call, team, runtime, runner } = setup();
    runner.scripts = {};
    const p = (await call('POST', '/projects', { name: 'Демо', goal: 'цель', executor: 'fake', start: false })).json;
    const state = (await call('GET', `/state?project=${p.id}`)).json;
    expect(state.agents.map((a: any) => a.alias)).toEqual(['Майя', 'Тимур', 'Артём', 'Даша', 'Дима']);
    const lead = team.lead(p.id)!;
    const d = team.decisions.propose({ projectId: p.id, agentId: lead.id, title: 'Кэш', context: 'нужен ли', options: [{ key: 'A', label: 'Да' }, { key: 'B', label: 'Нет' }], recommendation: 'A', rationale: '', klass: 'architecture', reversible: true, importance: 'low', confidence: 0.5, proposedPivotal: false, proposedDecider: { kind: 'self' } });
    const bad = await call('POST', `/decisions/${d.id}/classify`, { pivotal: true, decider: { kind: 'owner' }, chosen: 'Z' });
    expect(bad.status).toBe(400);
    const ok = await call('POST', `/decisions/${d.id}/classify`, { pivotal: true, decider: { kind: 'owner' }, chosen: 'B', comment: 'рано' });
    expect(ok.json).toMatchObject({ status: 'resolved', chosen: 'B' });
    expect(ok.json.reinforcement).toMatchObject({ pivotalMatch: false, deciderMatch: false, recommendationMatch: false });
    expect((await call('POST', `/decisions/${d.id}/override`, { chosen: 'A' })).json.chosen).toBe('A');
    await runtime.settle();
    const after = (await call('GET', `/state?project=${p.id}`)).json;
    expect(after.metrics.ownerActions).toBeGreaterThan(0);
    expect(after.autonomy.find((r: any) => r.klass === 'architecture')).toMatchObject({ classified: 1, matched: 0 });
  });

  it('plays the outside world: a tracker issue wakes the PM, a reply reaches the thread', async () => {
    const { call, team, runtime, runner } = setup();
    const seen: string[] = [];
    runner.scripts = { pm: async (w) => { seen.push(w.reason); } };
    const p = (await call('POST', '/projects', { name: 'Демо', goal: 'цель', executor: 'fake', start: false })).json;
    expect((await call('POST', '/sim/tracker', { key: 'demo-1', title: 'x', projectId: p.id })).status).toBe(400);
    expect((await call('POST', '/sim/tracker', { key: 'DEMO-1', title: 'Экспорт', description: 'CSV', projectId: p.id })).status).toBe(201);
    await runtime.settle();
    expect(seen).toEqual(['external_issue']);

    const per = createPersona(team, { name: 'Ира' });
    const pm = team.pm(p.id)!;
    team.gateway.setContact(pm.id, per.id, 'approved');
    const m = await team.gateway.submit({ agentId: pm.id, personaId: per.id, kind: 'question', text: 'Нужен ли экспорт в XLSX?' });
    const sent = (await call('POST', `/messages/${m.id}/approve`, { text: 'Ира, нужен ли экспорт в XLSX?', lesson: { scope: 'all', text: 'Обращайся по имени.' } })).json;
    expect(sent.status).toBe('sent');
    expect((await call('GET', '/state')).json.lessons).toHaveLength(1);
    expect((await call('POST', '/sim/reply', { messageId: m.id, text: 'Нет, CSV хватит' })).status).toBe(200);
    await runtime.settle();
    expect(seen).toEqual(['external_issue', 'message_reply']);
  });

  it('pauses an agent and holds its work', async () => {
    const { call, team, runtime, runner } = setup();
    let turns = 0; runner.scripts = { pm: async () => { turns++; } };
    const p = (await call('POST', '/projects', { name: 'Демо', goal: 'цель', executor: 'fake', start: false })).json;
    const pm = team.pm(p.id)!;
    await call('PATCH', `/agents/${pm.id}`, { status: 'paused' });
    await call('POST', `/agents/${pm.id}/note`, { text: 'Посмотри приоритеты' });
    await runtime.settle();
    expect(turns).toBe(0);
    await call('PATCH', `/agents/${pm.id}`, { status: 'idle' });
    await runtime.settle();
    expect(turns).toBe(1);
  });
});
