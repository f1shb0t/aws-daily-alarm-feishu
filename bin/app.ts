#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DailyAlarmFeishuStack } from '../lib/daily-alarm-feishu-stack';

const app = new cdk.App();

// 通过 context 或环境变量传参，默认值兜底
const feishuWebhookUrl =
  app.node.tryGetContext('feishuWebhookUrl') ||
  process.env.FEISHU_WEBHOOK_URL ||
  '';

const feishuWebhookSecret =
  app.node.tryGetContext('feishuWebhookSecret') ||
  process.env.FEISHU_WEBHOOK_SECRET ||
  '';

const regionsCtx =
  app.node.tryGetContext('regions') || process.env.TARGET_REGIONS || '';
const targetRegions: string[] = regionsCtx
  ? regionsCtx.split(',').map((r: string) => r.trim()).filter(Boolean)
  : ['us-east-1', 'us-west-2', 'ap-northeast-1', 'ap-southeast-1'];

// cron 表达式（EventBridge Scheduler 使用 UTC）
// 默认每天 UTC 01:00 = 北京 09:00
const scheduleExpression =
  app.node.tryGetContext('scheduleExpression') ||
  process.env.SCHEDULE_EXPRESSION ||
  'cron(0 1 * * ? *)';

new DailyAlarmFeishuStack(app, 'DailyAlarmFeishuStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  feishuWebhookUrl,
  feishuWebhookSecret,
  targetRegions,
  scheduleExpression,
  description: 'Daily AWS alarm digest pushed to Feishu (Lark)',
});
