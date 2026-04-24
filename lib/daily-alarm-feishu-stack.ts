import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';

export interface DailyAlarmFeishuStackProps extends cdk.StackProps {
  /** 飞书自定义机器人 Webhook URL */
  feishuWebhookUrl: string;
  /** 飞书机器人签名校验 secret（可选，留空则不启用） */
  feishuWebhookSecret?: string;
  /** 遍历的 AWS Region 列表 */
  targetRegions: string[];
  /** EventBridge Scheduler 调度表达式（默认 UTC，可通过 scheduleTimezone 指定） */
  scheduleExpression: string;
  /** 调度时区（IANA 格式，如 Asia/Shanghai、UTC）；默认 UTC */
  scheduleTimezone?: string;
}

export class DailyAlarmFeishuStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DailyAlarmFeishuStackProps) {
    super(scope, id, props);

    if (!props.feishuWebhookUrl) {
      throw new Error(
        '必须提供 FEISHU_WEBHOOK_URL（环境变量或 -c feishuWebhookUrl=xxx）'
      );
    }

    // ---- Log Group ----
    // 显式建 LogGroup（替代已废弃的 Function#logRetention）
    // 命名遵守 Lambda 默认规则：/aws/lambda/<function-name>
    // 这里不写死 function name，让 CDK 自动生成并按物理 id 引用
    const logGroup = new logs.LogGroup(this, 'DailyAlarmLambdaLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // cdk destroy 时一并删除
    });

    // ---- Lambda ----
    const handler = new lambda.Function(this, 'DailyAlarmLambda', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      logGroup, // 显式指定 LogGroup，CDK 会自动保证 function name 与 LogGroup 匹配
      environment: {
        FEISHU_WEBHOOK_URL: props.feishuWebhookUrl,
        FEISHU_WEBHOOK_SECRET: props.feishuWebhookSecret || '',
        TARGET_REGIONS: props.targetRegions.join(','),
      },
      description: 'Aggregate AWS alarms and push to Feishu daily',
    });

    // ---- IAM: Lambda 执行权限 ----
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cloudwatch:DescribeAlarms',
          'cloudwatch:DescribeAlarmHistory',
          'health:DescribeEvents',
          'health:DescribeEventDetails',
          'health:DescribeAffectedEntities',
          'ec2:DescribeRegions',
        ],
        resources: ['*'],
      })
    );

    // ---- EventBridge Scheduler ----
    // 使用新版 EventBridge Scheduler（不是 legacy Rules）
    // 优势：原生支持 timezone、flexible time window、统一管理面板

    // 1) Scheduler 调用 Lambda 的执行角色
    const schedulerRole = new iam.Role(this, 'SchedulerInvokeRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Allow EventBridge Scheduler to invoke Lambda',
    });
    handler.grantInvoke(schedulerRole);

    // 2) Schedule
    const timezone = props.scheduleTimezone || 'UTC';
    const schedule = new scheduler.CfnSchedule(this, 'DailyAlarmSchedule', {
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: props.scheduleExpression,
      scheduleExpressionTimezone: timezone,
      description: 'Daily trigger for AWS alarm digest to Feishu',
      state: 'ENABLED',
      target: {
        arn: handler.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ source: 'eventbridge-scheduler' }),
        retryPolicy: {
          maximumRetryAttempts: 2,
          maximumEventAgeInSeconds: 3600,
        },
      },
    });

    // ---- Outputs ----
    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value: handler.functionName,
      description: 'Lambda 函数名，可用 aws lambda invoke 手动触发测试',
    });

    new cdk.CfnOutput(this, 'InvokeCommand', {
      value: `aws lambda invoke --function-name ${handler.functionName} --payload '{}' /tmp/out.json && cat /tmp/out.json`,
      description: '手动触发命令（测试用）',
    });

    new cdk.CfnOutput(this, 'ScheduleName', {
      value: schedule.ref,
      description: 'EventBridge Scheduler 名称（在 Scheduler → Schedules 下查看）',
    });

    new cdk.CfnOutput(this, 'ScheduleExpression', {
      value: `${props.scheduleExpression} (${timezone})`,
      description: '当前调度表达式 + 时区',
    });

    new cdk.CfnOutput(this, 'TargetRegions', {
      value: props.targetRegions.join(','),
      description: '遍历的 AWS Region',
    });
  }
}
