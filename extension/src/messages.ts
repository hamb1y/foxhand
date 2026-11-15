/* Foxhand: the message shapes shared by the add-on's scripts (types only; nothing here is emitted).
 *
 *   helper <-> background : shared/src/protocol.ts (BridgeMethod, BRIDGE_ERRORS, ...)
 *   background -> content : ContentMessage ({kind: ...}), answered with a ContentEnvelope
 *   pages -> background   : UiMessage ({type: ...}), answered with a Status (or a SetConfigError)
 */
import type { BRIDGE_ERRORS, BridgeMethod, HostStatusMessage } from '../../shared/src/protocol';

export type { BridgeMethod };

/** Every error code the helper protocol knows. */
export type BridgeErrorCode = (typeof BRIDGE_ERRORS)[keyof typeof BRIDGE_ERRORS];

/** An Error carrying a bridge error code (what `be()` builds). */
export interface CodedError extends Error { code: string; }

/** What a caught value is treated as when its code/message are read (catch variables are unknown). */
export type ErrObj = { code?: unknown; message?: unknown };
export type ErrLike = ErrObj | null | undefined;

/** The params of a bridge command, as received from the helper (not validated yet). */
export type BridgeParams = Record<string, unknown>;

/* ------------------------------------------------------- background -> content */

/** How an action names its element: a snapshot ref, selector, accessible name (+ role, nth) or a point. */
export interface TargetFields {
  ref?: number;
  selector?: string;
  name?: string;
  role?: string;
  nth?: number;
  x?: number;
  y?: number;
  generation?: string;
  waitMs?: number;
}

/** Fields the background may add to any content message. */
export interface ContentCommon {
  /** Set only while the AI cursor is on; `note` is the model's own words. */
  cursor?: { note: string };
  /** The command id, so a cancel from the helper can reach the page. */
  opId?: string;
  dialog?: 'accept' | 'dismiss';
  promptText?: string;
  /** false turns the "what changed" report off. */
  changes?: boolean;
  frameProbe?: boolean;
  _notes?: string[];
}

export interface FormFieldSpec extends TargetFields {
  value?: unknown;
  values?: unknown;
  checked?: unknown;
  [extra: string]: unknown;
}

export interface UploadFile {
  name?: string;
  base64?: string;
  text?: string;
  mimeType?: string;
}

type Msg<K extends string, F> = { kind: K } & F & ContentCommon;

export type ContentMessage =
  | Msg<'ax-snapshot', { compact?: boolean; maxChars?: number; viewportOnly?: boolean; within?: TargetFields }>
  | Msg<'page-text', { maxChars?: number; offset?: number; format?: string; within?: TargetFields; withFrames?: boolean }>
  | Msg<'page-html', { maxChars?: number; selector?: string; within?: TargetFields; generation?: string }>
  | Msg<'page-storage', { op: 'get' | 'set' | 'remove'; area: 'local' | 'session'; key?: string; value?: unknown }>
  | Msg<'page-metrics', unknown>
  | Msg<'target-candidate', TargetFields & { text?: string; files?: UploadFile[]; fields?: FormFieldSpec[] }>
  | Msg<'element-rect', TargetFields>
  | Msg<'act-click', TargetFields & { button?: string; double?: boolean; modifiers?: string | string[] }>
  | Msg<'act-type', TargetFields & { text?: string; append?: boolean; submit?: boolean; submitRef?: number; submitSelector?: string; submitName?: string }>
  | Msg<'act-fillForm', { fields?: FormFieldSpec[]; submit?: boolean; generation?: string; submitRef?: number; submitSelector?: string; submitName?: string }>
  | Msg<'act-select', TargetFields & { values?: string[] }>
  | Msg<'act-hover', TargetFields>
  | Msg<'act-scroll', TargetFields & { direction?: string; pixels?: number; to?: string }>
  | Msg<'act-key', TargetFields & { key?: string; modifiers?: string | string[]; times?: number }>
  | Msg<'act-wait', TargetFields & { text?: string; gone?: boolean; timeoutMs?: number }>
  | Msg<'act-find', { query?: string; withFrames?: boolean }>
  | Msg<'act-drag', TargetFields & { toRef?: number; toSelector?: string; toName?: string; toRole?: string; toX?: number; toY?: number }>
  | Msg<'act-upload', TargetFields & { files?: UploadFile[] }>
  | Msg<'cursor', { op: 'say' | 'conceal' | 'reveal' | 'hide'; note?: string }>
  | Msg<'cancel', unknown>;

export type ContentKind = ContentMessage['kind'];

/** The content script's answer, wrapped so the background can tell it from a browser error. */
export type ContentEnvelope =
  | { __fxmcp: true; ok: true; result: unknown }
  | { __fxmcp: true; ok: false; error: { code: string; message: string } };

/* ------------------------------------------------------------ pages -> background */

export type UiMessage =
  | { type: 'get-status' }
  | { type: 'probe' }
  | { type: 'reconnect' }
  | { type: 'regenerate-token' }
  | { type: 'set-paused'; paused: boolean }
  | { type: 'announcement-get' }
  | { type: 'announcement-shown'; id: string }
  | {
      type: 'set-config';
      port?: number | string;
      bind?: string;
      allowWsl?: boolean;
      confirmDestructive?: boolean;
      showCursor?: boolean;
    };

/** The helper's last hostStatus message. */
export type HostStatus = HostStatusMessage['hostStatus'];

/** What the settings page, popup and onboarding show (the background's statusSnapshot()). */
export interface Status {
  version: string;
  protocol: number;
  compat: { state: string; helper?: string; addon?: string };
  platform: { os: string; arch: string };
  hostMissing: boolean;
  connected: boolean;
  starting: boolean;
  listening: boolean;
  host: HostStatus | null;
  url: string;
  token: string;
  port: number;
  bind: string;
  allowWsl: boolean;
  confirmDestructive: boolean;
  showCursor: boolean;
  paused: boolean;
  now: { text: string; site?: string; tabId?: number; at: number; active: boolean } | null;
  defaults: { port: number; bind: string };
  lastError: string;
  connectedAt: number;
  commands: number;
  events: Array<{ at: number; text: string; level: string; site: string; count?: number }>;
}

/** A settings write that was refused. */
export interface SetConfigError { error: string; field?: 'port' | 'bind'; }
