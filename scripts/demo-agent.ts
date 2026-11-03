import { parseArgs } from 'node:util';
import { type AgentBackend, getBackend } from '../src/agent/backend.js';
import { AgentDispatcher, type AgentMessage, buildXmlMessage } from '../src/agent/dispatcher.js';

/**
 * Digital-twin pipeline demo (ported from the fork's dev/demo_agent_flow.py and demo_pipe_flow.py): hands two sample
 * messages (an explicit reply request / pure small talk) to the agent and prints the full prompt it receives.
 * By default it only prints without calling; with `--live` it uses the real backend (Claude Code decides on its own
 * whether to run `lark send` back to the chat given by --chat).
 *
 *   bun scripts/demo-agent.ts --chat <chat_id> [--live]
 */
const { values } = parseArgs({
  options: { chat: { type: 'string' }, live: { type: 'boolean', default: false } },
});
if (!values.chat) {
  console.error('用法: bun scripts/demo-agent.ts --chat <chat_id> [--live]');
  process.exit(2);
}

const base: AgentMessage = {
  msg_id: '7666600000000000001',
  msg_type: 4,
  msg_type_name: 'TEXT',
  from_id: '7314999000000000001',
  chat_id: values.chat,
  chat_type: 1,
  chat_type_name: 'P2P',
  scope: 'chat',
  anchor: '',
  at_me: false,
  root_id: '',
  parent_id: '',
  cid: '',
  position: 1,
  create_time: 1785003200,
  content: '在吗?帮我验证下数字人链路:收到这条后回我一句"链路正常"就行',
  content_data: null,
  _chat_name: '演示会话',
  _sender_name: '同事甲',
};
const cases: [string, AgentMessage][] = [
  ['案例 1: 明确要求回复', base],
  [
    '案例 2: 纯寒暄(不该回)',
    { ...base, msg_id: '7666600000000000002', content: '周末愉快呀~ 好好休息😄' },
  ],
];

/** Record every prompt fed to the agent; without --live the real backend is not called. */
class SpyBackend implements AgentBackend {
  readonly name = 'spy';
  readonly prompts: string[] = [];
  constructor(private readonly inner: AgentBackend | null) {}
  async run(key: string, prompt: string, chatId?: string, anchor?: string): Promise<string> {
    this.prompts.push(prompt);
    return this.inner ? this.inner.run(key, prompt, chatId, anchor) : '';
  }
  async resetSession(key: string): Promise<void> {
    await this.inner?.resetSession(key);
  }
}

const backend = new SpyBackend(values.live ? await getBackend() : null);
const dispatcher = new AgentDispatcher(backend, async (_chatId, text) => {
  console.log('>>> reply_fn 被调用(agent 应自己执行 lark send,不该走到这里):', text);
});
for (const [title, msg] of cases) {
  console.log(`${'='.repeat(20)} ${title} ${'='.repeat(20)}`);
  console.log(buildXmlMessage(msg));
  console.log('-'.repeat(60));
  await dispatcher.handleMessage('demo:final', msg);
  console.log();
}
console.log(`${'='.repeat(20)} 喂给 agent 的完整提示词(案例 1) ${'='.repeat(20)}`);
console.log(backend.prompts[0]);
