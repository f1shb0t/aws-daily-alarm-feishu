# AWS Daily Alarm → Feishu

> 每日汇总 AWS 账号下的 **CloudWatch Alarms** + **AWS Health Events**，通过飞书自定义机器人推送到群/私聊。

![arch](https://img.shields.io/badge/AWS-CDK%20v2-orange) ![lang](https://img.shields.io/badge/Lambda-Python%203.12-blue) ![lang](https://img.shields.io/badge/CDK-TypeScript-3178C6)

---

## ✨ Features

- ✅ 多 Region 遍历（CloudWatch Alarms）
- ✅ AWS Health 事件聚合（需 Business/Enterprise Support，否则静默跳过）
- ✅ 飞书交互式卡片（按告警数量变色：🟢🟡🔴）
- ✅ 按 Region 分组展示，附 CloudWatch Console 直达链接
- ✅ 飞书签名校验支持（可选）
- ✅ 失败自动重试（指数退避）
- ✅ EventBridge cron 调度，默认每天北京时间 09:00

---

## 🏗️ 架构

```
 EventBridge Scheduler (cron, 原生时区)
          ↓
  Lambda (Python 3.12)
          ├─ boto3.cloudwatch.describe_alarms  × N regions
          ├─ boto3.health.describe_events      (global, us-east-1)
          └─ POST → 飞书 Webhook (interactive card)
```

成本极低：每天触发一次，Lambda 执行 <10 秒，**月成本 <$0.10**。

---

## 🚀 快速开始

### 前置条件

1. **飞书机器人 Webhook**
   - 群聊 → 设置 → 群机器人 → 添加机器人 → 自定义机器人
   - 复制 Webhook URL（形如 `https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxx`）
   - （可选）开启 **签名校验**，保存 secret

2. **本地工具**
   ```bash
   node --version   # ≥ 20
   npm --version
   aws --version    # AWS CLI v2
   aws configure    # 或 aws sso login
   ```

3. **首次部署 CDK 需要 bootstrap**
   ```bash
   npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
   ```

---

### 部署

```bash
# 1. 克隆 & 安装
git clone git@github.com:f1shb0t/aws-daily-alarm-feishu.git
cd aws-daily-alarm-feishu
npm install

# 2. 配置（三选一，可混用）

## 方式 A：.env 文件（推荐，最省事）
cp .env.example .env
# 编辑 .env 填入真实值，cdk deploy 启动时会自动加载。
# 注意：shell 中已存在的环境变量优先级高于 .env（不会被覆盖）

## 方式 B：shell 环境变量
export FEISHU_WEBHOOK_URL="https://open.feishu.cn/open-apis/bot/v2/hook/xxx"
export FEISHU_WEBHOOK_SECRET=""   # 可选，未开启签名留空
export TARGET_REGIONS="us-east-1,us-west-2,ap-northeast-1"
export SCHEDULE_EXPRESSION="cron(0 9 * * ? *)"   # 每天 09:00（按下面的时区）
export SCHEDULE_TIMEZONE="Asia/Shanghai"         # IANA 时区，Scheduler 原生支持
export CDK_DEFAULT_REGION="us-east-1"            # Stack 部署到哪个 Region

## 方式 C：CDK context (-c 参数)
# 注意：CDK_DEFAULT_REGION 没有 -c 等价形式，只能用环境变量 / .env
npx cdk deploy \
  -c feishuWebhookUrl="https://open.feishu.cn/open-apis/bot/v2/hook/xxx" \
  -c regions="us-east-1,ap-northeast-1"

# 3. 部署
npm run build
npx cdk deploy
```

部署完成会输出：
```
DailyAlarmFeishuStack.LambdaFunctionName = DailyAlarmFeishuStack-DailyAlarmLambdaXXX
DailyAlarmFeishuStack.InvokeCommand = aws lambda invoke ... /tmp/out.json && cat /tmp/out.json
```

---

### 手动触发测试

```bash
aws lambda invoke \
  --function-name <上面输出的 LambdaFunctionName> \
  --payload '{}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/out.json && cat /tmp/out.json
```

正常会在飞书收到类似这样的卡片：

```
🔴 AWS 每日巡检 - 发现告警 (3 alarms)

账号: 123456789012  |  时间: 2026-04-23 01:00 UTC
Regions: us-east-1, ap-northeast-1

⚠️ CloudWatch Alarms：共 3 个处于 ALARM 状态

📍 us-east-1 (2)
- [HighCPU-prod-api]  (点击跳转 Console)
  Threshold Crossed: 1 datapoint [85.3] was greater than...
- [DDB-Throttles-archives] 
  ...

🏥 AWS Health Events: 0 个 open/upcoming

[打开 CloudWatch 控制台] [打开 Health Dashboard]
```

---

## ⚙️ 配置项

所有参数都可通过 **`.env` 文件** / **环境变量** / **CDK context**（`-c key=value`）传入。优先级：

```
shell 环境变量  >  .env 文件  >  CDK context  >  代码默认值
```

（`.env` 的加载由 `bin/app.ts` 中的 `dotenv` 完成，不会覆盖已存在的 shell 变量）

| 参数 | 环境变量 / .env key | CDK context | 默认值 | 说明 |
|---|---|---|---|---|
| 飞书 Webhook URL | `FEISHU_WEBHOOK_URL` | `feishuWebhookUrl` | **必填** | 自定义机器人 URL |
| 飞书签名 secret | `FEISHU_WEBHOOK_SECRET` | `feishuWebhookSecret` | 空 | 若开启签名校验则填写 |
| 监控 Region 列表 | `TARGET_REGIONS` | `regions` | `us-east-1,us-west-2,ap-northeast-1,ap-southeast-1` | 逗号分隔，Lambda 要遍历的 Region |
| cron 表达式 | `SCHEDULE_EXPRESSION` | `scheduleExpression` | `cron(0 9 * * ? *)` | EventBridge Scheduler 格式，按下一行的时区解释 |
| 调度时区 | `SCHEDULE_TIMEZONE` | `scheduleTimezone` | `Asia/Shanghai` | IANA 时区名（`UTC` / `America/Los_Angeles` / `Europe/Berlin` 等） |
| **Stack 部署 Region** | `CDK_DEFAULT_REGION` | —（无 `-c` 形式） | `us-east-1` | CDK 原生变量，决定 Stack 本身部署到哪个 Region；**只能通过环境变量或 .env 指定** |

> ⚠️ **`CDK_DEFAULT_REGION` 和 `TARGET_REGIONS` 的区别**
> - `CDK_DEFAULT_REGION`：Stack（Lambda 本体 + Scheduler）部署到哪个 Region
> - `TARGET_REGIONS`：Lambda 运行时要遍历检查 CloudWatch Alarm 的 Region 列表
>
> 两者互相独立。例如可以把 Stack 部署在 `us-east-1`，然后让它监控 `ap-northeast-1 + ap-southeast-1`。

**常用 cron 示例**（按 `SCHEDULE_TIMEZONE` 指定的时区解释）：

| 触发时间 | cron 表达式 | 时区 |
|---|---|---|
| 每天 09:00（北京） | `cron(0 9 * * ? *)` | `Asia/Shanghai` |
| 每天 18:00（北京） | `cron(0 18 * * ? *)` | `Asia/Shanghai` |
| 工作日 09:00（北京） | `cron(0 9 ? * MON-FRI *)` | `Asia/Shanghai` |
| 每 2 小时 | `cron(0 */2 * * ? *)` | 任意 |
| 每天 09:00（美西） | `cron(0 9 * * ? *)` | `America/Los_Angeles` |

---

## 🔐 IAM 权限

Lambda 执行角色被授予以下只读权限：

```
cloudwatch:DescribeAlarms
cloudwatch:DescribeAlarmHistory
health:DescribeEvents
health:DescribeEventDetails
health:DescribeAffectedEntities
ec2:DescribeRegions
```

全部为只读，不可修改任何资源。

---

## 🛠️ 二次开发

### 增加告警源（GuardDuty / Security Hub / Cost Anomaly）

编辑 `lambda/handler.py`，参考 `collect_cloudwatch_alarms` 再加一个 `collect_xxx` 函数，然后在 `lambda_handler` 里调用并合并到卡片。

IAM 权限记得同步在 `lib/daily-alarm-feishu-stack.ts` 里加。

### 多账号聚合

推荐做法：
1. 在 **Management Account** 部署本 Stack
2. 各 Member Account 建立跨账号 role（信任 Management Account）
3. Lambda 改为遍历账号 → AssumeRole → 拉告警

需要改造的文件：`lambda/handler.py` 的 `collect_cloudwatch_alarms`（传入 client credentials）。

### 告警降噪

在 `handler.py` 的 `collect_cloudwatch_alarms` 里加过滤：

```python
# 忽略 30 天都在 ALARM 的（可能是误配置的长期告警）
if (datetime.now(timezone.utc) - a["StateUpdatedTimestamp"]).days > 30:
    continue

# 忽略特定标签
tags = cw.list_tags_for_resource(ResourceARN=a["AlarmArn"])
if any(t["Key"] == "suppress-daily-digest" for t in tags.get("Tags", [])):
    continue
```

---

## 🗑️ 卸载

```bash
npx cdk destroy
```

会删除 Lambda、IAM role、EventBridge rule。CloudWatch Logs 保留 1 个月后自动过期。

---

## 📁 项目结构

```
aws-daily-alarm-feishu/
├── bin/
│   └── app.ts                      # CDK 入口
├── lib/
│   └── daily-alarm-feishu-stack.ts # Stack 定义
├── lambda/
│   └── handler.py                  # Lambda 业务逻辑
├── cdk.json
├── tsconfig.json
├── package.json
└── README.md
```

---

## 🤝 License

MIT

---

## 🐛 Troubleshooting

**Q: Lambda 报 `AccessDeniedException: health:DescribeEvents`**
A: AWS Health API 需要 **Business / Enterprise / On-Ramp Support Plan**。普通 Developer / Basic 不支持。代码已做静默处理（跳过 Health，不影响 CloudWatch 部分）。

**Q: 飞书返回 `sign match fail` / `invalid sign`**
A: 说明机器人开了签名校验但没传 secret，或 secret 错误。检查 `FEISHU_WEBHOOK_SECRET` 环境变量。

**Q: cron 触发了但没收到消息**
A:
1. 查 CloudWatch Logs：`/aws/lambda/<function-name>`
2. 手动触发 `aws lambda invoke` 看错误
3. 检查 Webhook URL 是否有 IP 白名单（飞书机器人默认无限制，但企业定制版可能有）

**Q: 告警太多把消息刷爆**
A: 改 `handler.py` 里的 `MAX_ALARMS_PER_CARD`（默认 20），或参考"告警降噪"章节加过滤。
