import { App } from '@slack/bolt';
import { config } from '../config';

export function createSlackApp(): App {
  return new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
  });
}
