import { AuthExpired } from '../auth.js';
import type { LarkClient, ReactionHandler } from '../client.js';
import { getLogger } from '../log.js';
import type { LarkMessage } from '../proto/decoders.js';
import { errorText } from './format.js';

const logger = getLogger('larkx.cli');

export interface ListenLoopOptions {
  /** Backfill messages after `since` (milliseconds) that were not received over the long connection. */
  missed: (since: number) => Promise<LarkMessage[]>;
  /** Reaction changes (optional). */
  onReaction?: ReactionHandler;
  /** Delay before reconnecting after a disconnect; default 10 seconds. */
  retryMs?: number;
  signal?: AbortSignal;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    const stop = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener('abort', stop, { once: true });
  });

/**
 * Persistent receive loop: reconnects after a disconnect and, once reconnected, backfills messages missed while disconnected.
 * Pushed and backfilled messages share one queue and are handed to onMessage serially, so when the same message arrives both ways, DB dedup never races a concurrent insert.
 * Throws when credentials are invalid (AuthExpired); returns when the signal aborts.
 */
export async function keepListening(
  c: LarkClient,
  onMessage: (msg: LarkMessage) => Promise<void>,
  o: ListenLoopOptions,
): Promise<void> {
  let queue = Promise.resolve();
  const enqueue = (msg: LarkMessage) => {
    queue = queue
      .then(() => onMessage(msg))
      .catch((e) => logger.error(`failed to handle message: ${errorText(e)}`));
    return queue;
  };
  const backfill = async (since: number) => {
    try {
      const missed = await o.missed(since);
      for (const msg of missed) await enqueue(msg);
      if (missed.length)
        logger.info(
          `caught up on ${missed.length} messages missed while disconnected (duplicates are skipped)`,
        );
    } catch (e) {
      logger.warning(`failed to catch up on messages missed while disconnected: ${errorText(e)}`);
    }
  };
  // Back off one heartbeat timeout from the disconnect time: the connection may have dropped before it was noticed
  let disconnectedAt: number | undefined;
  let pending = Promise.resolve();
  const onOpen = () => {
    if (disconnectedAt === undefined) return;
    const since = disconnectedAt;
    disconnectedAt = undefined;
    pending = backfill(since);
  };
  while (!o.signal?.aborted) {
    try {
      await c.connectWebsocket(enqueue, o.signal, onOpen, o.onReaction);
      if (o.signal?.aborted) break;
      logger.warning('WS connection closed, reconnecting');
    } catch (e) {
      if (e instanceof AuthExpired) throw e;
      logger.warning(
        `WS disconnected, reconnecting in ${(o.retryMs ?? 10_000) / 1000}s: ${(e as Error).message}`,
      );
    }
    disconnectedAt ??= Date.now() - c.wsTiming.idleTimeoutMs;
    await sleep(o.retryMs ?? 10_000, o.signal);
  }
  await pending;
  await queue;
}
