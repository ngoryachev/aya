// Smoke check of the real SDK runner: one PM turn against an in-memory team and a fake executor.
import { Db } from '../src/db.js';
import { Team } from '../src/team.js';
import { Runtime } from '../src/runtime.js';
import { SdkRunner } from '../src/sdk-runner.js';
import { createProject, ensureBasics } from '../src/seed.js';

const team = new Team({ db: new Db(':memory:'), executors: {} });
ensureBasics(team);
team.onEvent((e) => console.log(`  [${e.type}] ${e.summary}`));
const runtime = new Runtime(team, new SdkRunner({ maxTurns: 15 }), { defaultModel: process.env.AYA_MODEL ?? null, maxConcurrent: 1 });
const p = createProject(team, { name: 'Смоук', goal: 'Сделать CLI-утилиту, которая считает слова в файле. Достаточно двух задач: сама утилита и README.', repoPath: null, executor: 'fake', team: [{ alias: 'Майя', role: 'pm' }] });
await runtime.settle(240_000);
console.log('tasks:', team.tasks(p.id).map((t) => `${t.title} deps=${team.deps(t.id).length}`));
console.log('runs:', team.db.query('SELECT status, cost_usd, turns, error, session_id FROM agent_runs'));
runtime.stop();
