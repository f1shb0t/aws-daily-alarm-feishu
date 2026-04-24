#!/usr/bin/env node
import 'source-map-support/register';
import * as path from 'path';
import * as dotenv from 'dotenv';

// 加载 .env（如果存在）—— 必须在读取 process.env 之前
// 优先级：shell 环境变量 > .env 文件（dotenv 默认不覆盖已存在的 env）
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

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

// cron 表达式
// EventBridge Scheduler 支持 cron / rate / at 三种表达式
// 默认每天 09:00（按 SCHEDULE_TIMEZONE 指定的时区，默认 Asia/Shanghai）
const scheduleExpression =
  app.node.tryGetContext('scheduleExpression') ||
  process.env.SCHEDULE_EXPRESSION ||
  'cron(0 9 * * ? *)';

// 调度时区（IANA 格式）—— Scheduler 原生支持，不用再手动把北京时间换算成 UTC
const scheduleTimezone =
  app.node.tryGetContext('scheduleTimezone') ||
  process.env.SCHEDULE_TIMEZONE ||
  'Asia/Shanghai';

new DailyAlarmFeishuStack(app, 'DailyAlarmFeishuStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  feishuWebhookUrl,
  feishuWebhookSecret,
  targetRegions,
  scheduleExpression,
  scheduleTimezone,
  description: 'Daily AWS alarm digest pushed to Feishu (Lark)',
});
