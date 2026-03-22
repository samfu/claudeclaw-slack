import { registerChannel } from '../../../dist/orchestrator/channel-registry.js';
import { readEnvFile } from '../../../dist/orchestrator/env.js';
import { logger } from '../../../dist/orchestrator/logger.js';
import { SlackChannel } from './slack.js';
import type { ChannelOpts } from '../../../dist/orchestrator/channel-registry.js';

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
