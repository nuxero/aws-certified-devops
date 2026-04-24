# Session 7: Observability & Event-Driven Automation — Hands-On (Domain 4)

> **Task Statements 4.2, 4.3**
>
> In this session you'll enable X-Ray tracing on Lambda, create EventBridge rules for common event patterns, build all three CloudWatch alarm types (static, anomaly detection, composite), and create a CloudWatch Synthetics canary.

---

## Prerequisites

- [ ] AWS CLI v2 configured
- [ ] Node.js 18+ installed
- [ ] ~$1–2 USD budget

**Estimated time:** 3–4 hours

---

## Lab 1: AWS X-Ray — Distributed Tracing

**What you'll learn:** Enable X-Ray on Lambda, trace downstream DynamoDB calls, and query traces.

### Step 1 — Create a traced Lambda function

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region)
mkdir -p xray-lab && cd xray-lab

cat > index.mjs << 'EOF'
import { DynamoDBClient, PutItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
const ddb = new DynamoDBClient({});

export const handler = async (event) => {
  const id = event.id || `item-${Date.now()}`;
  await ddb.send(new PutItemCommand({
    TableName: process.env.TABLE_NAME,
    Item: { id: { S: id }, timestamp: { S: new Date().toISOString() } }
  }));
  const result = await ddb.send(new GetItemCommand({
    TableName: process.env.TABLE_NAME, Key: { id: { S: id } }
  }));
  return { statusCode: 200, body: JSON.stringify({ id, item: result.Item }) };
};
EOF
zip function.zip index.mjs

aws dynamodb create-table --table-name xray-lab-table \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH --billing-mode PAY_PER_REQUEST

aws iam create-role --role-name XRayLabRole \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name XRayLabRole --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam attach-role-policy --role-name XRayLabRole --policy-arn arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess
aws iam attach-role-policy --role-name XRayLabRole --policy-arn arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess
sleep 10

aws lambda create-function --function-name xray-lab-function \
  --runtime nodejs18.x --handler index.handler \
  --role arn:aws:iam::${ACCOUNT_ID}:role/XRayLabRole \
  --zip-file fileb://function.zip \
  --environment Variables={TABLE_NAME=xray-lab-table} \
  --tracing-config Mode=Active --timeout 10
```

### Step 2 — Generate and query traces

```bash
for i in $(seq 1 10); do
  aws lambda invoke --function-name xray-lab-function \
    --payload "{\"id\":\"trace-$i\"}" /dev/stdout 2>/dev/null | head -1
  sleep 1
done

sleep 10

# Query traces
aws xray get-trace-summaries \
  --start-time $(date -u -d '5 minutes ago' +%s) \
  --end-time $(date -u +%s) \
  --query 'TraceSummaries[0:3].{Id:Id,Duration:Duration,HasError:HasError}'
```

Go to the X-Ray console → Service Map. You'll see `Lambda → DynamoDB` with latency on each arrow.

**How to enable X-Ray per service:**

| Service | How | Exam Keyword |
|---|---|---|
| Lambda | `--tracing-config Mode=Active` | "active tracing" |
| API Gateway | Enable on the stage settings | "stage-level tracing" |
| ECS/Fargate | X-Ray daemon as sidecar container | "sidecar" |
| EC2 | Install X-Ray daemon + instrument code | "daemon + SDK" |

**Exam takeaway:** Annotations are indexed and searchable (use for filtering). Metadata is not indexed (use for debug data). Sampling rules control cost — default is 1 req/sec + 5% of additional.

---

## Lab 2: EventBridge Rules

**What you'll learn:** Create rules for the event patterns the exam tests most.

### Step 1 — Set up notification target

```bash
TOPIC_ARN=$(aws sns create-topic --name eventbridge-lab --query 'TopicArn' --output text)
aws sns subscribe --topic-arn $TOPIC_ARN --protocol email \
  --notification-endpoint your-email@example.com
```

### Step 2 — EC2 instance state change rule

```bash
aws events put-rule --name ec2-state-change \
  --event-pattern '{
    "source": ["aws.ec2"],
    "detail-type": ["EC2 Instance State-change Notification"],
    "detail": { "state": ["stopped", "terminated"] }
  }'
aws events put-targets --rule ec2-state-change \
  --targets "Id=notify,Arn=$TOPIC_ARN"
```

### Step 3 — Security group modification rule

```bash
aws events put-rule --name sg-changes \
  --event-pattern '{
    "source": ["aws.ec2"],
    "detail-type": ["AWS API Call via CloudTrail"],
    "detail": {
      "eventSource": ["ec2.amazonaws.com"],
      "eventName": ["AuthorizeSecurityGroupIngress","RevokeSecurityGroupIngress"]
    }
  }'
aws events put-targets --rule sg-changes --targets "Id=notify,Arn=$TOPIC_ARN"
```

### Step 4 — Console login without MFA rule

```bash
aws events put-rule --name no-mfa-login \
  --event-pattern '{
    "source": ["aws.signin"],
    "detail-type": ["AWS Console Sign In via CloudTrail"],
    "detail": { "additionalEventData": { "MFAUsed": ["No"] } }
  }'
aws events put-targets --rule no-mfa-login --targets "Id=notify,Arn=$TOPIC_ARN"
```

### Step 5 — Scheduled rule (cron)

```bash
aws events put-rule --name daily-2am \
  --schedule-expression "cron(0 2 * * ? *)" \
  --description "Daily at 2 AM UTC"
```

**Exam takeaway:** Know the JSON event pattern structure for EC2 state changes, CloudTrail API calls (`"detail-type": ["AWS API Call via CloudTrail"]`), AWS Health events, and GuardDuty findings. A single rule can have up to 5 targets. Cross-account events require a resource policy on the receiving event bus.

---

## Lab 3: CloudWatch Alarms — All Three Types

**What you'll learn:** Static threshold, anomaly detection, and composite alarms.

### Step 1 — Static threshold alarm with M-of-N evaluation

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name lab-lambda-errors \
  --namespace AWS/Lambda --metric-name Errors \
  --dimensions Name=FunctionName,Value=xray-lab-function \
  --statistic Sum --period 60 \
  --evaluation-periods 5 --datapoints-to-alarm 3 \
  --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching \
  --alarm-description "3 out of 5 periods with errors"
```

`datapoints-to-alarm: 3` with `evaluation-periods: 5` = "alarm if 3 of the last 5 minutes have errors." This tolerates brief spikes.

### Step 2 — Anomaly detection alarm

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name lab-lambda-duration-anomaly \
  --evaluation-periods 3 --datapoints-to-alarm 2 \
  --threshold-metric-id ad1 \
  --comparison-operator GreaterThanUpperThreshold \
  --treat-missing-data notBreaching \
  --metrics '[
    {"Id":"m1","MetricStat":{"Metric":{"Namespace":"AWS/Lambda","MetricName":"Duration","Dimensions":[{"Name":"FunctionName","Value":"xray-lab-function"}]},"Period":300,"Stat":"Average"},"ReturnData":false},
    {"Id":"ad1","Expression":"ANOMALY_DETECTION_BAND(m1, 2)","ReturnData":true}
  ]' \
  --alarm-description "Duration outside 2 standard deviations"
```

CloudWatch learns normal behavior and alerts when the metric deviates. Good for metrics with variable baselines (request count by time of day, latency patterns).

### Step 3 — Composite alarm

```bash
aws cloudwatch put-composite-alarm \
  --alarm-name lab-composite \
  --alarm-rule 'ALARM("lab-lambda-errors") AND ALARM("lab-lambda-duration-anomaly")' \
  --alarm-description "Alert only when BOTH errors AND duration anomaly — reduces noise"
```

**Exam takeaway:** Static = known thresholds. Anomaly detection = variable baselines. Composite = combine signals to reduce false positives. Know M-of-N evaluation (`datapoints-to-alarm` < `evaluation-periods`).

### Step 4 — EC2 auto-recovery alarm

This is a specific pattern the exam tests:

```bash
# Conceptual — requires a running instance
# aws cloudwatch put-metric-alarm \
#   --alarm-name ec2-auto-recover \
#   --namespace AWS/EC2 --metric-name StatusCheckFailed_System \
#   --dimensions Name=InstanceId,Value=i-1234567890abcdef0 \
#   --statistic Maximum --period 60 \
#   --evaluation-periods 2 --threshold 1 \
#   --comparison-operator GreaterThanOrEqualToThreshold \
#   --alarm-actions arn:aws:automate:${REGION}:ec2:recover
```

When `StatusCheckFailed_System` triggers, EC2 automatically recovers the instance on new hardware — same IP, same EBS volumes, same instance ID.

---

## Lab 4: CloudWatch Synthetics Canary

**What you'll learn:** Proactive endpoint monitoring.

```bash
echo "
=== Create via AWS Console (recommended for first time) ===
1. CloudWatch → Synthetics → Create canary
2. Blueprint: 'Heartbeat monitoring'
3. Name: lab-canary
4. URL: https://aws.amazon.com
5. Schedule: every 5 minutes
6. Create

The canary will:
- Hit the URL every 5 minutes
- Report success/failure as CloudWatch metrics
- Take screenshots on failure
- Trigger alarms when the endpoint is down
"
```

**Exam takeaway:** Synthetics canaries detect issues before users do. Use for API monitoring, website availability, and multi-step workflow testing. They create CloudWatch metrics you can alarm on.

---

## Cleanup

```bash
aws cloudwatch delete-alarms --alarm-names lab-lambda-errors lab-lambda-duration-anomaly
aws cloudwatch delete-alarms --alarm-names lab-composite
for RULE in ec2-state-change sg-changes no-mfa-login daily-2am; do
  aws events remove-targets --rule $RULE --ids notify 2>/dev/null
  aws events delete-rule --name $RULE 2>/dev/null
done
aws sns delete-topic --topic-arn $TOPIC_ARN
aws lambda delete-function --function-name xray-lab-function
aws dynamodb delete-table --table-name xray-lab-table
aws iam detach-role-policy --role-name XRayLabRole --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam detach-role-policy --role-name XRayLabRole --policy-arn arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess
aws iam detach-role-policy --role-name XRayLabRole --policy-arn arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess
aws iam delete-role --role-name XRayLabRole
rm -rf xray-lab
```

---

## Session 7 — Key Exam Takeaways

| Topic | What the Exam Tests |
|---|---|
| **X-Ray** | Active tracing on Lambda. Sidecar for ECS. Annotations (indexed) vs. metadata (not). Sampling rules. Service map for bottlenecks. |
| **EventBridge** | JSON event patterns for EC2, CloudTrail, Health, GuardDuty. Up to 5 targets/rule. Cross-account needs resource policy. |
| **Static alarms** | Fixed threshold. M-of-N evaluation reduces false positives. |
| **Anomaly detection** | `ANOMALY_DETECTION_BAND(metric, stddev)`. Variable baselines. |
| **Composite alarms** | AND/OR logic. Reduce noise. |
| **EC2 auto-recovery** | `StatusCheckFailed_System` → `ec2:recover`. Same IP/EBS/ID. |
| **Synthetics** | Canary scripts on schedule. Proactive monitoring. Alarms on failure. |

---

**Next:** [Session 8 — Incident & Event Response](./08-incident-event-response.md)
