import { describe, expect, it } from 'vitest';
import { makeTeam } from './fakes.js';
import { OwnerNotifier } from '../src/notify.js';
import { createPersona, createProject } from '../src/seed.js';

describe('owner notifications', () => {
  it('tell the owner only about what waits for them, gathered into one message', async () => {
    const c = makeTeam(); const sent: string[] = [];
    const n = new OwnerNotifier(c.team, { send: async (t) => { sent.push(t); } }, 'http://aya.test', 60_000);
    const p = createProject(c.team, { name: 'Демо', goal: 'x', executor: 'fake', start: false });
    const lead = c.team.lead(p.id)!; const per = createPersona(c.team, { name: 'Олег' });
    const ask = (klass: 'process' | 'api') => c.team.decisions.propose({ projectId: p.id, agentId: lead.id, title: `Вопрос ${klass}`, context: '', options: [{ key: 'A', label: 'а' }, { key: 'B', label: 'б' }], recommendation: 'A', rationale: '', klass, reversible: true, importance: 'low', confidence: 0.5, proposedPivotal: false, proposedDecider: { kind: 'self' } });

    c.team.decisions.setLevel(lead.roleId, 'process', 3);     // full autonomy, no spot check (random is fixed in the fakes)
    ask('process');                                           // decided without the owner: silence
    ask('api');                                               // waits for classification
    await c.team.gateway.submit({ agentId: lead.id, personaId: per.id, kind: 'question', text: 'Вопрос' });   // contact request
    c.team.gateway.setContact(lead.id, per.id, 'approved');   // …then the message waits for approval
    await new Promise((r) => setTimeout(r, 120));
    await n.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('aya · Демо');
    expect(sent[0]).toContain('Решение ждёт классификации: «Вопрос api» (Тимур)');
    expect(sent[0]).not.toContain('Вопрос process');
    expect(sent[0]).toContain('Тимур просит утвердить контакт с Олег');
    expect(sent[0]).toContain('Сообщение ждёт одобрения: Тимур → Олег');
    expect(sent[0]).toContain('http://aya.test/#decisions');

    c.team.decisions.setLevel(lead.roleId, 'process', 2);     // stage 2: decided by the agent, shown to the owner
    ask('process');
    await new Promise((r) => setTimeout(r, 120)); await n.flush();
    expect(sent[1]).toContain('Принято без тебя, посмотри');
  });
});
