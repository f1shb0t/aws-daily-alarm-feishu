"""
AWS Daily Alarm → Feishu
========================
每日聚合 CloudWatch Alarms + AWS Health Events，推送到飞书自定义机器人。

支持：
- 多 Region 遍历（TARGET_REGIONS，逗号分隔）
- 飞书签名校验（可选，FEISHU_WEBHOOK_SECRET）
- 自动分批发送（单卡片元素过多时拆分）
- 失败重试 & 错误上报
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

import boto3
from botocore.exceptions import ClientError

# ------------------------------------------------------------
# 配置
# ------------------------------------------------------------
FEISHU_WEBHOOK_URL = os.environ["FEISHU_WEBHOOK_URL"]
FEISHU_WEBHOOK_SECRET = os.environ.get("FEISHU_WEBHOOK_SECRET", "")
TARGET_REGIONS = [
    r.strip()
    for r in os.environ.get("TARGET_REGIONS", "us-east-1").split(",")
    if r.strip()
]

MAX_ALARMS_PER_CARD = 20   # 单卡片最多展示条数
MAX_HEALTH_PER_CARD = 10
REQUEST_TIMEOUT = 10

logger = logging.getLogger()
logger.setLevel(logging.INFO)


# ------------------------------------------------------------
# 数据采集
# ------------------------------------------------------------
def collect_cloudwatch_alarms(region: str) -> List[Dict[str, Any]]:
    """拉取指定 Region 当前处于 ALARM 状态的告警。"""
    alarms: List[Dict[str, Any]] = []
    try:
        cw = boto3.client("cloudwatch", region_name=region)
        paginator = cw.get_paginator("describe_alarms")
        for page in paginator.paginate(StateValue="ALARM"):
            for a in page.get("MetricAlarms", []):
                alarms.append(
                    {
                        "source": "MetricAlarm",
                        "region": region,
                        "name": a["AlarmName"],
                        "reason": a.get("StateReason", ""),
                        "updated": a["StateUpdatedTimestamp"].isoformat(),
                        "arn": a["AlarmArn"],
                    }
                )
            for a in page.get("CompositeAlarms", []):
                alarms.append(
                    {
                        "source": "CompositeAlarm",
                        "region": region,
                        "name": a["AlarmName"],
                        "reason": a.get("StateReason", ""),
                        "updated": a["StateUpdatedTimestamp"].isoformat(),
                        "arn": a["AlarmArn"],
                    }
                )
    except ClientError as e:
        logger.warning("Region %s 拉取 CW Alarms 失败: %s", region, e)
    return alarms


def collect_health_events() -> List[Dict[str, Any]]:
    """
    拉取最近 24h 内 open / upcoming 的 AWS Health 事件。
    需要 Business/Enterprise Support，否则静默跳过。
    """
    events: List[Dict[str, Any]] = []
    try:
        # Health API 全局 endpoint 在 us-east-1
        health = boto3.client("health", region_name="us-east-1")
        since = datetime.now(timezone.utc) - timedelta(hours=24)
        paginator = health.get_paginator("describe_events")
        for page in paginator.paginate(
            filter={
                "startTimes": [{"from": since}],
                "eventStatusCodes": ["open", "upcoming"],
            }
        ):
            for ev in page.get("events", []):
                events.append(
                    {
                        "arn": ev.get("arn"),
                        "service": ev.get("service"),
                        "region": ev.get("region", "global"),
                        "type": ev.get("eventTypeCode"),
                        "category": ev.get("eventTypeCategory"),
                        "status": ev.get("statusCode"),
                        "start": ev.get("startTime").isoformat()
                        if ev.get("startTime")
                        else "",
                    }
                )
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("SubscriptionRequiredException", "AccessDeniedException"):
            logger.info(
                "Health API 不可用（需 Business/Enterprise Support），跳过: %s", code
            )
        else:
            logger.warning("Health API 调用失败: %s", e)
    except Exception as e:  # noqa: BLE001
        logger.warning("Health API 调用异常: %s", e)
    return events


# ------------------------------------------------------------
# 飞书卡片构建
# ------------------------------------------------------------
def _account_id() -> str:
    try:
        return boto3.client("sts").get_caller_identity()["Account"]
    except Exception:  # noqa: BLE001
        return "unknown"


def _console_alarm_url(region: str, alarm_name: str) -> str:
    # Console alarm 页（使用 alarm name 搜索）
    return (
        f"https://{region}.console.aws.amazon.com/cloudwatch/home"
        f"?region={region}#alarmsV2:alarm/{alarm_name}"
    )


def build_feishu_card(
    alarms: List[Dict[str, Any]], health_events: List[Dict[str, Any]]
) -> Dict[str, Any]:
    account = _account_id()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    total = len(alarms)
    health_total = len(health_events)

    if total == 0 and health_total == 0:
        emoji, template, title = "🟢", "green", "AWS 每日巡检 - 一切正常"
    elif total == 0:
        emoji, template, title = "🟡", "yellow", "AWS 每日巡检 - 有 Health 事件"
    else:
        emoji, template, title = "🔴", "red", "AWS 每日巡检 - 发现告警"

    elements: List[Dict[str, Any]] = [
        {
            "tag": "div",
            "text": {
                "tag": "lark_md",
                "content": (
                    f"**账号**: `{account}`  |  **时间**: {now}\n"
                    f"**Regions**: {', '.join(TARGET_REGIONS)}"
                ),
            },
        },
        {"tag": "hr"},
        {
            "tag": "div",
            "text": {
                "tag": "lark_md",
                "content": f"**⚠️ CloudWatch Alarms**：共 **{total}** 个处于 ALARM 状态",
            },
        },
    ]

    if alarms:
        # 按 region 分组展示
        by_region: Dict[str, List[Dict[str, Any]]] = {}
        for a in alarms:
            by_region.setdefault(a["region"], []).append(a)

        shown = 0
        for region, region_alarms in sorted(by_region.items()):
            lines = []
            for a in region_alarms:
                if shown >= MAX_ALARMS_PER_CARD:
                    break
                reason = (a["reason"] or "").replace("\n", " ")
                if len(reason) > 120:
                    reason = reason[:120] + "…"
                url = _console_alarm_url(region, a["name"])
                lines.append(
                    f"- [{a['name']}]({url})\n  `{reason or '无 reason'}`"
                )
                shown += 1
            if lines:
                elements.append(
                    {
                        "tag": "div",
                        "text": {
                            "tag": "lark_md",
                            "content": f"**📍 {region}** ({len(region_alarms)})\n"
                            + "\n".join(lines),
                        },
                    }
                )
            if shown >= MAX_ALARMS_PER_CARD:
                break
        if total > MAX_ALARMS_PER_CARD:
            elements.append(
                {
                    "tag": "note",
                    "elements": [
                        {
                            "tag": "plain_text",
                            "content": f"… 仅展示前 {MAX_ALARMS_PER_CARD} 条，还剩 "
                            f"{total - MAX_ALARMS_PER_CARD} 条未显示",
                        }
                    ],
                }
            )

    # Health 事件
    elements.append({"tag": "hr"})
    elements.append(
        {
            "tag": "div",
            "text": {
                "tag": "lark_md",
                "content": f"**🏥 AWS Health Events**：{health_total} 个 open/upcoming",
            },
        }
    )
    if health_events:
        lines = []
        for ev in health_events[:MAX_HEALTH_PER_CARD]:
            lines.append(
                f"- **[{ev['region']}]** {ev['service']} / {ev['type']} "
                f"({ev['category']}, {ev['status']})"
            )
        elements.append(
            {
                "tag": "div",
                "text": {"tag": "lark_md", "content": "\n".join(lines)},
            }
        )
        if health_total > MAX_HEALTH_PER_CARD:
            elements.append(
                {
                    "tag": "note",
                    "elements": [
                        {
                            "tag": "plain_text",
                            "content": f"… 还剩 {health_total - MAX_HEALTH_PER_CARD} 条",
                        }
                    ],
                }
            )

    # 跳转按钮
    elements.append(
        {
            "tag": "action",
            "actions": [
                {
                    "tag": "button",
                    "text": {"tag": "plain_text", "content": "打开 CloudWatch 控制台"},
                    "type": "primary",
                    "url": f"https://{TARGET_REGIONS[0]}.console.aws.amazon.com/cloudwatch/home?region={TARGET_REGIONS[0]}#alarmsV2:",
                },
                {
                    "tag": "button",
                    "text": {"tag": "plain_text", "content": "打开 Health Dashboard"},
                    "type": "default",
                    "url": "https://health.aws.amazon.com/health/home",
                },
            ],
        }
    )

    return {
        "msg_type": "interactive",
        "card": {
            "config": {"wide_screen_mode": True},
            "header": {
                "title": {
                    "tag": "plain_text",
                    "content": f"{emoji} {title} ({total} alarms)",
                },
                "template": template,
            },
            "elements": elements,
        },
    }


# ------------------------------------------------------------
# 飞书推送（含签名）
# ------------------------------------------------------------
def _gen_sign(secret: str, timestamp: int) -> str:
    string_to_sign = f"{timestamp}\n{secret}"
    hmac_code = hmac.new(
        string_to_sign.encode("utf-8"), digestmod=hashlib.sha256
    ).digest()
    return base64.b64encode(hmac_code).decode("utf-8")


def push_to_feishu(payload: Dict[str, Any]) -> None:
    if FEISHU_WEBHOOK_SECRET:
        ts = int(time.time())
        payload = {
            **payload,
            "timestamp": str(ts),
            "sign": _gen_sign(FEISHU_WEBHOOK_SECRET, ts),
        }

    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        FEISHU_WEBHOOK_URL,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    last_err: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                body = resp.read().decode("utf-8")
                logger.info("Feishu response: %s", body)
                result = json.loads(body)
                if result.get("code", 0) != 0 and result.get("StatusCode", 0) != 0:
                    raise RuntimeError(f"Feishu returned error: {body}")
                return
        except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError) as e:
            last_err = e
            logger.warning("Feishu push attempt %d failed: %s", attempt + 1, e)
            time.sleep(2 ** attempt)
    raise RuntimeError(f"Feishu push failed after 3 attempts: {last_err}")


# ------------------------------------------------------------
# Lambda 入口
# ------------------------------------------------------------
def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    logger.info("Start collecting alarms across regions: %s", TARGET_REGIONS)

    all_alarms: List[Dict[str, Any]] = []
    for region in TARGET_REGIONS:
        region_alarms = collect_cloudwatch_alarms(region)
        logger.info("Region %s: %d alarms", region, len(region_alarms))
        all_alarms.extend(region_alarms)

    health_events = collect_health_events()
    logger.info("Health events: %d", len(health_events))

    card = build_feishu_card(all_alarms, health_events)
    push_to_feishu(card)

    return {
        "statusCode": 200,
        "alarmCount": len(all_alarms),
        "healthEventCount": len(health_events),
    }
