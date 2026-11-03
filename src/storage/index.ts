import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SQL } from 'bun';
import { loadConfig } from '../config.js';
import { contentDataJson, type LarkMessage } from '../proto/decoders.js';

/**
 * Local storage (same tables and columns as the original project's SQLAlchemy models, so DBs written by the Python version can be reused directly):
 * messages (messages), chats (chat names and latest position), agent_sessions (the digital twin's agent sessions).
 * Connection strings follow the original project's SQLAlchemy format: `sqlite:///relative/path`, `sqlite:////absolute/path`, `mysql+pymysql://user:pass@host:3306/db`.
 */

export interface MessageRow {
  id: number;
  msg_id: string;
  chat_id: string;
  chat_name: string;
  chat_type: number;
  scope: string;
  anchor: string;
  root_id: string;
  parent_id: string;
  sender_id: string;
  sender_name: string;
  msg_type: number;
  msg_type_name: string;
  content: string;
  content_data: string;
  position: number;
  create_time: number;
  direction: string;
  stored_at: string;
}

export interface ChatRow {
  chat_id: string;
  name: string;
  chat_type: number;
  last_position: number;
  updated_at: string;
}

export interface AgentSessionRow {
  session_key: string;
  chat_id: string;
  anchor: string;
  agent_session_id: string;
  started: number;
  msg_count: number;
  created_at: string;
  last_active: string;
}

type Dialect = 'sqlite' | 'mysql';

/** Content stored in the DB for recalled messages. */
export const RECALLED = '[已撤回]';

/** SQLAlchemy-style connection string → Bun.SQL connection string and dialect. */
export function parseStorageUrl(url: string): { dialect: Dialect; url: string } {
  const sqlite = /^sqlite:\/\/\/(.*)$/.exec(url);
  if (sqlite) {
    const path = sqlite[1] as string;
    if (!path || path === ':memory:') return { dialect: 'sqlite', url: ':memory:' };
    // sqlite:///rel → relative to the current directory; sqlite:////abs → absolute path
    return { dialect: 'sqlite', url: `sqlite://${resolve(path)}` };
  }
  const mysql = /^mysql(?:\+\w+)?:\/\/(.*)$/.exec(url);
  if (mysql) return { dialect: 'mysql', url: `mysql://${mysql[1]}` };
  throw new Error(`不支持的存储连接串: ${url}(支持 sqlite:/// 与 mysql://)`);
}

/** Format SQLAlchemy uses to write DateTime: local time `YYYY-MM-DD HH:MM:SS.ffffff`. */
export function nowStamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds() * 1000, 6)}`;
}

/**
 * Rows read back are normalized to their SQLite shape: the MySQL driver parses DATETIME in the local time zone into a Date (its local-time components are the literal DB value),
 * which is formatted back to `YYYY-MM-DD HH:MM:SS[.ffffff]`; BIGINT returned as bigint is converted to number (timestamps and positions are within the safe integer range).
 */
function normalizeRow<T>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (v instanceof Date) {
      const ms = v.getMilliseconds();
      out[k] = nowStamp(v).replace(/\.\d{6}$/, ms ? `.${String(ms * 1000).padStart(6, '0')}` : '');
    } else out[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return out as T;
}

const rows = <T>(result: unknown): T[] => (result as T[]).map(normalizeRow);

const SCHEMA: Record<Dialect, string[]> = {
  sqlite: [
    `CREATE TABLE IF NOT EXISTS messages (
	id INTEGER NOT NULL, 
	msg_id VARCHAR(32) NOT NULL, 
	chat_id VARCHAR(32) NOT NULL, 
	chat_name VARCHAR(256), 
	chat_type INTEGER, 
	scope VARCHAR(8), 
	anchor VARCHAR(32), 
	root_id VARCHAR(32), 
	parent_id VARCHAR(32), 
	sender_id VARCHAR(32), 
	sender_name VARCHAR(256), 
	msg_type INTEGER, 
	msg_type_name VARCHAR(32), 
	content TEXT, 
	content_data TEXT, 
	position INTEGER, 
	create_time BIGINT, 
	direction VARCHAR(4), 
	stored_at DATETIME, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_msg_chat UNIQUE (msg_id, chat_id)
)`,
    'CREATE INDEX IF NOT EXISTS ix_messages_anchor ON messages (anchor)',
    'CREATE INDEX IF NOT EXISTS ix_chat_anchor_time ON messages (chat_id, anchor, create_time)',
    'CREATE INDEX IF NOT EXISTS ix_messages_chat_id ON messages (chat_id)',
    `CREATE TABLE IF NOT EXISTS chats (
	chat_id VARCHAR(32) NOT NULL, 
	name VARCHAR(256), 
	chat_type INTEGER, 
	last_position INTEGER, 
	updated_at DATETIME, 
	PRIMARY KEY (chat_id)
)`,
    `CREATE TABLE IF NOT EXISTS agent_sessions (
	session_key VARCHAR(80) NOT NULL, 
	chat_id VARCHAR(32), 
	anchor VARCHAR(32), 
	agent_session_id VARCHAR(64), 
	started INTEGER, 
	msg_count INTEGER, 
	created_at DATETIME, 
	last_active DATETIME, 
	PRIMARY KEY (session_key)
)`,
    'CREATE INDEX IF NOT EXISTS ix_agent_sessions_chat_id ON agent_sessions (chat_id)',
  ],
  mysql: [
    `CREATE TABLE IF NOT EXISTS messages (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	msg_id VARCHAR(32) NOT NULL, 
	chat_id VARCHAR(32) NOT NULL, 
	chat_name VARCHAR(256), 
	chat_type INTEGER, 
	scope VARCHAR(8), 
	anchor VARCHAR(32), 
	root_id VARCHAR(32), 
	parent_id VARCHAR(32), 
	sender_id VARCHAR(32), 
	sender_name VARCHAR(256), 
	msg_type INTEGER, 
	msg_type_name VARCHAR(32), 
	content TEXT, 
	content_data TEXT, 
	position INTEGER, 
	create_time BIGINT, 
	direction VARCHAR(4), 
	stored_at DATETIME, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_msg_chat UNIQUE (msg_id, chat_id), 
	INDEX ix_messages_anchor (anchor), 
	INDEX ix_chat_anchor_time (chat_id, anchor, create_time), 
	INDEX ix_messages_chat_id (chat_id)
)`,
    `CREATE TABLE IF NOT EXISTS chats (
	chat_id VARCHAR(32) NOT NULL, 
	name VARCHAR(256), 
	chat_type INTEGER, 
	last_position INTEGER, 
	updated_at DATETIME, 
	PRIMARY KEY (chat_id)
)`,
    `CREATE TABLE IF NOT EXISTS agent_sessions (
	session_key VARCHAR(80) NOT NULL, 
	chat_id VARCHAR(32), 
	anchor VARCHAR(32), 
	agent_session_id VARCHAR(64), 
	started INTEGER, 
	msg_count INTEGER, 
	created_at DATETIME, 
	last_active DATETIME, 
	PRIMARY KEY (session_key), 
	INDEX ix_agent_sessions_chat_id (chat_id)
)`,
  ],
};

export interface SaveOptions {
  senderName?: string;
  chatName?: string;
  direction?: 'in' | 'out';
}

export class Storage {
  private readonly sql: SQL;
  private readonly dialect: Dialect;
  private ready: Promise<void> | undefined;

  constructor(readonly url: string = loadConfig().storage_url) {
    const parsed = parseStorageUrl(url);
    this.dialect = parsed.dialect;
    if (parsed.dialect === 'sqlite' && parsed.url !== ':memory:')
      mkdirSync(dirname(parsed.url.slice('sqlite://'.length)), { recursive: true });
    this.sql = new SQL(parsed.url);
  }

  /** Create tables on first use (skipped if they already exist). */
  private init(): Promise<void> {
    this.ready ??= (async () => {
      // Same as pysqlite's default: wait up to 5 seconds when the DB is locked by another process (listen / send / niuma)
      if (this.dialect === 'sqlite') await this.sql.unsafe('PRAGMA busy_timeout = 5000');
      for (const ddl of SCHEMA[this.dialect]) await this.sql.unsafe(ddl);
    })();
    return this.ready;
  }

  async close(): Promise<void> {
    await this.sql.close();
  }

  /**
   * Save a message; returns whether it counts as a first insert. Records written first by `lark send` have no position; when the WS echo arrives it fills them in and counts as a first insert.
   */
  async saveMessage(msg: LarkMessage, o: SaveOptions = {}): Promise<boolean> {
    await this.init();
    const fields = {
      msg_id: String(msg.msg_id),
      chat_id: String(msg.chat_id),
      chat_name: o.chatName || '',
      chat_type: msg.chat_type ?? 0,
      scope: msg.scope ?? 'chat',
      anchor: msg.anchor || '',
      root_id: msg.root_id || '',
      parent_id: msg.parent_id || '',
      sender_id: String(msg.from_id || ''),
      sender_name: o.senderName || '',
      msg_type: msg.msg_type ?? 0,
      msg_type_name: msg.msg_type_name ?? '',
      content: msg.content || '',
      content_data: contentDataJson(msg.content_data),
      position: msg.position || 0,
      create_time: msg.create_time || 0,
      direction: o.direction ?? 'in',
    };
    return this.sql.begin(async (tx) => {
      const [row] =
        (await tx`SELECT id, position FROM messages WHERE msg_id = ${fields.msg_id} AND chat_id = ${fields.chat_id} LIMIT 1`) as Pick<
          MessageRow,
          'id' | 'position'
        >[];
      if (row) {
        if (row.position || !fields.position) return false;
        await tx`UPDATE messages SET ${tx(fields)} WHERE id = ${row.id}`;
      } else {
        await tx`INSERT INTO messages ${tx({ ...fields, stored_at: nowStamp() })}`;
      }
      await Storage.touchChat(tx, fields);
      return true;
    });
  }

  /** A locally stored message was recalled: replace its content with "[已撤回]". Returns whether it existed locally (and was not already marked). */
  async markRecalled(msgId: string, chatId: string): Promise<boolean> {
    await this.init();
    return this.sql.begin(async (tx) => {
      const [row] =
        (await tx`SELECT id, content FROM messages WHERE msg_id = ${msgId} AND chat_id = ${chatId} LIMIT 1`) as Pick<
          MessageRow,
          'id' | 'content'
        >[];
      if (!row || row.content === RECALLED) return false;
      await tx`UPDATE messages SET content = ${RECALLED}, content_data = '' WHERE id = ${row.id}`;
      return true;
    });
  }

  /** A locally stored message was edited: replace it with the new content. Returns whether anything was updated (false if not stored locally or the content is unchanged). */
  async reviseMessage(msg: LarkMessage): Promise<boolean> {
    await this.init();
    const content = msg.content || '';
    const data = contentDataJson(msg.content_data);
    return this.sql.begin(async (tx) => {
      const [row] =
        (await tx`SELECT id, content FROM messages WHERE msg_id = ${String(msg.msg_id)} AND chat_id = ${String(msg.chat_id)} LIMIT 1`) as Pick<
          MessageRow,
          'id' | 'content'
        >[];
      if (!row || row.content === content) return false;
      await tx`UPDATE messages SET content = ${content}, content_data = ${data} WHERE id = ${row.id}`;
      return true;
    });
  }

  private static async touchChat(
    tx: SQL,
    row: { chat_id: string; chat_type: number; chat_name: string; position: number },
  ): Promise<void> {
    const [chat] =
      (await tx`SELECT name, last_position FROM chats WHERE chat_id = ${row.chat_id}`) as Pick<
        ChatRow,
        'name' | 'last_position'
      >[];
    const now = nowStamp();
    if (!chat) {
      await tx`INSERT INTO chats ${tx({
        chat_id: row.chat_id,
        name: row.chat_name,
        chat_type: row.chat_type,
        last_position: row.position || 0,
        updated_at: now,
      })}`;
      return;
    }
    const name = row.chat_name && !chat.name ? row.chat_name : chat.name;
    const lastPosition =
      row.position && row.position > (chat.last_position || 0) ? row.position : chat.last_position;
    await tx`UPDATE chats SET name = ${name}, last_position = ${lastPosition}, updated_at = ${now} WHERE chat_id = ${row.chat_id}`;
  }

  async updateChatName(chatId: string, name: string, chatType = 0): Promise<void> {
    await this.init();
    await this.sql.begin(async (tx) => {
      const [chat] = (await tx`SELECT name FROM chats WHERE chat_id = ${chatId}`) as Pick<
        ChatRow,
        'name'
      >[];
      if (!chat) {
        await tx`INSERT INTO chats ${tx({ chat_id: chatId, name, chat_type: chatType, last_position: 0, updated_at: nowStamp() })}`;
      } else if (chat.name !== name) {
        await tx`UPDATE chats SET name = ${name}, updated_at = ${nowStamp()} WHERE chat_id = ${chatId}`;
      }
    });
  }

  async listChats(limit = 50): Promise<ChatRow[]> {
    await this.init();
    return rows<ChatRow>(
      await this.sql`SELECT * FROM chats ORDER BY updated_at DESC LIMIT ${limit}`,
    );
  }

  /** The latest `limit` messages of a chat (restricted to a thread when anchor is not undefined; empty string = main chat stream only), in ascending time order. */
  async getMessages(
    chatId: string,
    o: { anchor?: string | undefined; limit?: number; beforeTs?: number } = {},
  ): Promise<MessageRow[]> {
    await this.init();
    const anchor = o.anchor === undefined ? this.sql`` : this.sql`AND anchor = ${o.anchor}`;
    const before = o.beforeTs ? this.sql`AND create_time < ${o.beforeTs}` : this.sql``;
    return rows<MessageRow>(
      await this
        .sql`SELECT * FROM messages WHERE chat_id = ${chatId} ${anchor} ${before} ORDER BY create_time DESC LIMIT ${o.limit ?? 50}`,
    ).reverse();
  }

  async getMessage(msgId: string, chatId?: string): Promise<MessageRow | undefined> {
    await this.init();
    const chat = chatId ? this.sql`AND chat_id = ${chatId}` : this.sql``;
    return rows<MessageRow>(
      await this.sql`SELECT * FROM messages WHERE msg_id = ${msgId} ${chat} LIMIT 1`,
    )[0];
  }

  async findMessages(msgId: string): Promise<MessageRow[]> {
    await this.init();
    return rows<MessageRow>(await this.sql`SELECT * FROM messages WHERE msg_id = ${msgId}`);
  }

  /** Max position already stored locally for the chat (chats.last_position); -1 if there is no record (chat positions start at 0, and 0 is also a message). */
  async lastPosition(chatId: string): Promise<number> {
    await this.init();
    const [chat] = (await this
      .sql`SELECT last_position FROM chats WHERE chat_id = ${chatId}`) as Pick<
      ChatRow,
      'last_position'
    >[];
    return chat?.last_position ? Number(chat.last_position) : -1;
  }

  /** Threads (anchors) in the chat with recent messages, ordered by latest message time, newest first. */
  async recentAnchors(chatId: string, limit = 20): Promise<string[]> {
    await this.init();
    const found = (await this.sql`SELECT anchor, MAX(create_time) AS t FROM messages
      WHERE chat_id = ${chatId} AND scope = 'topic' AND anchor <> ''
      GROUP BY anchor ORDER BY t DESC LIMIT ${limit}`) as { anchor: string }[];
    return found.map((r) => r.anchor);
  }

  async getChatName(chatId: string): Promise<string> {
    await this.init();
    const [chat] = (await this.sql`SELECT name FROM chats WHERE chat_id = ${chatId}`) as Pick<
      ChatRow,
      'name'
    >[];
    return chat?.name ?? '';
  }

  async sessionGet(sessionKey: string): Promise<AgentSessionRow | undefined> {
    await this.init();
    return rows<AgentSessionRow>(
      await this.sql`SELECT * FROM agent_sessions WHERE session_key = ${sessionKey}`,
    )[0];
  }

  async sessionUpsert(
    sessionKey: string,
    chatId: string,
    anchor: string,
    agentSessionId: string,
    started: boolean,
  ): Promise<void> {
    await this.init();
    await this.sql.begin(async (tx) => {
      const [row] =
        (await tx`SELECT session_key FROM agent_sessions WHERE session_key = ${sessionKey}`) as unknown[];
      const now = nowStamp();
      if (!row) {
        await tx`INSERT INTO agent_sessions ${tx({
          session_key: sessionKey,
          chat_id: chatId,
          anchor: anchor || '',
          agent_session_id: agentSessionId,
          started: started ? 1 : 0,
          msg_count: 0,
          created_at: now,
          last_active: now,
        })}`;
      } else {
        await tx`UPDATE agent_sessions SET agent_session_id = ${agentSessionId}, started = ${started ? 1 : 0}, last_active = ${now} WHERE session_key = ${sessionKey}`;
      }
    });
  }

  async sessionTouch(sessionKey: string): Promise<void> {
    await this.init();
    await this
      .sql`UPDATE agent_sessions SET msg_count = COALESCE(msg_count, 0) + 1, last_active = ${nowStamp()} WHERE session_key = ${sessionKey}`;
  }

  async listSessions(limit = 50): Promise<AgentSessionRow[]> {
    await this.init();
    return rows<AgentSessionRow>(
      await this.sql`SELECT * FROM agent_sessions ORDER BY last_active DESC LIMIT ${limit}`,
    );
  }
}
