import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, loadConfig } from '../config.js';
import { getLogger } from '../log.js';
import { Storage } from '../storage/index.js';
import { head } from '../text.js';

const logger = getLogger('larkx.agent');

export interface AgentBackend {
  readonly name: string;
  run(sessionKey: string, prompt: string, chatId?: string, anchor?: string): Promise<string>;
  resetSession(sessionKey: string): Promise<void>;
}

export const CMD_TEMPLATE = 'claude -p --dangerously-skip-permissions';

/** RFC 4122 v5 UUID (equivalent to Python uuid.uuid5). */
export function uuid5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const hash = createHash('sha1')
    .update(Buffer.concat([ns, Buffer.from(name, 'utf8')]))
    .digest();
  hash[6] = ((hash[6] as number) & 0x0f) | 0x50;
  hash[8] = ((hash[8] as number) & 0x3f) | 0x80;
  const h = hash.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

/**
 * Local Claude Code backend: one agent session per chat boundary (session id derived deterministically from the session key), created with `--session-id` the first time,
 * then continued with `--resume`. The message is passed to `claude -p` via stdin, and the agent decides on its own whether to reply with `lark send`.
 */
export class ClaudeCodeBackend implements AgentBackend {
  readonly name = 'claude';

  constructor(
    readonly storage: Storage = new Storage(),
    readonly cmdTemplate = CMD_TEMPLATE,
  ) {}

  /** Older versions stored sessions in agent_sessions.json; on first start they are migrated into SQLite and the file is renamed and kept as a backup. */
  async migrateJsonSessions(): Promise<void> {
    const path = join(dataDir(), 'agent_sessions.json');
    if (!existsSync(path)) return;
    try {
      const old = JSON.parse(readFileSync(path, 'utf8')) as Record<
        string,
        { id?: string; started?: boolean }
      >;
      for (const [key, v] of Object.entries(old)) {
        const i = key.indexOf(':');
        let chatId = i < 0 ? key : key.slice(0, i);
        let anchor = i < 0 ? '' : key.slice(i + 1);
        if (key === 'global') [chatId, anchor] = ['global', ''];
        await this.storage.sessionUpsert(
          key,
          chatId,
          key !== chatId ? anchor : '',
          v.id ?? '',
          Boolean(v.started),
        );
      }
      renameSync(path, path.replace(/\.json$/, '.json.migrated'));
      logger.info('migrated agent_sessions.json to the SQLite session table');
    } catch (err) {
      logger.warning(`agent_sessions.json migration failed (ignored): ${(err as Error).message}`);
    }
  }

  private async session(sessionKey: string, chatId: string, anchor: string) {
    const row = await this.storage.sessionGet(sessionKey);
    if (!row) {
      const id = uuid5(NAMESPACE_URL, `larkx:${sessionKey}`);
      await this.storage.sessionUpsert(sessionKey, chatId, anchor, id, false);
      return { id, started: false };
    }
    return { id: row.agent_session_id, started: Boolean(row.started) };
  }

  async resetSession(sessionKey: string): Promise<void> {
    const row = await this.storage.sessionGet(sessionKey);
    if (row)
      await this.storage.sessionUpsert(sessionKey, row.chat_id, row.anchor, randomUUID(), false);
  }

  async run(sessionKey: string, prompt: string, chatId = '', anchor = ''): Promise<string> {
    const sess = await this.session(sessionKey, chatId, anchor);
    const args = [
      ...this.cmdTemplate.split(/\s+/).filter(Boolean),
      ...(sess.started ? ['--resume', sess.id] : ['--session-id', sess.id]),
    ];
    const flat = prompt.replaceAll('\n', ' ');
    logger.info(
      `calling agent [${sessionKey}]: ${args.join(' ')} << ${head(flat, 300)}${Array.from(prompt).length > 300 ? '…' : ''}`,
    );
    let proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
    try {
      proc = Bun.spawn(args, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: process.env });
    } catch {
      logger.error('claude CLI not found; make sure it is installed and on PATH');
      return '';
    }
    proc.stdin.write(prompt);
    await proc.stdin.end();
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      logger.error(`agent exited with non-zero code (${code}): ${head(err.trim(), 500)}`);
      return '';
    }
    if (!sess.started) await this.storage.sessionUpsert(sessionKey, chatId, anchor, sess.id, true);
    await this.storage.sessionTouch(sessionKey);
    return out.trim();
  }
}

export class NullBackend implements AgentBackend {
  readonly name = 'none';
  async run(): Promise<string> {
    return '';
  }
  async resetSession(): Promise<void> {}
}

export async function getBackend(name?: string, storage?: Storage): Promise<AgentBackend> {
  if ((name ?? loadConfig().agent_backend) === 'claude') {
    const backend = new ClaudeCodeBackend(storage);
    await backend.migrateJsonSessions();
    return backend;
  }
  return new NullBackend();
}
