import { App, SocketModeReceiver } from '@slack/bolt';
import { config } from '../config';

export function createSlackApp(): App {
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
  });

  // デフォルトの clientPingTimeout (5000ms) だとネットワーク遅延で
  // pong 未受信 WARN が頻発するため 10 秒に引き上げる
  ((app as any).receiver as SocketModeReceiver).client['clientPingTimeoutMS'] = 10_000;

  return app;
}
