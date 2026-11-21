// aya: the owner's console. No build step: plain DOM, one state read, live refresh over SSE.

let S = null;                       // the last /api/state
let route = location.hash.slice(1) || 'overview';
let feed = [];                      // events for the feed page
let dirty = false;                  // the owner is typing: do not redraw under their hands

const $ = (sel) => document.querySelector(sel);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'open') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

function toast(text, err) { const t = $('#toast'); t.textContent = text; t.className = err ? 'err' : ''; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, err ? 6000 : 2200); }

async function api(method, path, body) {
  const r = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { toast(j.error || `${r.status}`, true); throw new Error(j.error || r.status); }
  return j;
}
/** Run an action, then reload the state whatever the focus is. */
async function act(method, path, body, okText) { await api(method, path, body); dirty = false; if (okText) toast(okText); await load(true); }

const projectQuery = () => (S && S.projectId ? `?project=${S.projectId}` : '');
async function load(force) {
  const chosen = localStorage.getItem('aya.project');
  S = await api('GET', `/state${chosen ? `?project=${chosen}` : ''}`);
  if (force || !dirty) render();
  else if (!$('#stale')) $('#top').append(h('button', { id: 'stale', class: 'primary', onclick: () => { dirty = false; load(true); } }, 'Есть обновления: показать'));
}

// ------------------------------------------------------------------ helpers
const agent = (id) => S.agents?.find((a) => a.id === id);
const role = (id) => S.roles.find((r) => r.id === id);
const persona = (id) => S.personas.find((p) => p.id === id);
const task = (id) => S.tasks?.find((t) => t.id === id);
const agentName = (id) => { const a = agent(id); return a ? `${a.alias} · ${role(a.roleId)?.title ?? ''}` : id; };
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }) : '');
const date = (iso) => (iso ? new Date(iso).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const STATUS_RU = { open: 'открыта', in_progress: 'в работе', blocked: 'заблокирована', verify: 'на приёмке', done: 'готова', cancelled: 'отменена', obsolete: 'неактуальна' };
const STATUS_CHIP = { in_progress: 'acc', blocked: 'bad', verify: 'warn', done: 'ok' };
const KIND_RU = { decision_package: 'пакет решения', question: 'вопрос', status: 'статус', qa_handoff: 'передача тестировщикам', tracker: 'запись в трекер' };
const MSG_RU = { pending_contact: 'ждёт утверждения контакта', pending_approval: 'ждёт одобрения', sent: 'отправлено', blocked: 'остановлено политикой', rejected: 'отклонено', received: 'получено' };
const IMPORTANCE_RU = { low: 'низкая', medium: 'средняя', high: 'высокая' };
const SCOPE_RU = { all: 'все сообщения', role: 'роль', persona: 'адресат' };

function deciderName(d, who) {
  if (!who) return '—';
  if (who.kind === 'self') return `сам ${agent(d.agentId)?.alias ?? 'агент'}`;
  if (who.kind === 'agent') return agentName(who.id);
  if (who.kind === 'persona') return persona(who.id)?.name ?? who.id;
  return 'владелец';
}
const optionLabel = (d, key) => { const o = d.options.find((x) => x.key === key); return o ? `${o.key}: ${o.label}` : key; };
const section = (title, count, ...kids) => [h('h2', {}, title, count != null ? h('span', { class: 'count' }, count) : null), ...kids];
const empty = (text) => h('div', { class: 'empty' }, text);
const field = (label, control) => h('div', {}, h('label', {}, label), control);
const watch = (el) => { el.addEventListener('input', () => { dirty = true; }); return el; };

function attention() {
  if (!S.projectId) return { decisions: 0, messages: 0 };
  const d = S.decisions.filter((x) => x.status === 'candidate' || (x.status === 'awaiting' && x.decider?.kind === 'owner') || (x.needsReview && !x.reviewed && x.status === 'resolved')).length;
  const m = S.messages.filter((x) => x.status === 'pending_approval').length + S.contacts.filter((x) => x.status === 'pending').length;
  return { decisions: d, messages: m };
}

// ------------------------------------------------------------------ shell
const PAGES = [['overview', 'Обзор'], ['decisions', 'Решения'], ['messages', 'Сообщения'], ['tasks', 'Задачи'], ['team', 'Команда'], ['style', 'Стиль общения'], ['autonomy', 'Автономия'], ['feed', 'Лента'], ['world', 'Внешний мир']];

function render() {
  const att = attention();
  $('#nav').replaceChildren(h('div', { class: 'brand' }, 'aya'), ...PAGES.map(([id, title]) => h('a', { href: `#${id}`, class: route === id ? 'on' : '' }, title, att[id] ? h('span', { class: 'badge' }, att[id]) : null)));
  const p = S.projects.find((x) => x.id === S.projectId);
  $('#top').replaceChildren(
    S.projects.length ? h('select', { onchange: (e) => { localStorage.setItem('aya.project', e.target.value); load(true); } }, S.projects.map((x) => h('option', { value: x.id, selected: x.id === S.projectId }, x.name))) : h('span', { class: 'muted' }, 'Проектов пока нет'),
    p ? h('span', { class: `chip ${p.status === 'active' ? 'ok' : 'warn'}` }, p.status === 'active' ? 'идёт' : 'на паузе') : null,
    p ? h('button', { onclick: () => act('PATCH', `/projects/${p.id}`, { status: p.status === 'active' ? 'paused' : 'active' }) }, p.status === 'active' ? 'Пауза' : 'Возобновить') : null,
    h('span', { class: 'spacer' }),
    p ? h('button', { onclick: () => act('POST', '/sync', {}, 'Сверено с исполнителем') }, 'Сверить с исполнителем') : null,
    h('button', { onclick: () => { route = 'new'; render(); } }, 'Новый проект'),
  );
  const page = $('#page');
  const view = route === 'new' || !S.projectId ? newProject : (VIEWS[route] || VIEWS.overview);
  page.replaceChildren(...[view()].flat(Infinity).filter(Boolean));
}

window.addEventListener('hashchange', () => { route = location.hash.slice(1) || 'overview'; dirty = false; render(); if (route === 'feed') loadFeed(); });

// ------------------------------------------------------------------ pages
function newProject() {
  const f = { name: h('input', { type: 'text', class: 'wide', placeholder: 'Название' }), goal: h('textarea', { placeholder: 'Цель проекта: что должно получиться' }), repo: h('input', { type: 'text', class: 'wide', placeholder: '/путь/к/локальному/клону' }), exec: h('select', {}, h('option', { value: 'sdlc' }, 'sdlc')), pipe: h('input', { type: 'text', placeholder: 'по умолчанию' }), tracker: h('input', { type: 'text', placeholder: 'например DEMO' }), budget: h('input', { type: 'number', placeholder: 'без лимита', min: '1' }) };
  Object.values(f).forEach(watch);
  return [h('h1', {}, 'Новый проект'), h('div', { class: 'card' },
    field('Название', f.name), field('Цель', f.goal), field('Репозиторий (локальный путь)', f.repo),
    h('div', { class: 'row' }, field('Исполнитель', f.exec), field('Пайплайн исполнителя', f.pipe), field('Проект в трекере', f.tracker), field('Бюджет агентов, $', f.budget)),
    h('p', { class: 'muted small', style: 'margin-top:10px' }, 'Команда создаётся сразу: ПМ, техлид, архитектор и два разработчика. ПМ начнёт с разбора цели на задачи.'),
    h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: async () => {
      const p = await api('POST', '/projects', { name: f.name.value, goal: f.goal.value, repoPath: f.repo.value || null, executor: f.exec.value, pipeline: f.pipe.value || null, trackerProject: f.tracker.value || null, budgetUsd: f.budget.value ? Number(f.budget.value) : null });
      localStorage.setItem('aya.project', p.id); dirty = false; location.hash = '#overview'; route = 'overview'; await load(true);
    } }, 'Создать и запустить'), S.projectId ? h('button', { onclick: () => { route = 'overview'; render(); } }, 'Отмена') : null),
  )];
}

const VIEWS = {
  overview() {
    const m = S.metrics; const att = attention(); const p = S.projects.find((x) => x.id === S.projectId);
    const byStatus = {}; for (const t of S.tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    const stat = (n, l, href) => h(href ? 'a' : 'div', { class: 'card stat', href, style: href ? 'text-decoration:none;color:inherit' : null }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l));
    return [
      h('h1', {}, p.name), h('p', { class: 'muted pre' }, p.goal),
      ...section('Требует твоего внимания', null, h('div', { class: 'grid' },
        stat(att.decisions, 'решений ждут тебя', '#decisions'), stat(att.messages, 'сообщений и контактов на одобрение', '#messages'),
        stat(S.tasks.filter((t) => t.status === 'blocked').length, 'задач заблокировано', '#tasks'), stat(S.checkpoints.filter((c) => c.status === 'open' || c.status === 'proposed').length, 'чекпоинтов исполнителя в работе'))),
      ...section('Задачи', S.tasks.length, h('div', { class: 'row' }, Object.keys(STATUS_RU).filter((s) => byStatus[s]).map((s) => h('span', { class: `chip ${STATUS_CHIP[s] || ''}` }, `${STATUS_RU[s]}: ${byStatus[s]}`)), !S.tasks.length ? empty('ПМ ещё не завёл задачи.') : null)),
      ...section('Команда', null, h('div', { class: 'row' }, S.agents.map((a) => h('span', { class: 'chip' }, h('span', { class: `dot ${a.running ? 'working' : a.status === 'paused' ? 'paused' : ''}` }), ` ${a.alias} · ${role(a.roleId).title}${a.queued.length ? ` (в очереди ${a.queued.length})` : ''}`)))),
      ...section('Метрики', null, h('div', { class: 'grid' },
        stat(pct(m.selfAssessmentMatch), 'самооценка агентов совпала с твоей'), stat(pct(m.recommendationMatch), 'рекомендаций агентов принято'),
        stat(m.misses, 'пропусков: автономное решение, которое ты отменил'), stat(m.decisions.autonomous, 'решений принято автономно'),
        stat(m.expertRequests, 'обращений к экспертам'), stat(m.ownerActions, 'твоих действий'), stat(`$${m.spentUsd.toFixed(2)}`, 'расход агентов'))),
    ];
  },

  decisions() {
    const cand = S.decisions.filter((d) => d.status === 'candidate');
    const awaiting = S.decisions.filter((d) => d.status === 'awaiting');
    const review = S.decisions.filter((d) => d.status === 'resolved' && d.needsReview && !d.reviewed);
    const history = S.decisions.filter((d) => (d.status === 'resolved' && !(d.needsReview && !d.reviewed)) || d.status === 'cancelled');
    return [h('h1', {}, 'Решения'),
      ...section('Классифицировать', cand.length, cand.length ? cand.map((d) => decisionCard(d, 'classify')) : empty('Новых кандидатов нет.')),
      ...section('Ждут решающего', awaiting.length, awaiting.length ? awaiting.map((d) => decisionCard(d, 'await')) : empty('Нет.')),
      ...section('Приняты без тебя, посмотри', review.length, review.length ? review.map((d) => decisionCard(d, 'review')) : empty('Нет.')),
      ...section('История', history.length, history.length ? history.map((d) => decisionCard(d, 'history')) : empty('Пока пусто.')),
    ];
  },

  messages() {
    const contacts = S.contacts.filter((c) => c.status === 'pending');
    const pend = S.messages.filter((m) => m.status === 'pending_approval');
    const blocked = S.messages.filter((m) => m.status === 'blocked' || m.status === 'rejected');
    const rest = S.messages.filter((m) => ['sent', 'received', 'pending_contact'].includes(m.status));
    const kinds = Object.keys(KIND_RU);
    return [h('h1', {}, 'Сообщения'),
      ...section('Запросы контактов', contacts.length, contacts.length ? contacts.map((c) => h('div', { class: 'card attn row' },
        h('div', { class: 'grow' }, h('b', {}, agentName(c.agentId)), ' хочет писать: ', h('b', {}, persona(c.personaId)?.name), h('span', { class: 'muted' }, ` (${persona(c.personaId)?.title || 'без должности'})`)),
        h('button', { class: 'primary', onclick: () => act('POST', '/contacts', { agentId: c.agentId, personaId: c.personaId, status: 'approved' }, 'Контакт утверждён') }, 'Утвердить'),
        h('button', { class: 'danger', onclick: () => act('POST', '/contacts', { agentId: c.agentId, personaId: c.personaId, status: 'denied' }) }, 'Отклонить'))) : empty('Нет.')),
      ...section('Ждут одобрения', pend.length, pend.length ? pend.map(approvalCard) : empty('Нет.')),
      ...section('Остановлены или отклонены', blocked.length, blocked.length ? blocked.slice(0, 20).map((m) => h('div', { class: 'card' }, msgHead(m), h('div', { class: 'quote' }, m.draftText), m.violations.length ? h('div', { class: 'chip bad' }, m.violations.join('; ')) : null, m.rejectReason ? h('div', { class: 'chip bad' }, `Причина: ${m.rejectReason}`) : null)) : empty('Нет.')),
      ...section('Переписка', rest.length, rest.length ? rest.slice(0, 60).map((m) => h('div', { class: 'card' }, msgHead(m), h('div', { class: `quote ${m.direction === 'in' ? 'in' : ''}` }, m.finalText || m.draftText))) : empty('Пока пусто.')),
      ...section('Когда нужно твоё одобрение', null, h('div', { class: 'card scroll' }, h('table', {}, h('tr', {}, h('th', {}, 'Вид сообщения'), h('th', {}, 'Отправлено'), h('th', {}, 'Без твоих правок'), h('th', {}, 'Одобрение')),
        kinds.map((k) => { const st = S.messageStats.find((x) => x.kind === k); const rule = S.approvalRules.find((r) => r.kind === k && r.personaId === '*'); const req = rule ? rule.requireApproval : true;
          return h('tr', {}, h('td', {}, KIND_RU[k]), h('td', {}, st?.sent ?? 0), h('td', {}, pct(st?.unedited)), h('td', {}, h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: req, onchange: (e) => act('POST', '/approval-rules', { kind: k, requireApproval: e.target.checked }) }), 'обязательно'))); })))),
    ];
  },

  tasks() {
    const roots = S.tasks.filter((t) => !t.parentId || !task(t.parentId));
    const f = { title: watch(h('input', { type: 'text', class: 'wide', placeholder: 'Заголовок' })), desc: watch(h('textarea', { placeholder: 'Описание' })) };
    return [h('h1', {}, 'Задачи'),
      roots.length ? roots.map((t) => taskNode(t)) : empty('Задач пока нет.'),
      h('details', {}, h('summary', {}, 'Добавить задачу самому'), h('div', { class: 'card' }, field('Заголовок', f.title), field('Описание', f.desc),
        h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: () => act('POST', '/tasks', { projectId: S.projectId, title: f.title.value, description: f.desc.value }, 'Задача создана') }, 'Создать')))),
      ...section('Пакеты для тестировщиков', S.packages.length, S.packages.length ? S.packages.map((p) => h('div', { class: 'card' }, h('b', {}, p.title), ' ', h('span', { class: `chip ${p.status === 'passed' ? 'ok' : p.status === 'failed' ? 'bad' : 'warn'}` }, { open: 'собирается', sent: 'у тестировщиков', passed: 'принят', failed: 'найдены дефекты' }[p.status]), h('div', { class: 'small muted' }, p.taskIds.map((id) => task(id)?.title ?? id).join(' · ')), p.notes ? h('div', { class: 'pre small' }, p.notes) : null)) : empty('Нет.')),
    ];
  },

  team() {
    const tree = (boss, depth) => S.agents.filter((a) => (a.reportsTo || null) === boss).map((a) => [agentCard(a, depth), tree(a.id, depth + 1)]);
    return [h('h1', {}, 'Команда'), ...section('Агенты', S.agents.length, h('p', { class: 'muted small' }, 'Вложенность показывает подчинение. Наверху владелец.'), tree(null, 0)),
      ...section('Люди', S.personas.length, S.personas.map(personaCard), h('details', {}, h('summary', {}, 'Добавить человека'), personaForm(null)))];
  },

  style() {
    const f = { text: watch(h('textarea', { placeholder: 'Например: без вступлений и благодарностей, сразу вопрос' })), scope: h('select', {}, Object.entries(SCOPE_RU).map(([k, v]) => h('option', { value: k }, v))), who: h('select', {}) };
    const fill = () => { const s = f.scope.value; f.who.replaceChildren(...(s === 'role' ? S.roles.map((r) => h('option', { value: r.id }, r.title)) : s === 'persona' ? S.personas.filter((p) => !p.isOwner).map((p) => h('option', { value: p.id }, p.name)) : [])); f.who.hidden = s === 'all'; };
    f.scope.addEventListener('change', fill); fill();
    const groups = { all: [], role: [], persona: [] }; for (const l of S.lessons) groups[l.scope].push(l);
    const who = (l) => (l.scope === 'role' ? role(l.scopeId)?.title : l.scope === 'persona' ? persona(l.scopeId)?.name : '');
    return [h('h1', {}, 'Стиль общения'), h('p', { class: 'muted' }, 'Правила, по которым агенты пишут людям. Они подставляются при составлении каждого сообщения, поэтому действуют сразу. Уроки появляются и из твоих правок при одобрении.'),
      h('div', { class: 'card' }, field('Новое правило', f.text), h('div', { class: 'row', style: 'margin-top:8px' }, 'Действует на:', f.scope, f.who, h('button', { class: 'primary', onclick: () => act('POST', '/lessons', { scope: f.scope.value, scopeId: f.scope.value === 'all' ? null : f.who.value, text: f.text.value }, 'Правило добавлено') }, 'Добавить'))),
      ...Object.entries(groups).map(([sc, list]) => section(`Охват: ${SCOPE_RU[sc]}`, list.length, list.length ? list.map((l) => { const t = watch(h('textarea', { value: l.text }));
        return h('div', { class: 'card', style: l.active ? null : 'opacity:.55' }, h('div', { class: 'row' }, who(l) ? h('span', { class: 'chip acc' }, who(l)) : null, h('span', { class: 'chip' }, { edit: 'из твоей правки', rule: 'правило', reject: 'из отклонения' }[l.source]), h('span', { class: 'muted small' }, date(l.createdAt))), t,
          l.before ? h('details', {}, h('summary', {}, 'Пример: было и стало'), h('div', { class: 'quote before' }, l.before), l.after ? h('div', { class: 'quote after' }, l.after) : null) : null,
          h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { onclick: () => act('PATCH', `/lessons/${l.id}`, { text: t.value }, 'Сохранено') }, 'Сохранить текст'), h('button', { onclick: () => act('PATCH', `/lessons/${l.id}`, { active: !l.active }) }, l.active ? 'Выключить' : 'Включить'))); }) : empty('Нет.'))),
    ];
  },

  autonomy() {
    const classes = Object.keys(S.classes);
    const lvl = (roleId, k) => S.autonomyLevels.find((x) => x.roleId === roleId && x.klass === k)?.level ?? 1;
    const st = (roleId, k) => S.autonomy.find((x) => x.roleId === roleId && x.klass === k);
    return [h('h1', {}, 'Автономия'),
      h('p', { class: 'muted' }, 'Ступень 1: всё классифицируешь ты. Ступень 2: агент решает сам, ты видишь решение и можешь отменить. Ступень 3: полная автономия с выборочной проверкой. Необратимые решения всегда идут к тебе, на любой ступени.'),
      S.roles.map((r) => h('div', { class: 'card scroll' }, h('h3', {}, r.title), h('table', {}, h('tr', {}, h('th', {}, 'Класс решений'), h('th', {}, 'Ты классифицировал'), h('th', {}, 'Самооценка совпала'), h('th', {}, 'Рекомендация принята'), h('th', {}, 'Отменено тобой'), h('th', {}, 'Ступень')),
        classes.map((k) => { const s = st(r.id, k);
          return h('tr', {}, h('td', {}, S.classes[k]), h('td', {}, s?.classified ?? 0), h('td', {}, s?.classified ? `${s.matched} из ${s.classified}` : '—'), h('td', {}, s?.resolved ? `${s.recommended} из ${s.resolved}` : '—'), h('td', {}, s?.overridden ?? 0),
            h('td', {}, h('select', { onchange: (e) => act('POST', '/autonomy', { roleId: r.id, klass: k, level: Number(e.target.value) }, 'Ступень изменена') }, [1, 2, 3].map((n) => h('option', { value: n, selected: lvl(r.id, k) === n }, n))))); })))),
    ];
  },

  feed() {
    return [h('h1', {}, 'Лента'), h('p', { class: 'muted' }, 'Всё, что происходит в проекте: кто, что и на каком основании сделал. Твои действия выделены.'),
      h('div', { class: 'card feed', id: 'feed' }, feed.length ? feed.slice().reverse().map((e) => h('div', { class: `ev ${e.actorKind}` }, h('span', { class: 't' }, time(e.ts)), h('span', { class: 'ty', title: e.type }, e.type), h('span', { class: 'tx' }, e.summary))) : empty('Событий пока нет.'))];
  },

  world() {
    const waiting = S.messages.filter((m) => m.direction === 'out' && m.status === 'sent' && m.personaId && !S.messages.some((x) => x.direction === 'in' && x.threadId === m.threadId && x.createdAt > m.sentAt));
    const f = { key: watch(h('input', { type: 'text', placeholder: 'DEMO-1' })), title: watch(h('input', { type: 'text', class: 'wide', placeholder: 'Заголовок' })), desc: watch(h('textarea', { placeholder: 'Описание задачи, как его написал бы человек' })) };
    return [h('h1', {}, 'Внешний мир'), h('p', { class: 'muted' }, 'Настоящие каналы пока не подключены. Здесь ты играешь за людей снаружи: отвечаешь на сообщения агентов и заводишь задачи в трекере компании.'),
      ...section('Сообщения, на которые ещё нет ответа', waiting.length, waiting.length ? waiting.map((m) => { const d = m.decisionId ? S.decisions.find((x) => x.id === m.decisionId) : null; const t = watch(h('textarea', { placeholder: `Ответ от имени: ${persona(m.personaId)?.name}` }));
        return h('div', { class: 'card' }, msgHead(m), h('div', { class: 'quote' }, m.finalText),
          d && d.status === 'awaiting' ? h('div', { class: 'row' }, 'Быстрый ответ:', d.options.map((o) => h('button', { onclick: () => { t.value = `Вариант ${o.key}. `; t.focus(); dirty = true; } }, `${o.key}: ${o.label}`))) : null,
          t, h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'primary', onclick: () => act('POST', '/sim/reply', { messageId: m.id, text: t.value }, 'Ответ доставлен') }, 'Ответить'))); }) : empty('Нет.')),
      ...section('Трекер компании', S.tracker.length, S.tracker.length ? h('div', { class: 'card scroll' }, h('table', {}, h('tr', {}, h('th', {}, 'Ключ'), h('th', {}, 'Задача'), h('th', {}, 'Статус'), h('th', {}, 'Комментарии')),
        S.tracker.map((i) => h('tr', {}, h('td', {}, i.key), h('td', {}, h('b', {}, i.title), h('div', { class: 'small muted pre' }, i.description)), h('td', {}, h('span', { class: 'chip' }, i.status)), h('td', { class: 'small' }, i.comments.map((cm) => h('div', {}, cm.text))))))) : empty('Задач нет.'),
        h('div', { class: 'card' }, h('h3', {}, 'Завести задачу в трекере'), h('div', { class: 'row' }, field('Ключ', f.key), h('div', { class: 'grow' }, field('Заголовок', f.title))), field('Описание', f.desc),
          h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'primary', onclick: () => act('POST', '/sim/tracker', { key: f.key.value.trim(), title: f.title.value, description: f.desc.value, projectId: S.projectId }, 'Задача заведена, ПМ уведомлён') }, 'Завести и сообщить ПМ')))),
    ];
  },
};

// ------------------------------------------------------------------ cards
function msgHead(m) {
  const who = m.direction === 'in' ? `${persona(m.personaId)?.name} → ${agent(m.agentId)?.alias ?? ''}` : m.action ? `${agent(m.agentId)?.alias} → трекер ${m.action.key}` : `${agent(m.agentId)?.alias} → ${persona(m.personaId)?.name}`;
  return h('div', { class: 'row', style: 'margin-bottom:6px' }, h('b', {}, who), h('span', { class: 'chip' }, KIND_RU[m.kind]), h('span', { class: `chip ${m.status === 'sent' || m.status === 'received' ? 'ok' : m.status === 'blocked' || m.status === 'rejected' ? 'bad' : 'warn'}` }, MSG_RU[m.status]), m.edited ? h('span', { class: 'chip acc' }, 'с твоими правками') : null, m.decisionId ? h('span', { class: 'chip' }, 'по решению') : null, h('span', { class: 'muted small' }, date(m.sentAt || m.createdAt)));
}

function approvalCard(m) {
  const text = watch(h('textarea', { value: m.draftText }));
  const scope = h('select', {}, h('option', { value: '' }, 'не сохранять урок'), m.personaId ? h('option', { value: 'persona' }, `урок для адресата: ${persona(m.personaId)?.name}`) : null, h('option', { value: 'role' }, `урок для роли: ${role(agent(m.agentId)?.roleId)?.title}`), h('option', { value: 'all' }, 'урок для всех сообщений'));
  const lesson = watch(h('input', { type: 'text', class: 'wide', placeholder: 'Правило словами (необязательно): что агент должен делать иначе' }));
  const reason = watch(h('input', { type: 'text', class: 'wide', placeholder: 'Причина отклонения' }));
  text.addEventListener('input', () => { if (!scope.value && m.personaId) scope.value = 'persona'; });
  const prefix = `[${agent(m.agentId)?.alias} · ${role(agent(m.agentId)?.roleId)?.title}] `;
  return h('div', { class: 'card attn' }, msgHead(m), h('div', { class: 'small muted' }, `Уйдёт от твоего имени с префиксом: ${prefix}`), text,
    h('div', { class: 'row', style: 'margin-top:8px' }, scope, h('div', { class: 'grow' }, lesson)),
    h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'primary', onclick: () => act('POST', `/messages/${m.id}/approve`, { text: text.value, lesson: scope.value ? { scope: scope.value, text: lesson.value || undefined } : undefined }, 'Отправлено') }, 'Одобрить и отправить'),
      h('div', { class: 'grow' }, reason), h('button', { class: 'danger', onclick: () => { if (!reason.value.trim()) return toast('Напиши причину: агент её получит', true); act('POST', `/messages/${m.id}/reject`, { reason: reason.value, lessonScope: scope.value || undefined }, 'Отклонено'); } }, 'Отклонить')));
}

function decisionCard(d, mode) {
  const a = agent(d.agentId); const t = d.taskId ? task(d.taskId) : null;
  const head = h('div', { class: 'row top' }, h('div', { class: 'grow' }, h('h3', {}, d.title), h('div', { class: 'small muted' }, `${agentName(d.agentId)}${t ? ` · задача «${t.title}»` : ''} · ${date(d.createdAt)}`)),
    h('span', { class: 'chip' }, S.classes[d.klass]), h('span', { class: `chip ${d.reversible ? '' : 'bad'}` }, d.reversible ? 'обратимое' : 'необратимое'), d.bySubstitute ? h('span', { class: 'chip warn' }, 'решила ИИ-подмена') : null, d.classifiedBy === 'autonomy' ? h('span', { class: 'chip acc' }, 'автономно') : null);
  const options = h('div', { class: 'options' }, d.options.map((o) => h('div', { class: `option ${d.chosen === o.key ? 'chosen' : d.recommendation === o.key && !d.chosen ? 'rec' : ''}` }, h('b', {}, o.key), o.label, d.recommendation === o.key ? h('span', { class: 'chip acc', style: 'margin-left:8px' }, 'рекомендация агента') : null, d.chosen === o.key ? h('span', { class: 'chip ok', style: 'margin-left:8px' }, 'выбрано') : null, o.consequences ? h('div', { class: 'small muted' }, o.consequences) : null)));
  const self = h('div', { class: 'small' }, h('b', {}, 'Самооценка агента: '), `важность ${IMPORTANCE_RU[d.importance]}, уверенность ${pct(d.confidence)}. Считает решение ${d.proposedPivotal ? 'разворотным' : 'рядовым'}, решать должен: ${deciderName(d, d.proposedDecider)}.`);
  const body = [head, d.context ? h('p', { class: 'pre', style: 'margin-top:8px' }, d.context) : null, options, d.rationale ? h('p', { class: 'small' }, h('b', {}, 'Обоснование: '), d.rationale) : null, self];

  if (mode === 'history') {
    return h('details', { class: 'card' }, h('summary', {}, `${d.title} → ${d.status === 'cancelled' ? 'отменено' : optionLabel(d, d.chosen)}`, h('span', { class: 'muted small' }, ` · решил ${d.resolvedBy === 'owner' ? 'владелец' : d.resolvedBy?.startsWith('persona:') ? persona(d.resolvedBy.slice(8))?.name : d.resolvedBy?.startsWith('agent:') ? agent(d.resolvedBy.slice(6))?.alias : '—'}`)),
      ...body, d.chosenComment ? h('p', { class: 'small' }, h('b', {}, 'Комментарий: '), d.chosenComment) : null, reinforcementLine(d), d.status === 'resolved' ? overrideForm(d, 'Изменить решение') : null);
  }
  if (mode === 'review') {
    return h('div', { class: 'card attn' }, ...body, h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: () => act('POST', `/decisions/${d.id}/review`, { ok: true }, 'Отмечено') }, 'Согласен'), h('span', { class: 'muted small' }, 'или измени:')), overrideForm(d, 'Изменить решение'));
  }
  if (mode === 'await') {
    const mine = d.decider?.kind === 'owner';
    return h('div', { class: `card ${mine ? 'attn' : ''}` }, ...body, h('p', { style: 'margin-top:8px' }, h('b', {}, 'Решает: '), deciderName(d, d.decider), d.pivotal ? h('span', { class: 'chip warn', style: 'margin-left:8px' }, 'разворотное') : null), overrideForm(d, mine ? 'Принять решение' : 'Решить самому, не дожидаясь'));
  }
  // classify
  const pivotal = h('input', { type: 'checkbox', checked: d.proposedPivotal });
  const who = h('select', {}, h('option', { value: 'self' }, `сам ${a?.alias}`), S.agents.filter((x) => x.id !== d.agentId && role(x.roleId).canDecide.includes(d.klass)).map((x) => h('option', { value: `agent:${x.id}` }, agentName(x.id))), S.personas.filter((p) => !p.isOwner).map((p) => h('option', { value: `persona:${p.id}` }, `${p.name}${p.title ? ` (${p.title})` : ''}`)), h('option', { value: 'owner' }, 'я сам'));
  who.value = d.proposedDecider.kind === 'self' || d.proposedDecider.kind === 'owner' ? d.proposedDecider.kind : `${d.proposedDecider.kind}:${d.proposedDecider.id}`;
  if (!who.value) who.value = 'owner';
  const klass = h('select', {}, Object.entries(S.classes).map(([k, v]) => h('option', { value: k, selected: k === d.klass }, v)));
  const chosen = h('select', {}, d.options.map((o) => h('option', { value: o.key, selected: o.key === d.recommendation }, `${o.key}: ${o.label}`)));
  const comment = watch(h('input', { type: 'text', class: 'wide', placeholder: 'Комментарий к решению (агент его получит)' }));
  const note = watch(h('input', { type: 'text', class: 'wide', placeholder: 'Заметка о самооценке агента (необязательно)' }));
  const mineBox = h('div', {}, field('Твой выбор', chosen), comment);
  const sync = () => { mineBox.hidden = who.value !== 'owner'; };
  who.addEventListener('change', () => { dirty = true; sync(); }); sync();
  const parse = () => { const v = who.value; return v.includes(':') ? { kind: v.split(':')[0], id: v.split(':')[1] } : { kind: v }; };
  const send = (asProposed) => act('POST', `/decisions/${d.id}/classify`, asProposed ? { pivotal: d.proposedPivotal, decider: d.proposedDecider } : { pivotal: pivotal.checked, decider: parse(), klass: klass.value, note: note.value || undefined, chosen: who.value === 'owner' ? chosen.value : undefined, comment: who.value === 'owner' ? comment.value || undefined : undefined }, 'Классифицировано');
  return h('div', { class: 'card attn' }, ...body,
    d.precedents?.length ? h('p', { class: 'small' }, h('b', {}, 'Похожие решения раньше: '), d.precedents.map((p) => `«${p.title}» → ${p.label}`).join('; ')) : null,
    h('div', { class: 'row', style: 'margin-top:10px' }, d.proposedDecider.kind !== 'owner' ? h('button', { class: 'primary', onclick: () => send(true) }, 'Согласен с оценкой агента') : null, h('span', { class: 'muted small' }, d.proposedDecider.kind !== 'owner' ? 'или поправь:' : 'Агент считает, что решать тебе:')),
    h('div', { class: 'row', style: 'margin-top:8px' }, h('label', { class: 'inline' }, pivotal, 'разворотное'), 'Решает:', who, 'Класс:', klass),
    mineBox, note, h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { onclick: () => send(false) }, 'Классифицировать так'), h('button', { class: 'danger', onclick: () => act('POST', `/decisions/${d.id}/cancel`, { reason: 'владелец снял вопрос' }, 'Снято') }, 'Снять вопрос')));
}

function overrideForm(d, title) {
  const chosen = h('select', {}, d.options.map((o) => h('option', { value: o.key, selected: o.key === (d.chosen || d.recommendation) }, `${o.key}: ${o.label}`)));
  const comment = watch(h('input', { type: 'text', class: 'wide', placeholder: 'Комментарий (агент его получит)' }));
  return h('div', { class: 'row', style: 'margin-top:8px' }, chosen, h('div', { class: 'grow' }, comment), h('button', { onclick: () => act('POST', `/decisions/${d.id}/override`, { chosen: chosen.value, comment: comment.value || undefined }, 'Решение записано') }, title));
}

function reinforcementLine(d) {
  const r = d.reinforcement || {}; const bits = [];
  if (r.pivotalMatch != null) bits.push(r.pivotalMatch && r.deciderMatch && r.classMatch ? 'самооценка совпала с твоей' : 'самооценка не совпала с твоей');
  if (r.recommendationMatch != null) bits.push(r.recommendationMatch ? 'рекомендация принята' : 'выбрано не то, что рекомендовал агент');
  if (r.overridden) bits.push('ты изменил решение');
  if (r.ownerNote) bits.push(`заметка: ${r.ownerNote}`);
  return bits.length ? h('p', { class: 'small muted' }, `Подкрепление: ${bits.join('; ')}.`) : null;
}

function taskNode(t) {
  const kids = S.tasks.filter((x) => x.parentId === t.id);
  const status = h('select', { onchange: (e) => { const v = e.target.value; const note = v === 'obsolete' ? prompt('Почему задача неактуальна?') : undefined; if (v === 'obsolete' && !note) return render(); act('PATCH', `/tasks/${t.id}`, { status: v, note: note || undefined }); } }, Object.entries(STATUS_RU).map(([k, v]) => h('option', { value: k, selected: k === t.status }, v)));
  const assignee = h('select', { onchange: (e) => e.target.value && act('PATCH', `/tasks/${t.id}`, { assigneeId: e.target.value }) }, h('option', { value: '' }, t.takenOver ? 'у владельца' : 'не назначена'), S.agents.map((a) => h('option', { value: a.id, selected: a.id === t.assigneeId }, a.alias)));
  const cps = S.checkpoints.filter((c) => c.taskId === t.id && (c.status === 'open' || c.status === 'proposed'));
  return [h('div', { class: 'card' }, h('div', { class: 'row top' }, h('div', { class: 'grow' }, h('b', {}, t.title), ' ', h('span', { class: `chip ${STATUS_CHIP[t.status] || ''}` }, STATUS_RU[t.status]), t.status === 'open' && !t.ready ? h('span', { class: 'chip', style: 'margin-left:4px' }, 'ждёт зависимости') : null,
      t.externalKey ? h('span', { class: 'chip acc', style: 'margin-left:4px' }, t.externalKey) : null, t.takenOver ? h('span', { class: 'chip warn', style: 'margin-left:4px' }, 'забрал владелец') : null),
      status, assignee, !t.takenOver ? h('button', { onclick: () => act('PATCH', `/tasks/${t.id}`, { takeOver: true }, 'Задача у тебя') }, 'Забрать себе') : null),
    t.description ? h('details', {}, h('summary', {}, 'Описание'), h('div', { class: 'pre' }, t.description)) : null,
    h('div', { class: 'small muted', style: 'margin-top:6px' }, [
      t.dependsOn.length ? `Зависит от: ${t.dependsOn.map((id) => task(id)?.title ?? id).join(', ')}` : null,
      t.intake ? `Входной контроль: ${t.intake.ready ? 'пройден' : `пробелов ${t.intake.gaps.length}`}${t.intake.gaps.length ? ` (${t.intake.gaps.map((g) => `${g.what}: ${g.resolution === 'self' ? 'сам' : 'нужен человек'}`).join('; ')})` : ''}` : null,
      t.executorRef ? `Исполнитель: ${t.executorRef}, ${t.executorStatus}` : null, cps.length ? `Чекпоинт у техлида: ${cps.map((c) => c.title).join(', ')}` : null, t.obsoleteReason ? `Неактуальна: ${t.obsoleteReason}` : null,
    ].filter(Boolean).map((line) => h('div', {}, line)), t.prUrl ? h('div', {}, h('a', { href: t.prUrl, target: '_blank' }, t.prUrl)) : null)),
  kids.length ? h('div', { class: 'tree' }, kids.map(taskNode)) : null];
}

function agentCard(a, depth) {
  const r = role(a.roleId); const note = watch(h('input', { type: 'text', class: 'wide', placeholder: `Написать ${a.alias}: указание или вопрос` }));
  const memory = watch(h('textarea', { value: a.memory, placeholder: 'Память агента пуста' }));
  return h('div', { class: 'card', style: `margin-left:${depth * 26}px` }, h('div', { class: 'row' }, h('span', { class: `dot ${a.running ? 'working' : a.status === 'paused' ? 'paused' : ''}` }), h('b', {}, a.alias), h('span', { class: 'chip' }, r.title), h('span', { class: 'muted small' }, a.running ? 'работает' : a.status === 'paused' ? 'на паузе' : 'ждёт'), h('span', { class: 'grow' }),
      h('span', { class: 'muted small' }, `$${a.costUsd.toFixed(2)}`), a.running ? h('button', { onclick: () => act('POST', `/agents/${a.id}/interrupt`, {}, 'Ход прерван') }, 'Прервать ход') : null,
      h('button', { onclick: () => act('PATCH', `/agents/${a.id}`, { status: a.status === 'paused' ? 'idle' : 'paused' }) }, a.status === 'paused' ? 'Возобновить' : 'Пауза')),
    h('div', { class: 'small muted', style: 'margin-top:4px' }, r.responsibilities),
    a.queued.length ? h('div', { class: 'small', style: 'margin-top:6px' }, 'В очереди: ', a.queued.map((w) => h('span', { class: 'chip', style: 'margin-right:4px' }, w.title))) : null,
    a.lastRun?.summary ? h('div', { class: 'quote small' }, a.lastRun.summary) : null, a.lastRun?.error ? h('div', { class: 'chip bad' }, a.lastRun.error.slice(0, 200)) : null,
    h('div', { class: 'row', style: 'margin-top:8px' }, h('div', { class: 'grow' }, note), h('button', { onclick: () => note.value.trim() && act('POST', `/agents/${a.id}/note`, { text: note.value }, 'Передано') }, 'Отправить')),
    h('details', {}, h('summary', {}, 'Память агента'), memory, h('button', { style: 'margin-top:6px', onclick: () => act('PATCH', `/agents/${a.id}/memory`, { memory: memory.value }, 'Память сохранена') }, 'Сохранить')));
}

function classPicker(selected) {
  const boxes = Object.entries(S.classes).map(([k, v]) => { const cb = h('input', { type: 'checkbox', checked: selected.includes(k), value: k }); return h('label', { class: 'inline', style: 'margin-right:10px' }, cb, v); });
  const el = h('div', { class: 'row' }, boxes); el.values = () => [...el.querySelectorAll('input:checked')].map((x) => x.value);
  el.addEventListener('change', () => { dirty = true; });
  return el;
}

function personaForm(p) {
  const f = { name: watch(h('input', { type: 'text', class: 'wide', value: p?.name ?? '' })), title: watch(h('input', { type: 'text', class: 'wide', value: p?.title ?? '' })), expertise: watch(h('textarea', { value: p?.expertise ?? '' })), address: watch(h('input', { type: 'text', value: p?.address ?? '', placeholder: '@имя или #канал' })), hours: watch(h('input', { type: 'number', value: p?.responseHours ?? 24, min: '1' })), limit: watch(h('input', { type: 'number', value: p?.contactLimitPerWeek ?? '', placeholder: 'без лимита', min: '1' })), notes: watch(h('textarea', { value: p?.notes ?? '', placeholder: 'Как человек предпочитает общаться, что ему важно' })), req: classPicker(p?.classesRequired ?? []), adv: classPicker(p?.classesAdvisory ?? []), subOn: h('input', { type: 'checkbox', checked: p?.substituteOn }), sub: classPicker(p?.substituteClasses ?? []) };
  const body = () => ({ name: f.name.value, title: f.title.value, expertise: f.expertise.value, address: f.address.value, responseHours: Number(f.hours.value) || 24, contactLimitPerWeek: f.limit.value ? Number(f.limit.value) : null, notes: f.notes.value, classesRequired: f.req.values(), classesAdvisory: f.adv.values(), substituteOn: f.subOn.checked, substituteClasses: f.sub.values() });
  return h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, field('Имя', f.name)), h('div', { class: 'grow' }, field('Должность', f.title))), field('Экспертиза', f.expertise),
    h('div', { class: 'row' }, field('Адрес в канале', f.address), field('Ждём ответа, часов', f.hours), field('Обращений в неделю', f.limit)), field('Ответ обязателен для классов', f.req), field('Только совет для классов', f.adv), field('Заметки', f.notes),
    h('div', { style: 'margin-top:10px' }, h('label', { class: 'inline' }, f.subOn, 'ИИ-подмена включена (отвечает вместо человека, решения помечаются на пересмотр)')), field('Подмена вправе решать классы (только обратимые решения)', f.sub),
    h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: () => (p ? act('PATCH', `/personas/${p.id}`, body(), 'Сохранено') : act('POST', '/personas', body(), 'Добавлено')) }, p ? 'Сохранить' : 'Добавить')));
}

function personaCard(p) {
  if (p.isOwner) return h('div', { class: 'card' }, h('b', {}, p.name), ' ', h('span', { class: 'chip acc' }, 'владелец'), h('div', { class: 'small muted' }, 'Вершина иерархии: классифицирует решения, утверждает контакты и сообщения, может вмешаться на любом шаге.'));
  return h('details', { class: 'card' }, h('summary', {}, h('b', {}, p.name), p.title ? ` · ${p.title}` : '', p.substituteOn ? h('span', { class: 'chip warn', style: 'margin-left:8px' }, 'ИИ-подмена') : null, h('span', { class: 'muted small' }, p.expertise ? ` — ${p.expertise.slice(0, 90)}` : '')), personaForm(p));
}

// ------------------------------------------------------------------ live updates
async function loadFeed() { feed = (await api('GET', `/events/history${projectQuery()}${projectQuery() ? '&' : '?'}limit=400`)).events; if (route === 'feed') render(); }

let timer = null;
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('event', (m) => {
    const e = JSON.parse(m.data);
    if (!e.projectId || e.projectId === S?.projectId) { feed.push(e); if (feed.length > 600) feed.shift(); }
    clearTimeout(timer); timer = setTimeout(() => load(false), 350);
  });
  es.onerror = () => { es.close(); setTimeout(connect, 2500); };
}

load(true).then(() => { connect(); loadFeed(); }).catch(() => { $('#page').replaceChildren(h('div', { class: 'card' }, 'Нет доступа. Открой ссылку с токеном из журнала сервиса (вида /?t=…).')); });
