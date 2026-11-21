// A playable demo without Claude and without sdlc: scripted agents and a fake executor behind the real server and UI.
//   npx tsx scripts/demo.ts [port]
import { serve } from '@hono/node-server';
import { makeTeam, type Script } from '../test/fakes.js';
import { createHttpApp, ensureToken } from '../src/http.js';
import { createPersona, createProject } from '../src/seed.js';

const c = makeTeam();
const port = Number(process.argv[2] ?? 7460);
const self = { klass: 'process', reversible: true, importance: 'low', confidence: 0.85, proposed_pivotal: false, proposed_decider: { kind: 'self' } };

const pm: Script = async (w, call) => {
  if (w.reason === 'project_started') {
    const a = await call('task_create', { title: 'Модель данных заказов', description: 'Спроектировать хранение заказов и позиций. Критерий готовности: миграция и тесты.' });
    const b = await call('task_create', { title: 'API заказов', description: 'Эндпоинты создания и чтения заказа.', depends_on: [a.id] });
    await call('task_create', { title: 'Экспорт заказов в CSV', description: 'Выгрузка за период.', depends_on: [b.id] });
  }
  if (w.reason === 'external_issue') await call('task_create', { title: `Задача из трекера ${w.payload.key}`, description: 'Перенесена из трекера компании.', external_key: w.payload.key });
  if (w.reason === 'tasks_to_package') {
    const ready = (await call('task_list', { status: 'verify' })).filter((t: any) => !t.package);
    if (!ready.length) return;
    const p = await call('package_create', { title: 'Заказы: модель и API', task_ids: ready.map((t: any) => t.id), notes: 'Проверить создание и чтение заказа.' });
    const s = await call('style_guide', { persona: 'Тестировщики' });
    await call('message_send', { persona: 'Тестировщики', kind: 'qa_handoff', text: `Добрый день! Готов пакет «Заказы: модель и API». PR: ${ready.map((t: any) => t.pr_url).join(', ')}. Просим проверить создание и чтение заказа.`, style_version: s.style_version });
    await call('package_mark_sent', { package_id: p.package_id });
  }
  if (w.reason === 'message_reply') { const pk = c.db.query<{ id: string }>("SELECT id FROM packages WHERE status = 'sent'")[0]; if (pk) await call('package_result', { package_id: pk.id, passed: true, notes: 'Тестировщики подтвердили.' }); }
};
const techlead: Script = async (w, call) => {
  if (w.reason === 'tasks_to_assign') { let i = 0; for (const t of await call('task_list', { status: 'open' })) if (t.ready && !t.assignee) await call('task_assign', { task_id: t.id, assignee: i++ % 2 ? 'Дима' : 'Даша' }); }
  if (w.reason === 'checkpoint') await call('checkpoint_answer', { checkpoint_id: w.payload.checkpointId, decision: 'approve', comment: 'План покрывает задачу, лишнего нет.', rationale: 'План соответствует описанию задачи и принятому решению по формату идентификаторов.', ...self });
};
const developer: Script = async (w, call) => {
  if (w.reason === 'task_assigned') {
    const t = await call('task_get', { task_id: w.payload.taskId });
    if (t.title.startsWith('Модель данных')) {
      await call('task_intake', { task_id: t.id, ready: false, gaps: [{ what: 'Формат идентификаторов заказа', resolution: 'human', note: 'От него зависит схема и публичный API' }, { what: 'Какая СУБД в проекте', resolution: 'self', note: 'Посмотрел в репозитории: PostgreSQL' }] });
      await call('decision_propose', { title: 'Формат идентификаторов заказа', context: 'Проектируем модель заказов. Идентификатор попадёт в публичный API и в ссылки. Поменять его после запуска дорого.', options: [{ key: 'A', label: 'UUID v7', consequences: 'Не раскрывает число заказов, генерируется на клиенте. Длиннее в ссылках.' }, { key: 'B', label: 'Числовой автоинкремент', consequences: 'Короткий и привычный. Раскрывает объём заказов, привязан к базе.' }], recommendation: 'A', rationale: 'Идентификатор публичный, а объём заказов раскрывать не хочется.', task_id: t.id, klass: 'api', reversible: false, importance: 'high', confidence: 0.65, proposed_pivotal: true, proposed_decider: { kind: 'persona', name: 'Олег' } });
      return;
    }
    await call('task_intake', { task_id: t.id, ready: true, gaps: [] });
    await call('executor_start', { task_id: t.id, prompt: t.description });
  }
  if (w.reason === 'decision_send_package') {
    const s = await call('style_guide', { persona: 'Олег' });
    await call('message_send', { persona: 'Олег', kind: 'decision_package', decision_id: w.payload.decisionId, style_version: s.style_version, text: 'Уважаемый Олег! Просим вас помочь с выбором формата идентификаторов заказа. Вариант A: UUID v7 (не раскрывает объём, длиннее в ссылках). Вариант B: числовой автоинкремент (короткий, раскрывает объём). Мы рекомендуем A. Ответьте, пожалуйста, ключом варианта и комментарием до конца дня.' });
  }
  if (w.reason === 'decision_resolved') {
    const d = await call('decision_get', { decision_id: w.payload.decisionId });
    if (!d.task) return;
    const t = await call('task_get', { task_id: d.task });
    if (t.executor) return;
    await call('task_intake', { task_id: d.task, ready: true, gaps: [] });
    await call('executor_start', { task_id: d.task, prompt: `${t.description}\nФормат идентификаторов: вариант ${d.chosen}.` });
  }
};
c.runner.scripts = { pm, techlead, developer };

createPersona(c.team, { name: 'Олег Петров', title: 'Архитектор платформы', expertise: 'Контракты API, модель данных, интеграции', address: '@oleg', classesRequired: ['api', 'data'], classesAdvisory: ['architecture'], responseHours: 24, notes: 'Предпочитает короткие сообщения на «ты».' });
createPersona(c.team, { name: 'Тестировщики', title: 'Канал тестирования', expertise: 'Приёмка готовых изменений', address: '#qa-orders' });
createPersona(c.team, { name: 'Анна Соколова', title: 'Дизайнер продукта', expertise: 'Интерфейс, тексты, сценарии', address: '@anna', classesAdvisory: ['product'] });
(c.team.gateway.tracker as any).create({ key: 'DEMO-7', project: 'DEMO', title: 'Заказы: первая версия', description: 'Нужны хранение, API и выгрузка заказов.' });
createProject(c.team, { name: 'Сервис заказов', goal: 'Сделать первую версию сервиса заказов: модель данных, API и выгрузку в CSV.', repoPath: process.cwd(), executor: 'fake', trackerProject: 'DEMO' });
c.team.exec.startTicker(1500);

serve({ fetch: createHttpApp(c.team, c.runtime).fetch, port, hostname: '127.0.0.1' }, () => console.log(`demo: http://127.0.0.1:${port}/?t=${ensureToken(c.team)}`));
