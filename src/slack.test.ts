import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('../../../dist/orchestrator/channel-registry.js', () => ({ registerChannel: vi.fn() }));

// Mock config
vi.mock('../../../dist/orchestrator/config.js', () => ({
  ASSISTANT_NAME: 'Jonesy',
  TRIGGER_PATTERN: /^@Jonesy\b/i,
  GROUPS_DIR: '/test/groups',
}));

// Mock logger
vi.mock('../../../dist/orchestrator/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock db
vi.mock('../../../dist/orchestrator/db.js', () => ({
  updateChatName: vi.fn(),
}));

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// --- @slack/bolt mock ---

type Handler = (...args: any[]) => any;

const appRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@slack/bolt', () => ({
  App: class MockApp {
    eventHandlers = new Map<string, Handler>();
    token: string;
    appToken: string;

    client = {
      auth: {
        test: vi
          .fn()
          .mockResolvedValue({ user_id: 'U_BOT_123', bot_id: 'B_BOT_123' }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue(undefined),
      },
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [],
          response_metadata: {},
        }),
      },
      users: {
        info: vi.fn().mockResolvedValue({
          user: { real_name: 'Alice Smith', name: 'alice' },
        }),
      },
      files: {
        info: vi.fn().mockResolvedValue({
          file: {
            id: 'F_FILE_123',
            name: 'report.pdf',
            url_private_download: 'https://files.slack.com/files-pri/T123/F123/report.pdf',
            mimetype: 'application/pdf',
            size: 204800, // 200 KB
            user: 'U_USER_456',
          },
        }),
      },
    };

    constructor(opts: any) {
      this.token = opts.token;
      this.appToken = opts.appToken;
      appRef.current = this;
    }

    event(name: string, handler: Handler) {
      this.eventHandlers.set(name, handler);
    }

    async start() {}
    async stop() {}
  },
  LogLevel: { ERROR: 'error' },
}));

// Mock env
vi.mock('../../../dist/orchestrator/env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    SLACK_BOT_TOKEN: 'xoxb-test-token',
    SLACK_APP_TOKEN: 'xapp-test-token',
  }),
}));

import { SlackChannel, SlackChannelOpts } from './slack.js';
import { updateChatName } from '../../../dist/orchestrator/db.js';
import { readEnvFile } from '../../../dist/orchestrator/env.js';
import * as fs from 'node:fs/promises';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<SlackChannelOpts>,
): SlackChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'slack:C0123456789': {
        name: 'Test Channel',
        folder: 'test-channel',
        trigger: '@Jonesy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createMessageEvent(overrides: {
  channel?: string;
  channelType?: string;
  user?: string;
  text?: string;
  ts?: string;
  threadTs?: string;
  subtype?: string;
  botId?: string;
}) {
  return {
    channel: overrides.channel ?? 'C0123456789',
    channel_type: overrides.channelType ?? 'channel',
    user: overrides.user ?? 'U_USER_456',
    text: 'text' in overrides ? overrides.text : 'Hello everyone',
    ts: overrides.ts ?? '1704067200.000000',
    thread_ts: overrides.threadTs,
    subtype: overrides.subtype,
    bot_id: overrides.botId,
  };
}

function currentApp() {
  return appRef.current;
}

async function triggerMessageEvent(
  event: ReturnType<typeof createMessageEvent>,
) {
  const handler = currentApp().eventHandlers.get('message');
  if (handler) await handler({ event });
}

async function triggerFileSharedEvent(event: {
  file_id?: string;
  channel_id?: string;
}) {
  const handler = currentApp().eventHandlers.get('file_shared');
  if (handler) await handler({ event });
}

// --- Mock fetch ---

let mockFetch: ReturnType<typeof vi.fn>;

// --- Tests ---

describe('SlackChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(1024)),
    });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when app starts', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers message event handler on construction', () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      expect(currentApp().eventHandlers.has('message')).toBe(true);
    });

    it('gets bot user ID on connect', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();

      expect(currentApp().client.auth.test).toHaveBeenCalled();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers message for registered channel', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'Hello everyone' });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.any(String),
        undefined,
        'slack',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          id: '1704067200.000000',
          chat_jid: 'slack:C0123456789',
          sender: 'U_USER_456',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered channels', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ channel: 'C9999999999' });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:C9999999999',
        expect.any(String),
        undefined,
        'slack',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips non-text subtypes (channel_join, etc.)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ subtype: 'channel_join' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('allows bot_message subtype through', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        subtype: 'bot_message',
        botId: 'B_OTHER_BOT',
        text: 'Bot message',
      });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalled();
    });

    it('skips messages with no text', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: undefined as any });
      await triggerMessageEvent(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('detects bot messages by bot_id', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        subtype: 'bot_message',
        botId: 'B_BOT_123',
        text: 'Bot response',
      });
      await triggerMessageEvent(event);

      // Has matching bot_id so should be marked as bot message
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
          sender_name: 'Jonesy',
        }),
      );
    });

    it('detects bot messages by matching bot user ID', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        user: 'U_BOT_123',
        text: 'Self message',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
        }),
      );
    });

    it('identifies IM channel type as non-group', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'slack:D0123456789': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Jonesy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        channel: 'D0123456789',
        channelType: 'im',
      });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:D0123456789',
        expect.any(String),
        undefined,
        'slack',
        false, // IM is not a group
      );
    });

    it('converts ts to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ ts: '1704067200.000000' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });

    it('resolves user name from Slack API', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ user: 'U_USER_456', text: 'Hello' });
      await triggerMessageEvent(event);

      expect(currentApp().client.users.info).toHaveBeenCalledWith({
        user: 'U_USER_456',
      });
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          sender_name: 'Alice Smith',
        }),
      );
    });

    it('caches user names to avoid repeated API calls', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // First message — API call
      await triggerMessageEvent(
        createMessageEvent({ user: 'U_USER_456', text: 'First' }),
      );
      // Second message — should use cache
      await triggerMessageEvent(
        createMessageEvent({
          user: 'U_USER_456',
          text: 'Second',
          ts: '1704067201.000000',
        }),
      );

      expect(currentApp().client.users.info).toHaveBeenCalledTimes(1);
    });

    it('falls back to user ID when API fails', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.users.info.mockRejectedValueOnce(
        new Error('API error'),
      );

      const event = createMessageEvent({ user: 'U_UNKNOWN', text: 'Hi' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          sender_name: 'U_UNKNOWN',
        }),
      );
    });

    it('flattens threaded replies into channel messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        ts: '1704067201.000000',
        threadTs: '1704067200.000000', // parent message ts — this is a reply
        text: 'Thread reply',
      });
      await triggerMessageEvent(event);

      // Threaded replies are delivered as regular channel messages when the
      // thread JID is not registered
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Thread reply',
        }),
      );
    });

    it('routes thread replies using thread-encoded JID', async () => {
      const threadTs = '1704067200.000000';
      const threadJid = `slack:C0123456789:${threadTs}`;
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'slack:C0123456789': {
            name: 'Test Channel',
            folder: 'test-channel',
            trigger: '@Jonesy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
          [threadJid]: {
            name: 'Thread Group',
            folder: 'thread-group',
            trigger: '@Jonesy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        ts: '1704067201.000000',
        threadTs,
        text: 'Thread reply',
      });
      await triggerMessageEvent(event);

      // Should route to the thread-encoded JID
      expect(opts.onMessage).toHaveBeenCalledWith(
        threadJid,
        expect.objectContaining({
          chat_jid: threadJid,
          content: 'Thread reply',
        }),
      );
    });

    it('delivers thread parent messages normally', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        ts: '1704067200.000000',
        threadTs: '1704067200.000000', // same as ts — this IS the parent
        text: 'Thread parent',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Thread parent',
        }),
      );
    });

    it('delivers messages without thread_ts normally', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'Normal message' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalled();
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('prepends trigger when bot is @mentioned via Slack format', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect(); // sets botUserId to 'U_BOT_123'

      const event = createMessageEvent({
        text: 'Hey <@U_BOT_123> what do you think?',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: '@Jonesy Hey <@U_BOT_123> what do you think?',
        }),
      );
    });

    it('does not prepend trigger when trigger pattern already matches', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: '@Jonesy <@U_BOT_123> hello',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      // Content should be unchanged since it already matches TRIGGER_PATTERN
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: '@Jonesy <@U_BOT_123> hello',
        }),
      );
    });

    it('does not translate mentions in bot messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'Echo: <@U_BOT_123>',
        subtype: 'bot_message',
        botId: 'B_BOT_123',
      });
      await triggerMessageEvent(event);

      // Our own bot messages skip mention translation
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Echo: <@U_BOT_123>',
        }),
      );
    });

    it('does not translate mentions for other users', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'Hey <@U_OTHER_USER> look at this',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      // Mention is for a different user, not the bot
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Hey <@U_OTHER_USER> look at this',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via Slack client', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage('slack:C0123456789', 'Hello');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Hello',
      });
    });

    it('strips slack: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage('slack:D9876543210', 'DM message');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'D9876543210',
        text: 'DM message',
      });
    });

    it('queues message when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Don't connect — should queue
      await channel.sendMessage('slack:C0123456789', 'Queued message');

      expect(currentApp().client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('queues message on send failure', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.chat.postMessage.mockRejectedValueOnce(
        new Error('Network error'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('slack:C0123456789', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('splits long messages at 4000 character boundary', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // Create a message longer than 4000 chars
      const longText = 'A'.repeat(4500);
      await channel.sendMessage('slack:C0123456789', longText);

      // Should be split into 2 messages: 4000 + 500
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(2);
      expect(currentApp().client.chat.postMessage).toHaveBeenNthCalledWith(1, {
        channel: 'C0123456789',
        text: 'A'.repeat(4000),
      });
      expect(currentApp().client.chat.postMessage).toHaveBeenNthCalledWith(2, {
        channel: 'C0123456789',
        text: 'A'.repeat(500),
      });
    });

    it('sends to thread when JID contains thread_ts', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage('slack:C123:1234567890.123456', 'Hello');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123',
        text: 'Hello',
        thread_ts: '1234567890.123456',
      });
    });

    it('sends without thread_ts for regular JID', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage('slack:C123', 'Hello');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123',
        text: 'Hello',
      });
    });

    it('sends exactly-4000-char messages as a single message', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const text = 'B'.repeat(4000);
      await channel.sendMessage('slack:C0123456789', text);

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text,
      });
    });

    it('splits messages into 3 parts when over 8000 chars', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const longText = 'C'.repeat(8500);
      await channel.sendMessage('slack:C0123456789', longText);

      // 4000 + 4000 + 500 = 3 messages
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(3);
    });

    it('flushes queued messages on connect', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Queue messages while disconnected
      await channel.sendMessage('slack:C0123456789', 'First queued');
      await channel.sendMessage('slack:C0123456789', 'Second queued');

      expect(currentApp().client.chat.postMessage).not.toHaveBeenCalled();

      // Connect triggers flush
      await channel.connect();

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'First queued',
      });
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Second queued',
      });
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns slack: JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('slack:C0123456789')).toBe(true);
    });

    it('owns slack: DM JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('slack:D0123456789')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- syncChannelMetadata ---

  describe('syncChannelMetadata', () => {
    it('calls conversations.list and updates chat names', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      currentApp().client.conversations.list.mockResolvedValue({
        channels: [
          { id: 'C001', name: 'general', is_member: true },
          { id: 'C002', name: 'random', is_member: true },
          { id: 'C003', name: 'external', is_member: false },
        ],
        response_metadata: {},
      });

      await channel.connect();

      // connect() calls syncChannelMetadata internally
      expect(updateChatName).toHaveBeenCalledWith('slack:C001', 'general');
      expect(updateChatName).toHaveBeenCalledWith('slack:C002', 'random');
      // Non-member channels are skipped
      expect(updateChatName).not.toHaveBeenCalledWith('slack:C003', 'external');
    });

    it('handles API errors gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      currentApp().client.conversations.list.mockRejectedValue(
        new Error('API error'),
      );

      // Should not throw
      await expect(channel.connect()).resolves.toBeUndefined();
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('resolves without error (no-op)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Should not throw — Slack has no bot typing indicator API
      await expect(
        channel.setTyping('slack:C0123456789', true),
      ).resolves.toBeUndefined();
    });

    it('accepts false without error', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await expect(
        channel.setTyping('slack:C0123456789', false),
      ).resolves.toBeUndefined();
    });
  });

  // --- Constructor error handling ---

  describe('constructor', () => {
    it('throws when SLACK_BOT_TOKEN is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        SLACK_BOT_TOKEN: '',
        SLACK_APP_TOKEN: 'xapp-test-token',
      });

      expect(() => new SlackChannel(createTestOpts())).toThrow(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    });

    it('throws when SLACK_APP_TOKEN is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        SLACK_BOT_TOKEN: 'xoxb-test-token',
        SLACK_APP_TOKEN: '',
      });

      expect(() => new SlackChannel(createTestOpts())).toThrow(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    });
  });

  // --- syncChannelMetadata pagination ---

  describe('syncChannelMetadata pagination', () => {
    it('paginates through multiple pages of channels', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // First page returns a cursor; second page returns no cursor
      currentApp()
        .client.conversations.list.mockResolvedValueOnce({
          channels: [{ id: 'C001', name: 'general', is_member: true }],
          response_metadata: { next_cursor: 'cursor_page2' },
        })
        .mockResolvedValueOnce({
          channels: [{ id: 'C002', name: 'random', is_member: true }],
          response_metadata: {},
        });

      await channel.connect();

      // Should have called conversations.list twice (once per page)
      expect(currentApp().client.conversations.list).toHaveBeenCalledTimes(2);
      expect(currentApp().client.conversations.list).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ cursor: 'cursor_page2' }),
      );

      // Both channels from both pages stored
      expect(updateChatName).toHaveBeenCalledWith('slack:C001', 'general');
      expect(updateChatName).toHaveBeenCalledWith('slack:C002', 'random');
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "slack"', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.name).toBe('slack');
    });
  });

  // --- file_shared handling ---

  describe('file_shared handling', () => {
    it('registers file_shared event handler on construction', () => {
      new SlackChannel(createTestOpts());
      expect(currentApp().eventHandlers.has('file_shared')).toBe(true);
    });

    it('calls files.info with correct file_id', async () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      await triggerFileSharedEvent({ file_id: 'F_FILE_123', channel_id: 'C0123456789' });

      expect(currentApp().client.files.info).toHaveBeenCalledWith({ file: 'F_FILE_123' });
    });

    it('downloads file with correct Authorization header', async () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      await triggerFileSharedEvent({ file_id: 'F_FILE_123', channel_id: 'C0123456789' });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://files.slack.com/files-pri/T123/F123/report.pdf',
        { headers: { Authorization: 'Bearer xoxb-test-token' } },
      );
    });

    it('writes file to correct path using GROUPS_DIR and group folder', async () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      await triggerFileSharedEvent({ file_id: 'F_FILE_123', channel_id: 'C0123456789' });

      expect(fs.mkdir).toHaveBeenCalledWith('/test/groups/test-channel/files', { recursive: true });
      expect(fs.writeFile).toHaveBeenCalledWith(
        '/test/groups/test-channel/files/report.pdf',
        expect.any(Buffer),
      );
    });

    it('calls onMessage with prompt containing container path and mimetype (no token)', async () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      await triggerFileSharedEvent({ file_id: 'F_FILE_123', channel_id: 'C0123456789' });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          chat_jid: 'slack:C0123456789',
          sender_name: 'slack-file-upload',
          is_from_me: false,
          is_bot_message: false,
        }),
      );

      const call = vi.mocked(opts.onMessage).mock.calls[0];
      const content = call[1].content;
      expect(content).toContain('/workspace/group/files/report.pdf');
      expect(content).toContain('application/pdf');
      expect(content).toContain('200.0 KB');
      expect(content).not.toContain('xoxb-test-token');
    });

    it('includes summary instruction for readable mimetypes', async () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      // Default mock returns application/pdf which is readable
      await triggerFileSharedEvent({ file_id: 'F_FILE_123', channel_id: 'C0123456789' });

      const call = vi.mocked(opts.onMessage).mock.calls[0];
      const content = call[1].content;
      expect(content).toContain('readable format');
      expect(content).toContain('summary');
    });

    it('omits summary instruction for binary mimetypes', async () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      currentApp().client.files.info.mockResolvedValueOnce({
        file: {
          id: 'F_FILE_456',
          name: 'photo.png',
          url_private_download: 'https://files.slack.com/files-pri/T123/F456/photo.png',
          mimetype: 'image/png',
          size: 102400,
          user: 'U_USER_456',
        },
      });

      await triggerFileSharedEvent({ file_id: 'F_FILE_456', channel_id: 'C0123456789' });

      const call = vi.mocked(opts.onMessage).mock.calls[0];
      const content = call[1].content;
      expect(content).toContain('binary file');
      expect(content).not.toContain('readable format');
    });

    it('DMs the uploader when channel is unregistered', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})), // no registered groups
      });
      new SlackChannel(opts);

      await triggerFileSharedEvent({ file_id: 'F_FILE_123', channel_id: 'C9999999999' });

      // Should NOT call onMessage or fetch
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();

      // Should DM the uploader
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'U_USER_456',
        text: expect.stringContaining('<#C9999999999>'),
      });
    });

    it('DM message includes channel reference', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})),
      });
      new SlackChannel(opts);

      await triggerFileSharedEvent({ file_id: 'F_FILE_123', channel_id: 'C9999999999' });

      const call = currentApp().client.chat.postMessage.mock.calls[0][0];
      expect(call.text).toContain('<#C9999999999>');
      expect(call.text).toContain('registered');
    });

    it('skips DM to uploader if file.user is missing', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})),
      });
      new SlackChannel(opts);

      currentApp().client.files.info.mockResolvedValueOnce({
        file: {
          id: 'F_FILE_789',
          name: 'mystery.pdf',
          url_private_download: 'https://files.slack.com/files-pri/T123/F789/mystery.pdf',
          mimetype: 'application/pdf',
          size: 1024,
          // no user field
        },
      });

      await triggerFileSharedEvent({ file_id: 'F_FILE_789', channel_id: 'C9999999999' });

      expect(currentApp().client.chat.postMessage).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips files with no url_private_download', async () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      currentApp().client.files.info.mockResolvedValueOnce({
        file: {
          id: 'F_FILE_NO_URL',
          name: 'no-download.pdf',
          // no url_private_download
          mimetype: 'application/pdf',
          size: 1024,
          user: 'U_USER_456',
        },
      });

      await triggerFileSharedEvent({ file_id: 'F_FILE_NO_URL', channel_id: 'C0123456789' });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('sanitizes dangerous filenames', async () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      currentApp().client.files.info.mockResolvedValueOnce({
        file: {
          id: 'F_FILE_DANGER',
          name: '../../../etc/passwd',
          url_private_download: 'https://files.slack.com/files-pri/T123/F_DANGER/passwd',
          mimetype: 'text/plain',
          size: 1024,
          user: 'U_USER_456',
        },
      });

      await triggerFileSharedEvent({ file_id: 'F_FILE_DANGER', channel_id: 'C0123456789' });

      // path.basename strips directory traversal, then regex strips remaining unsafe chars
      expect(fs.writeFile).toHaveBeenCalledWith(
        '/test/groups/test-channel/files/passwd',
        expect.any(Buffer),
      );
    });

    it('rejects empty post-sanitization filenames', async () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      currentApp().client.files.info.mockResolvedValueOnce({
        file: {
          id: 'F_FILE_EMPTY',
          name: '////',
          url_private_download: 'https://files.slack.com/files-pri/T123/F_EMPTY/file',
          mimetype: 'application/octet-stream',
          size: 1024,
          user: 'U_USER_456',
        },
      });

      await triggerFileSharedEvent({ file_id: 'F_FILE_EMPTY', channel_id: 'C0123456789' });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('rejects files over 50MB with notification', async () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      currentApp().client.files.info.mockResolvedValueOnce({
        file: {
          id: 'F_FILE_BIG',
          name: 'huge-video.mp4',
          url_private_download: 'https://files.slack.com/files-pri/T123/F_BIG/huge-video.mp4',
          mimetype: 'video/mp4',
          size: 60 * 1024 * 1024, // 60 MB
          user: 'U_USER_456',
        },
      });

      await triggerFileSharedEvent({ file_id: 'F_FILE_BIG', channel_id: 'C0123456789' });

      // Should NOT download
      expect(mockFetch).not.toHaveBeenCalled();

      // Should notify via onMessage about the limit
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: expect.stringContaining('exceeds the 50 MB limit'),
        }),
      );
    });

    it('handles files.info errors gracefully', async () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      currentApp().client.files.info.mockRejectedValueOnce(new Error('API error'));

      // Should not throw
      await expect(
        triggerFileSharedEvent({ file_id: 'F_FILE_ERR', channel_id: 'C0123456789' }),
      ).resolves.toBeUndefined();

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('handles fetch download errors gracefully', async () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      });

      // Should not throw
      await expect(
        triggerFileSharedEvent({ file_id: 'F_FILE_123', channel_id: 'C0123456789' }),
      ).resolves.toBeUndefined();

      expect(fs.writeFile).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('handles fs.writeFile errors gracefully', async () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error('ENOSPC'));

      // Should not throw
      await expect(
        triggerFileSharedEvent({ file_id: 'F_FILE_123', channel_id: 'C0123456789' }),
      ).resolves.toBeUndefined();

      // onMessage should NOT have been called since the write failed before we got there
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });
});
