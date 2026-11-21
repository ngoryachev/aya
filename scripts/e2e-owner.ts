// End-to-end run against a live aya server with real agents and a real executor. This script plays the owner
// (agrees with the agents' self-assessment, approves messages, edits the first one into a style lesson) and the
// outside world (experts and testers answer). Usage:
//   npx tsx scripts/e2e-owner.ts <base-url> <token> <repo-path> [minutes]
const [base, token, repoPath, minutes = '60'] = process.argv.slice(2);
if (!base || !token || !repoPath) { console.error('usage: e2e-owner <base-url> <token> <repo-path> [minutes]'); process.exit(1); }

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({})) as any;
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error ?? r.status}`);
  return j;
}
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await api('POST', '/personas', { name: 'Олег Петров', title: 'Архитектор платформы', expertise: 'Контракты CLI и API, совместимость, модель данных', address: '@oleg', classesRequired: ['api', 'data'], classesAdvisory: ['architecture'], notes: 'Предпочитает короткие сообщения.' });
await api('POST', '/personas', { name: 'Тестировщики', title: 'Канал тестирования', expertise: 'Приёмка готовых изменений', address: '#qa' });
const project = await api('POST', '/projects', {
  name: 'wc-lite', repoPath, executor: 'sdlc', pipeline: 'standard', trackerProject: 'DEMO', budgetUsd: 25,
  goal: 'В утилите wc-lite добавить флаг --lines: с ним утилита печатает число строк в файле вместо числа слов. Обновить README и тесты. Изменение маленькое: заведи его одной задачей.',
});
log('project', project.id);

let lastEvent = 0; let lessonMade = false; const replied = new Set<string>();
const deadline = Date.now() + Number(minutes) * 60_000;
for (;;) {
  const ev = await api('GET', `/events/history?project=${project.id}&since=${lastEvent}&limit=500`);
  for (const e of ev.events) { lastEvent = e.id; if (e.type !== 'agent.tool') log(`  [${e.type}] ${e.summary}`); }
  const s = await api('GET', `/state?project=${project.id}`);

  for (const c of s.contacts.filter((x: any) => x.status === 'pending')) { log('OWNER: approve contact', c.agentId, '→', c.personaId); await api('POST', '/contacts', { agentId: c.agentId, personaId: c.personaId, status: 'approved' }); }
  for (const m of s.messages.filter((x: any) => x.status === 'pending_approval')) {
    log('OWNER: message to approve:\n', m.draftText);
    if (!lessonMade && m.personaId) {
      lessonMade = true;
      const edited = m.draftText.replace(/^(?:[^\n.!?]*?(?:привет|здравствуй|добрый день|уважаем)[^\n.!?]*[.!?,]\s*)/i, '').trim() || m.draftText;
      await api('POST', `/messages/${m.id}/approve`, { text: edited, lesson: { scope: 'all', text: 'Без приветствий, обращений и благодарностей: сразу суть.' } });
      log('OWNER: approved with an edit and a lesson for all messages');
    } else { await api('POST', `/messages/${m.id}/approve`, {}); log('OWNER: approved as is'); }
  }
  for (const d of s.decisions.filter((x: any) => x.status === 'candidate')) {
    log(`OWNER: classify «${d.title}» [${d.klass}, ${d.reversible ? 'reversible' : 'irreversible'}, rec=${d.recommendation}, conf=${d.confidence}] proposed: pivotal=${d.proposedPivotal} decider=${JSON.stringify(d.proposedDecider)}\n   context: ${d.context.slice(0, 600)}\n   rationale: ${d.rationale.slice(0, 400)}`);
    const owner = d.proposedDecider.kind === 'owner';
    await api('POST', `/decisions/${d.id}/classify`, { pivotal: d.proposedPivotal, decider: d.proposedDecider, ...(owner ? { chosen: d.recommendation, comment: 'Согласен с рекомендацией.' } : {}) });
  }
  for (const d of s.decisions.filter((x: any) => x.status === 'awaiting' && x.decider?.kind === 'owner')) { log(`OWNER: decide «${d.title}» → ${d.recommendation}`); await api('POST', `/decisions/${d.id}/override`, { chosen: d.recommendation, comment: 'Согласен с рекомендацией.' }); }
  for (const d of s.decisions.filter((x: any) => x.status === 'resolved' && x.needsReview && !x.reviewed)) await api('POST', `/decisions/${d.id}/review`, { ok: true });
  // the outside world
  for (const m of s.messages.filter((x: any) => x.direction === 'out' && x.status === 'sent' && x.personaId && !replied.has(x.id))) {
    replied.add(m.id);
    const d = m.decisionId ? s.decisions.find((x: any) => x.id === m.decisionId) : null;
    const text = d && d.status === 'awaiting' ? `Вариант ${d.recommendation}. Согласен с рекомендацией.` : m.kind === 'qa_handoff' ? 'Проверили сборку, дефектов не нашли. Принято.' : 'Да, действуйте по своей рекомендации.';
    log(`WORLD: sent text was:\n ${m.finalText}\nWORLD: reply → ${text}`);
    await api('POST', '/sim/reply', { messageId: m.id, text });
  }

  const tasks = s.tasks as any[];
  const finished = tasks.length > 0 && tasks.every((t) => ['done', 'obsolete', 'cancelled'].includes(t.status));
  const idle = s.agents.every((a: any) => !a.running && !a.queued.length);
  if (finished && idle) { log('ALL TASKS DONE'); break; }
  if (Date.now() > deadline) { log('TIMEOUT'); break; }
  await sleep(6000);
}

const s = await api('GET', `/state?project=${project.id}`);
console.log('\n===== SUMMARY =====');
console.log('tasks:', s.tasks.map((t: any) => ({ title: t.title, status: t.status, assignee: s.agents.find((a: any) => a.id === t.assigneeId)?.alias, executor: t.executorRef, executorStatus: t.executorStatus, pr: t.prUrl, intake: t.intake?.ready })));
console.log('decisions:', s.decisions.map((d: any) => ({ title: d.title, klass: d.klass, source: d.source, status: d.status, chosen: d.chosen, rec: d.recommendation, by: d.resolvedBy, reinforcement: d.reinforcement })));
console.log('messages:', s.messages.map((m: any) => ({ dir: m.direction, kind: m.kind, status: m.status, edited: m.edited, text: (m.finalText ?? m.draftText).slice(0, 160) })));
console.log('lessons:', s.lessons.map((l: any) => ({ scope: l.scope, text: l.text })));
console.log('packages:', s.packages.map((p: any) => ({ title: p.title, status: p.status })));
console.log('agents:', s.agents.map((a: any) => ({ alias: a.alias, cost: a.costUsd.toFixed(2), memory: a.memory.slice(0, 200) })));
console.log('metrics:', s.metrics);
