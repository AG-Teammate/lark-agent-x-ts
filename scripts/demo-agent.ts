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
  console.error('usage: bun scripts/demo-agent.ts --chat <chat_id> [--live]');
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
  content:
    'Are you there? Help me check the digital twin pipeline: when you get this, just reply "pipeline OK"',
  content_data: null,
  _chat_name: 'Demo chat',
  _sender_name: 'Colleague A',
};
const cases: [string, AgentMessage][] = [
  ['Case 1: explicit reply request', base],
  [
    'Case 2: small talk only (should not reply)',
    { ...base, msg_id: '7666600000000000002', content: 'Have a nice weekend~ get some rest 😄' },
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
  console.log(
    '>>> reply_fn called (the agent should run lark send itself and never reach this):',
    text,
  );
});
for (const [title, msg] of cases) {
  console.log(`${'='.repeat(20)} ${title} ${'='.repeat(20)}`);
  console.log(buildXmlMessage(msg));
  console.log('-'.repeat(60));
  await dispatcher.handleMessage('demo:final', msg);
  console.log();
}
console.log(`${'='.repeat(20)} full prompt fed to the agent (case 1) ${'='.repeat(20)}`);
console.log(backend.prompts[0]);
