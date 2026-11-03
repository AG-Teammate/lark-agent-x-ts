// Library entry: exports only the parts that run on both Node and Bun (login credentials, gateway client, message long connection, resource download, Lark Mail).
// The message DB (Bun.SQL) and the local agent (Bun.spawn) depend on Bun and are only used by the CLI; see docs/compat.md.
export { AuthExpired, LarkAuth, QR_STATUS_NAMES, QrLogin } from './auth.js';
export {
  type ChatMember,
  type ClientOptions,
  chatterName,
  type FeedGroup,
  type FlagItem,
  LarkClient,
  type MailChangeHandler,
  type MessageContent,
  type MessageHandler,
  type MessageHit,
  type MessageReactions,
  type MessageSearchOptions,
  type PinnedMessage,
  type ReactionHandler,
  type ReadState,
  type RecentChat,
  type ScheduledMessage,
  type SendOptions,
  SendUnconfirmed,
  type UnreadChat,
} from './client.js';
export { HttpError, NetworkError } from './http.js';
export { type Level, type LogSink, setLogLevel, setLogSink } from './log.js';
export {
  LarkMail,
  MAIL_LABELS,
  type MailAddress,
  type MailAttachment,
  type MailChangeOptions,
  type MailChangeResult,
  type MailDraft,
  type MailEvent,
  type MailEventKind,
  type MailFile,
  type MailLabel,
  type MailMessage,
  type MailSearchHit,
  type MailSearchOptions,
  type MailThread,
  type MailWatcher,
  type MailWatchOptions,
  type SendResult,
  toMailEvent,
} from './mail.js';
export {
  downloadMessageResource,
  extractResourceKey,
  type UploadedFile,
  uploadFile,
  uploadImage,
} from './media.js';
export {
  decide,
  type EffectiveRules,
  GROUPS,
  type Group,
  loadRules,
  PERMISSIONS,
  type Permission,
  PermissionDenied,
  type PermissionSource,
  permissionsPath,
  type Rules,
  saveAccountRules,
  type Verdict,
} from './permissions.js';
export type { EditableContent, RichBlock, RichRun, SearchHit } from './proto/builders.js';
export { contentDataJson, type LarkMessage, type ReactionEvent } from './proto/decoders.js';
export type { Dict } from './proto/dict.js';
export { getRegion, REGIONS, type Region } from './region.js';
