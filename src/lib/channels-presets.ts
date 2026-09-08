// 社交通讯渠道静态预设（无服务端依赖，客户端可直接 import）
// 平台清单与凭据字段对齐 RoveAgent Core gateway/platforms 与配置环境变量。

export type ChannelKey =
  | 'telegram'
  | 'whatsapp'
  | 'slack'
  | 'discord'
  | 'mattermost'
  | 'matrix'
  | 'feishu'
  | 'wecom'
  | 'dingtalk'
  | 'signal'
  | 'bluebubbles'
  | 'weixin'
  | 'qqbot';

export interface ChannelField {
  key: string;
  secret?: boolean;
  placeholder?: string;
}

export interface ChannelPreset {
  key: ChannelKey;
  /** chat = 机器人/桥接直达；webhook = 群机器人 webhook 推送 */
  category: 'chat' | 'webhook';
  /** ready = 当前版本可连接发送；false = 需自建桥接服务，即将支持 */
  ready: boolean;
  /** 提示：ready=false 的渠道依赖自建服务，供 UI 展示说明 */
  noteHint?: 'bridge' | 'selfhost';
  fields: ChannelField[];
}

export const CHANNEL_PRESETS: ChannelPreset[] = [
  {
    key: 'telegram',
    category: 'chat',
    ready: true,
    fields: [
      { key: 'botToken', secret: true, placeholder: '123456:ABC-DEF...' },
      { key: 'chatId', placeholder: 'chat_id or @channel' },
    ],
  },
  {
    key: 'whatsapp',
    category: 'chat',
    ready: true,
    fields: [
      { key: 'accessToken', secret: true, placeholder: 'EAA...' },
      { key: 'phoneNumberId', placeholder: '107...' },
      { key: 'to', placeholder: '+15551234567' },
    ],
  },
  {
    key: 'slack',
    category: 'webhook',
    ready: true,
    fields: [{ key: 'webhookUrl', secret: true, placeholder: 'https://hooks.slack.com/services/...' }],
  },
  {
    key: 'discord',
    category: 'webhook',
    ready: true,
    fields: [{ key: 'webhookUrl', secret: true, placeholder: 'https://discord.com/api/webhooks/...' }],
  },
  {
    key: 'mattermost',
    category: 'webhook',
    ready: true,
    fields: [{ key: 'webhookUrl', secret: true, placeholder: 'https://your-mattermost.com/hooks/...' }],
  },
  {
    key: 'matrix',
    category: 'chat',
    ready: true,
    fields: [
      { key: 'homeserver', placeholder: 'https://matrix.org' },
      { key: 'accessToken', secret: true, placeholder: 'syt_...' },
      { key: 'roomId', placeholder: '!roomId:matrix.org' },
    ],
  },
  {
    key: 'feishu',
    category: 'webhook',
    ready: true,
    fields: [{ key: 'webhookUrl', secret: true, placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...' }],
  },
  {
    key: 'wecom',
    category: 'webhook',
    ready: true,
    fields: [{ key: 'webhookUrl', secret: true, placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...' }],
  },
  {
    key: 'dingtalk',
    category: 'webhook',
    ready: true,
    fields: [{ key: 'webhookUrl', secret: true, placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...' }],
  },
  {
    key: 'signal',
    category: 'chat',
    ready: false,
    noteHint: 'selfhost',
    fields: [
      { key: 'httpUrl', placeholder: 'http://host:8080' },
      { key: 'account', placeholder: '+15551234567' },
      { key: 'recipient', placeholder: '+15551234567' },
    ],
  },
  {
    key: 'bluebubbles',
    category: 'chat',
    ready: false,
    noteHint: 'selfhost',
    fields: [
      { key: 'serverUrl', placeholder: 'http://mac.local:1234' },
      { key: 'password', secret: true, placeholder: '...' },
      { key: 'chatGuid', placeholder: 'iMessage;...' },
    ],
  },
  {
    key: 'weixin',
    category: 'chat',
    ready: false,
    noteHint: 'bridge',
    fields: [
      { key: 'baseUrl', placeholder: 'http://bridge:8080' },
      { key: 'accountId', placeholder: '...' },
      { key: 'token', secret: true, placeholder: '...' },
    ],
  },
  {
    key: 'qqbot',
    category: 'chat',
    ready: false,
    noteHint: 'bridge',
    fields: [
      { key: 'appId', placeholder: '102...' },
      { key: 'clientSecret', secret: true, placeholder: '...' },
      { key: 'channelId', placeholder: '...' },
    ],
  },
];

export const CHANNEL_KEYS: ChannelKey[] = CHANNEL_PRESETS.map((c) => c.key);

export function presetOf(key: string): ChannelPreset | undefined {
  return CHANNEL_PRESETS.find((c) => c.key === key);
}
