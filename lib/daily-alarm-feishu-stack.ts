import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';

export interface DailyAlarmFeishuStackProps extends cdk.StackProps {
  /** 飞书自定义机器人 Webhook URL */
  feishuWebhookUrl: string;
  /** 飞书机器人签名校验 secret（可选，留空则不启用） */
  feishuWebhookSecret?: string;
  /** 遍历的 AWS Region 列表 */
  targetRegions: string[];
  /** EventBridge schedule 表达式（UTC） */
  scheduleExpression: string;
}

export class DailyAlarmFeishuStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DailyAlarmFeishuStackProps) {
    super(scope, id, props);

    if (!props.feishuWebhookUrl) {
      throw new Error(
        '必须提供 FEISHU_WEBHOOK_URL（环境变量或 -c feishuWebhookUrl=xxx）'
      );
    }

    // ---- Lambda ----
    const handler = new lambda.Function(this, 'DailyAlarmLambda', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        FEISHU_WEBHOOK_URL: props.feishuWebhookUrl,
        FEISHU_WEBHOOK_SECRET: props.feishuWebhookSecret || '',
        TARGET_REGIONS: props.targetRegions.join(','),
      },
      description: 'Aggregate AWS alarms and push to Feishu daily',
    });

    // ---- IAM 权限 ----
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

    // ---- EventBridge Rule (cron) ----
    const rule = new events.Rule(this, 'DailyAlarmSchedule', {
      schedule: events.Schedule.expression(props.scheduleExpression),
      description: 'Daily trigger for AWS alarm digest to Feishu',
    });
    rule.addTarget(new targets.LambdaFunction(handler));

    // ---- Outputs ----
    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value: handler.functionName,
      description: 'Lambda 函数名，可用 aws lambda invoke 手动触发测试',
    });

    new cdk.CfnOutput(this, 'InvokeCommand', {
      value: `aws lambda invoke --function-name ${handler.functionName} --payload '{}' /tmp/out.json && cat /tmp/out.json`,
      description: '手动触发命令（测试用）',
    });

    new cdk.CfnOutput(this, 'ScheduleExpression', {
      value: props.scheduleExpression,
      description: '当前调度表达式（UTC）',
    });

    new cdk.CfnOutput(this, 'TargetRegions', {
      value: props.targetRegions.join(','),
      description: '遍历的 AWS Region',
    });
  }
}
