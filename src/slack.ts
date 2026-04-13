import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { ASSISTANT_NAME, TRIGGER_PATTERN, GROUPS_DIR } from '../../../dist/orchestrator/config.js';
import { updateChatName } from '../../../dist/orchestrator/db.js';
import { readEnvFile } from '../../../dist/orchestrator/env.js';
import { logger } from '../../../dist/orchestrator/logger.js';
import type { ChannelOpts } from '../../../dist/orchestrator/channel-registry.js';
import type {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../../../dist/orchestrator/types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// Maximum file size we'll download (50 MB)
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botToken: string;
  private botUserId: string | undefined;
  private botId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  // Track the last inbound message ts per JID for reaction-based typing indicator
  private lastMessageTs = new Map<string, string>();
  // Track where the typing reaction was actually placed, so removal targets the
  // correct message even if lastMessageTs was overwritten by a subsequent message.
  private typingReactionTs = new Map<string, string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching ClaudeClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.botToken = botToken;

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.app.event('message', async ({ event }) => {
      const subtype = (event as { subtype?: string }).subtype;
      // Skip list_record_comment — list items are status display only
      if (subtype === 'list_record_comment') return;

      // file_share messages accompany file uploads — capture the ts so the
      // typing-indicator reaction can attach to the upload message, then bail.
      // The actual file processing happens in the file_shared event handler.
      if (subtype === 'file_share') {
        const msg = event as GenericMessageEvent;
        if (msg.channel && msg.ts) {
          const jid = `slack:${msg.channel}`;
          this.lastMessageTs.set(jid, msg.ts);
        }
        return;
      }

      if (subtype && subtype !== 'bot_message') return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      if (!msg.text) return;

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery (using base channel JID)
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Check for thread_ts to build a thread-encoded JID.
      // If that thread JID is registered as a group, route there instead.
      const threadTs = (msg as any).thread_ts as string | undefined;
      const threadJid = threadTs ? `slack:${msg.channel}:${threadTs}` : null;

      const groups = this.opts.registeredGroups();
      const effectiveJid = threadJid && groups[threadJid] ? threadJid : jid;

      // DMs are auto-accepted and auto-registered.
      // Channel messages require prior registration.
      const isDM = msg.channel_type === 'im';
      if (!isDM && !groups[effectiveJid]) return;

      // Auto-register DMs on first contact so the orchestrator can process them
      if (isDM && !groups[effectiveJid] && this.opts.registerGroup) {
        const userName = msg.user
          ? await this.resolveUserName(msg.user)
          : undefined;
        const folderName = `slack_dm_${msg.user || msg.channel}`;
        this.opts.registerGroup(effectiveJid, {
          name: userName ? `DM: ${userName}` : `DM: ${msg.channel}`,
          folder: folderName,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        });
        logger.info(
          { jid: effectiveJid, folder: folderName },
          'Auto-registered Slack DM',
        );
      }

      // Only treat messages from OUR bot as "from me". Other bots (Workflow
      // Builder, integrations) should be processed as regular inbound messages.
      const isBotMessage =
        msg.user === this.botUserId ||
        (!!msg.bot_id && msg.bot_id === this.botId);

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text;
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Track last inbound message for reaction-based typing indicator
      if (!isBotMessage) {
        this.lastMessageTs.set(effectiveJid, msg.ts);
      }

      this.opts.onMessage(effectiveJid, {
        id: msg.ts,
        chat_jid: effectiveJid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
      });
    });

    this.app.event('file_shared', async ({ event }) => {
      const ev = event as { file_id: string; channel_id: string };
      const jid = `slack:${ev.channel_id}`;

      try {
        // Always call files.info first — we need file.user for the DM fallback
        const fileInfo = await this.app.client.files.info({ file: ev.file_id });
        const file = fileInfo.file as any;

        if (!file?.url_private_download) {
          logger.warn({ fileId: ev.file_id }, 'file_shared: no download URL, skipping');
          return;
        }

        // Check registration — if not registered, DM the uploader and bail
        const groups = this.opts.registeredGroups();
        const group = groups[jid];
        if (!group) {
          logger.warn({ jid, fileId: ev.file_id, user: file.user }, 'file_shared: unregistered channel, skipping');
          if (file.user) {
            await this.app.client.chat.postMessage({
              channel: file.user,
              text: `I received a file in <#${ev.channel_id}> but that channel isn't registered with me yet. Ask an admin to register it if you'd like me to handle file uploads there.`,
            });
          }
          return;
        }

        // Sanitize filename — strip path traversal and non-safe characters
        const rawName = file.name ?? `slack-file-${ev.file_id}`;
        const sanitized = path.basename(rawName).replace(/[^\w.\-]/g, '_');
        if (!sanitized) {
          logger.warn({ rawName }, 'file_shared: filename sanitized to empty, skipping');
          return;
        }

        const mimeType = file.mimetype ?? 'application/octet-stream';
        const sizeBytes = file.size ?? 0;
        const sizeKb = (sizeBytes / 1024).toFixed(1);

        // Reject files over 50MB
        if (sizeBytes > MAX_FILE_SIZE) {
          logger.warn({ jid, sanitized, sizeBytes }, 'file_shared: file too large, skipping');
          this.opts.onMessage(jid, {
            id: ev.file_id,
            chat_jid: jid,
            sender: '',
            sender_name: 'slack-file-upload',
            content: `A file was shared (${sanitized}, ${sizeKb} KB) but it exceeds the 50 MB limit and was not saved.`,
            timestamp: new Date().toISOString(),
            is_from_me: false,
            is_bot_message: false,
          });
          return;
        }

        // Download on the host side — token never leaves this process
        const res = await fetch(file.url_private_download, {
          headers: { Authorization: `Bearer ${this.botToken}` },
        });
        if (!res.ok) {
          throw new Error(`Download failed: ${res.status} ${res.statusText}`);
        }
        const buffer = Buffer.from(await res.arrayBuffer());

        // Write to group's files directory
        const filesDir = path.join(GROUPS_DIR, group.folder, 'files');
        await fs.mkdir(filesDir, { recursive: true });
        const destPath = path.join(filesDir, sanitized);
        await fs.writeFile(destPath, buffer);

        logger.info({ jid, sanitized, sizeKb }, 'file_shared: file saved');

        // Determine if mimetype is text-ish (Claude can summarize)
        const isReadable =
          mimeType.startsWith('text/') ||
          ['application/json', 'application/pdf', 'application/csv'].includes(mimeType) ||
          /\/(javascript|typescript|xml|yaml|toml|markdown)/.test(mimeType);

        const containerPath = `/workspace/group/files/${sanitized}`;
        const summaryInstruction = isReadable
          ? `Since this is a readable format, read the file at ${containerPath} and include a 2\u20133 sentence summary of the contents in your reply.`
          : `This is a binary file \u2014 just confirm receipt, no summary needed.`;

        const content =
          `File saved at ${containerPath} (${mimeType}, ${sizeKb} KB).\n\n` +
          `Please:\n` +
          `1. Record in memory (topic: "uploaded-files"): filename, type, size, today's date.\n` +
          `2. Reply to the user confirming the file was saved. ${summaryInstruction}`;

        this.opts.onMessage(jid, {
          id: ev.file_id,
          chat_jid: jid,
          sender: '',
          sender_name: 'slack-file-upload',
          content,
          timestamp: new Date().toISOString(),
          is_from_me: false,
          is_bot_message: false,
        });
      } catch (err) {
        logger.error({ err, fileId: ev.file_id }, 'file_shared: error handling event');
      }
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      this.botId = auth.bot_id as string | undefined;
      logger.info(
        { botUserId: this.botUserId, botId: this.botId },
        'Connected to Slack',
      );
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Parse thread-encoded JID: slack:<channel> or slack:<channel>:<thread_ts>
    const stripped = jid.replace(/^slack:/, '');
    const colonIdx = stripped.indexOf(':');
    const channelId = colonIdx === -1 ? stripped : stripped.slice(0, colonIdx);
    const threadTs = colonIdx === -1 ? undefined : stripped.slice(colonIdx + 1);

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
            ...(threadTs ? { thread_ts: threadTs } : {}),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  // Use emoji reactions as a typing indicator since Slack has no typing API for bots.
  // Adds eyes to the last user message when working, removes it when done.
  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // Parse channel from JID (needed for both add and remove)
    const stripped = jid.replace(/^slack:/, '');
    const colonIdx = stripped.indexOf(':');
    const channelId = colonIdx === -1 ? stripped : stripped.slice(0, colonIdx);

    if (!isTyping) {
      // For removal, use the ts where we actually placed the reaction,
      // NOT lastMessageTs which may have been overwritten by subsequent messages.
      const reactionTs = this.typingReactionTs.get(jid);
      if (!reactionTs) {
        logger.debug({ jid }, 'setTyping(false): no active typing reaction to remove');
        return;
      }
      this.typingReactionTs.delete(jid);
      try {
        await this.app.client.reactions.remove({
          channel: channelId,
          timestamp: reactionTs,
          name: 'eyes',
        });
      } catch (err) {
        logger.warn(
          { err, jid, channelId, reactionTs },
          'Failed to remove typing reaction',
        );
      }
      return;
    }

    // For adding, look up the latest message ts
    let messageTs = this.lastMessageTs.get(jid);

    // Fallback: if jid is a thread JID (slack:C...:ts), try the base channel JID.
    // The ts is stored under the base JID at message arrival time, before the
    // orchestrator creates the thread JID in processGroupMessages.
    if (!messageTs) {
      if (colonIdx !== -1) {
        const baseJid = `slack:${stripped.slice(0, colonIdx)}`;
        messageTs = this.lastMessageTs.get(baseJid);
      }
    }

    if (!messageTs) {
      logger.debug(
        { jid, trackedJids: [...this.lastMessageTs.keys()] },
        'setTyping(true): no message ts tracked',
      );
      return;
    }

    try {
      await this.app.client.reactions.add({
        channel: channelId,
        timestamp: messageTs,
        name: 'eyes',
      });
      // Record where we placed the reaction so removal targets the right message
      this.typingReactionTs.set(jid, messageTs);
    } catch (err) {
      logger.warn(
        { err, jid, channelId, messageTs },
        'Failed to add typing reaction',
      );
    }
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Parse thread-encoded JID: slack:<channel> or slack:<channel>:<thread_ts>
        const stripped = item.jid.replace(/^slack:/, '');
        const colonIdx = stripped.indexOf(':');
        const channelId =
          colonIdx === -1 ? stripped : stripped.slice(0, colonIdx);
        const threadTs =
          colonIdx === -1 ? undefined : stripped.slice(colonIdx + 1);
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}
