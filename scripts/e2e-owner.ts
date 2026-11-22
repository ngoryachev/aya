// End-to-end run against a live aya server with real agents and a real executor. This script plays the owner
// (agrees with the agents' self-assessment, approves messages, edits the first one into a style lesson) and the
// outside world (experts and testers answer). Usage:
//   npx tsx scripts/e2e-owner.ts <base-url> <token> <repo-path> [minutes]
const [base, token, repoPath, minutes = '60'] = process.argv.slice(2);
if (!base || !token || !repoPath) { console.error('usage: e2e-owner <base-url> <token> <repo-path> [minutes]'); process.exit(1); }

async function api<T = any>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
  let r: Response;
  try { r = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch (e) { if (attempt >= 20) throw e; await new Promise((res) => setTimeout(res, 3000)); return api(method, path, body, attempt + 1); }   // the server is restarting
  const j = await r.json().catch(() => ({})) as any;
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error ?? r.status}`);
  return j;
}
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await api('POST', '/personas', { name: 'Олег Петров', title: 'Архитектор платформы', expertise: 'Контракты CLI и API, совместимость, модель данных', address: '@oleg', classesRequired: ['api', 'data'], classesAdvisory: ['architecture'], notes: 'Предпочитает короткие сообщения.', ...(process.env.AYA_E2E_SUBSTITUTE ? { substituteOn: true, substituteClasses: ['api', 'data', 'architecture'] } : {}) });
await api('POST', '/personas', { name: 'Тестировщики', title: 'Канал тестирования', expertise: 'Приёмка готовых изменений', address: '#qa' });
const project = await api('POST', '/projects', {
  name: 'wc-lite', repoPath, executor: 'sdlc', pipeline: 'standard', trackerProject: 'DEMO', budgetUsd: Number(process.env.AYA_E2E_BUDGET ?? 25), mergeBy: process.env.AYA_E2E_MERGE_BY === 'techlead' ? 'techlead' : 'owner',
  goal: process.env.AYA_E2E_GOAL ?? 'В утилите wc-lite добавить флаг --lines: с ним утилита печатает число строк в файле вместо числа слов. Обновить README и тесты. Изменение маленькое: заведи его одной задачей.',
});
log('project', project.id);
if (process.env.AYA_E2E_AUTONOMY) {
  // the owner trusts the tech lead with routine process decisions: stage 2, decided by the agent and shown for review
  const lead = (await api('GET', `/state?project=${project.id}`)).roles.find((r: any) => r.name === 'techlead');
  await api('POST', '/autonomy', { roleId: lead.id, klass: 'process', level: 2 });
  log('OWNER: autonomy stage 2 for the tech lead, class process');
}

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
      await api('POST', `/messages/${m.id}/approve`, { lesson: { scope: 'all', text: 'Обращайся на «ты». Сообщение не длиннее 700 знаков. Без приветствий и благодарностей.' } });
      log('OWNER: approved and added a style rule for all messages');
    } else { await api('POST', `/messages/${m.id}/approve`, {}); log('OWNER: approved as is'); }
  }
  for (const d of s.decisions.filter((x: any) => x.status === 'candidate')) {
    log(`OWNER: classify «${d.title}» [${d.klass}, ${d.reversible ? 'reversible' : 'irreversible'}, rec=${d.recommendation}, conf=${d.confidence}] proposed: pivotal=${d.proposedPivotal} decider=${JSON.stringify(d.proposedDecider)}\n   context: ${d.context.slice(0, 600)}\n   rationale: ${d.rationale.slice(0, 400)}`);
    const owner = d.proposedDecider.kind === 'owner';
    await api('POST', `/decisions/${d.id}/classify`, { pivotal: d.proposedPivotal, decider: d.proposedDecider, ...(owner ? { chosen: d.recommendation, comment: 'Согласен с рекомендацией.' } : {}) });
  }
  for (const d of s.decisions.filter((x: any) => x.status === 'awaiting' && x.decider?.kind === 'owner')) { log(`OWNER: decide «${d.title}» → ${d.recommendation}`); await api('POST', `/decisions/${d.id}/override`, { chosen: d.recommendation, comment: 'Согласен с рекомендацией.' }); }
  for (const d of s.decisions.filter((x: any) => x.status === 'resolved' && x.needsReview && !x.reviewed)) { log(`OWNER: review of a decision made without me: «${d.title}» → ${d.chosen}${d.bySubstitute ? ' (AI stand-in)' : ''}${d.classifiedBy === 'autonomy' ? ' (autonomy)' : ''}`); await api('POST', `/decisions/${d.id}/review`, { ok: true }); }
  // the outside world
  for (const m of s.messages.filter((x: any) => x.direction === 'out' && x.status === 'sent' && x.personaId && !replied.has(x.id))) {
    const d = m.decisionId ? s.decisions.find((x: any) => x.id === m.decisionId) : null;
    // a persona with an AI stand-in answers by itself: the human steps in only if it stays silent for a minute
    const per = s.personas.find((x: any) => x.id === m.personaId);
    if (per?.substituteOn && d && Date.now() - Date.parse(m.sentAt) < 60_000) continue;
    replied.add(m.id);
    if (d && d.status === 'resolved') { log(`WORLD: «${d.title}» was answered without a human (${d.bySubstitute ? 'AI stand-in' : d.resolvedBy})`); continue; }
    if (s.messages.some((x: any) => x.direction === 'in' && x.threadId === m.threadId && x.createdAt > m.sentAt)) continue;
    const text = d && d.status === 'awaiting' ? `Вариант ${d.recommendation}. Согласен с рекомендацией.` : m.kind === 'qa_handoff' ? 'Проверили сборку, дефектов не нашли. Принято.' : 'Да, действуйте по своей рекомендации.';
    log(`WORLD: sent text was:\n ${m.finalText}\nWORLD: reply → ${text}`);
    await api('POST', '/sim/reply', { messageId: m.id, text });
  }

  const tasks = s.tasks as any[];
  const finished = tasks.length > 0 && tasks.every((t) => ['obsolete', 'cancelled'].includes(t.status) || (t.status === 'done' && (project.mergeBy !== 'techlead' || t.merged || !t.executorRef)));
  const idle = s.agents.every((a: any) => !a.running && !a.queued.length);
  if (finished && idle) { log('ALL TASKS DONE'); break; }
  if (Date.now() > deadline) { log('TIMEOUT'); break; }
  await sleep(6000);
}

const s = await api('GET', `/state?project=${project.id}`);
console.log('\n===== SUMMARY =====');
console.log('tasks:', s.tasks.map((t: any) => ({ title: t.title, status: t.status, assignee: s.agents.find((a: any) => a.id === t.assigneeId)?.alias, executor: t.executorRef, executorStatus: t.executorStatus, pr: t.prUrl, intake: t.intake?.ready, branch: t.branch, stackedOn: s.tasks.find((x: any) => x.id === t.baseTaskId)?.title, merged: t.merged, dependsOn: t.dependsOn.map((id: string) => s.tasks.find((x: any) => x.id === id)?.title) })));
console.log('decisions:', s.decisions.map((d: any) => ({ title: d.title, klass: d.klass, source: d.source, status: d.status, chosen: d.chosen, rec: d.recommendation, by: d.resolvedBy, reinforcement: d.reinforcement, classifiedBy: d.classifiedBy, bySubstitute: d.bySubstitute, proposedBy: s.agents.find((a: any) => a.id === d.agentId)?.alias })));
console.log('messages:', s.messages.map((m: any) => ({ dir: m.direction, kind: m.kind, status: m.status, edited: m.edited, text: (m.finalText ?? m.draftText).slice(0, 160) })));
console.log('lessons:', s.lessons.map((l: any) => ({ scope: l.scope, text: l.text })));
console.log('packages:', s.packages.map((p: any) => ({ title: p.title, status: p.status })));
console.log('agents:', s.agents.map((a: any) => ({ alias: a.alias, cost: a.costUsd.toFixed(2), memory: a.memory.slice(0, 200) })));
console.log('metrics:', s.metrics);
