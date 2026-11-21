#!/usr/bin/env node
import './quiet.js';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { Db } from './db.js';
import { Team } from './team.js';
import { Runtime } from './runtime.js';
import { SdkRunner } from './sdk-runner.js';
import { SdlcExecutor, type Executor } from './executor.js';
import { createHttpApp, ensureToken } from './http.js';
import { ensureBasics } from './seed.js';

function arg(name: string, def?: string): string | undefined { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }

async function main() {
  const cmd = process.argv[2] ?? 'serve';
  if (cmd !== 'serve') { console.log('usage: aya serve [--port 7450] [--host 127.0.0.1] [--home ~/.aya] [--model <id>]'); process.exit(cmd === 'help' ? 0 : 1); }
  const home = arg('home', process.env.AYA_HOME ?? path.join(os.homedir(), '.aya'))!;
  const port = Number(arg('port', process.env.AYA_PORT ?? '7450'));
  const host = arg('host', process.env.AYA_HOST ?? '127.0.0.1')!;

  const executors: Record<string, Executor> = {};
  try { executors.sdlc = SdlcExecutor.fromLocalConfig(); } catch (e) { console.warn(`[aya] sdlc is not available as an executor: ${e instanceof Error ? e.message : String(e)}`); }

  const team = new Team({ db: new Db(path.join(home, 'aya.db')), executors });
  ensureBasics(team);
  const runtime = new Runtime(team, new SdkRunner(), { defaultModel: arg('model', process.env.AYA_MODEL) ?? null });
  const app = createHttpApp(team, runtime);
  runtime.recover();
  team.exec.startTicker(Number(process.env.AYA_SYNC_MS ?? 5000));

  serve({ fetch: app.fetch, port, hostname: host }, () => {
    console.log(`[aya] data: ${home}`);
    console.log(`[aya] open: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/?t=${ensureToken(team)}`);
  });
  const stop = () => { runtime.stop(); team.exec.stopTicker(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
