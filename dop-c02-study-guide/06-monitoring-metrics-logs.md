# Session 6: Monitoring, Metrics & Logs — Hands-On (Domain 4 — Monitoring and Logging, 15%)

> **Task Statement 4.1:** Configure the collection, aggregation, and storage of logs and metrics.
>
> In this session you'll install the CloudWatch agent to collect memory/disk metrics, publish custom metrics, create metric filters from log data, set up log subscriptions to Kinesis Firehose for S3 delivery, query logs with CloudWatch Logs Insights, enable VPC Flow Logs, and query CloudTrail logs with Athena.

---

## Prerequisites

- [ ] AWS CLI v2 configured
- [ ] One running EC2 instance with SSM Agent (we'll create one)
- [ ] ~$1–2 USD budget

**Estimated time:** 3–4 hours

---

## Lab 1: CloudWatch Agent — Memory & Disk Metrics

**What you'll learn:** EC2 doesn't natively report memory or disk metrics. The CloudWatch agent fills that gap. This is one of the most commonly tested topics.

### Step 1 — Launch an instance

```bash
AMI_ID=$(aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameter.Value' --output text)
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region)

VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)
SUBNET_ID=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC_ID \
  --query 'Subnets[0].SubnetId' --output text)

# Reuse or create the SSM role
aws iam create-role --role-name MonitoringLabRole \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' 2>/dev/null
aws iam attach-role-policy --role-name MonitoringLabRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam attach-role-policy --role-name MonitoringLabRole \
  --policy-arn arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy
aws iam create-instance-profile --instance-profile-name MonitoringLabProfile 2>/dev/null
aws iam add-role-to-instance-profile \
  --instance-profile-name MonitoringLabProfile --role-name MonitoringLabRole 2>/dev/null
sleep 10

INSTANCE_ID=$(aws ec2 run-instances \
  --image-id $AMI_ID --instance-type t2.micro \
  --iam-instance-profile Name=MonitoringLabProfile \
  --subnet-id $SUBNET_ID \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=MonitoringLab}]' \
  --query 'Instances[0].InstanceId' --output text)

echo "Instance: $INSTANCE_ID"
aws ec2 wait instance-running --instance-ids $INSTANCE_ID
sleep 60
```

### Step 2 — Store the agent config in Parameter Store

This is the recommended pattern — centralize the config so all instances use the same one.

```bash
aws ssm put-parameter \
  --name "/cloudwatch-agent/config" \
  --type String \
  --value '{
    "metrics": {
      "namespace": "MonitoringLab/EC2",
      "metrics_collected": {
        "mem": {
          "measurement": ["mem_used_percent", "mem_available_percent"],
          "metrics_collection_interval": 60
        },
        "disk": {
          "measurement": ["disk_used_percent"],
          "resources": ["/"],
          "metrics_collection_interval": 60
        },
        "cpu": {
          "measurement": ["cpu_usage_idle", "cpu_usage_user", "cpu_usage_system"],
          "totalcpu": true,
          "metrics_collection_interval": 60
        }
      }
    },
    "logs": {
      "logs_collected": {
        "files": {
          "collect_list": [
            {
              "file_path": "/var/log/messages",
              "log_group_name": "/monitoring-lab/system",
              "log_stream_name": "{instance_id}",
              "retention_in_days": 7
            }
          ]
        }
      }
    }
  }' \
  --overwrite
```

### Step 3 — Install and start the agent via Run Command

```bash
# Install the CloudWatch agent
aws ssm send-command \
  --instance-ids $INSTANCE_ID \
  --document-name "AWS-ConfigureAWSPackage" \
  --parameters '{"action":["Install"],"name":["AmazonCloudWatchAgent"]}' \
  --comment "Install CW agent"

sleep 30

# Start the agent with the config from Parameter Store
aws ssm send-command \
  --instance-ids $INSTANCE_ID \
  --document-name "AmazonCloudWatch-ManageAgent" \
  --parameters '{"action":["configure"],"mode":["ec2"],"optionalConfigurationSource":["ssm"],"optionalConfigurationLocation":["/cloudwatch-agent/config"],"optionalRestart":["yes"]}' \
  --comment "Configure and start CW agent"

sleep 30
echo "CloudWatch agent should be running"
```

### Step 4 — Verify the custom metrics

Wait 2–3 minutes for data to flow, then:

```bash
# List the custom metrics
aws cloudwatch list-metrics --namespace "MonitoringLab/EC2" \
  --query 'Metrics[*].{Name:MetricName,Dimensions:Dimensions[0].Value}'

# Get the latest memory utilization
aws cloudwatch get-metric-statistics \
  --namespace "MonitoringLab/EC2" \
  --metric-name "mem_used_percent" \
  --dimensions Name=InstanceId,Value=$INSTANCE_ID \
  --start-time $(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 --statistics Average \
  --query 'Datapoints | sort_by(@, &Timestamp) | [-1].{Avg:Average,Time:Timestamp}'
```

You'll see memory utilization — something EC2 can't report natively.

### Step 5 — Create an alarm on memory

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name monitoring-lab-high-memory \
  --namespace "MonitoringLab/EC2" \
  --metric-name "mem_used_percent" \
  --dimensions Name=InstanceId,Value=$INSTANCE_ID \
  --statistic Average --period 60 \
  --evaluation-periods 3 --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --alarm-description "Memory usage above 80% for 3 minutes" \
  --treat-missing-data notBreaching

echo "Alarm created: monitoring-lab-high-memory"
```

**Exam takeaway:** "How to monitor memory on EC2?" → CloudWatch agent. Store config in SSM Parameter Store. Deploy via Run Command or State Manager. This pattern appears on almost every practice exam.

### 🧹 Checkpoint

You've installed the CloudWatch agent, collected memory/disk metrics, and created an alarm.

---

## Lab 2: Custom Metrics and Metric Filters

**What you'll learn:** Publish custom application metrics and extract metrics from log data.

### Step 1 — Publish custom metrics

```bash
# Simulate an application publishing metrics
for i in $(seq 1 10); do
  ACTIVE_USERS=$((RANDOM % 100 + 50))
  RESPONSE_TIME=$((RANDOM % 500 + 100))

  aws cloudwatch put-metric-data \
    --namespace "MonitoringLab/App" \
    --metric-data \
      "[{\"MetricName\":\"ActiveUsers\",\"Value\":$ACTIVE_USERS,\"Unit\":\"Count\"},
        {\"MetricName\":\"ResponseTime\",\"Value\":$RESPONSE_TIME,\"Unit\":\"Milliseconds\"}]"

  echo "Published: ActiveUsers=$ACTIVE_USERS, ResponseTime=${RESPONSE_TIME}ms"
  sleep 2
done
```

Verify:

```bash
aws cloudwatch get-metric-statistics \
  --namespace "MonitoringLab/App" \
  --metric-name "ActiveUsers" \
  --start-time $(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 --statistics Average Maximum \
  --query 'Datapoints | sort_by(@, &Timestamp) | [-3:]'
```

### Step 2 — Create a log group and push application logs

```bash
# Create a log group
aws logs create-log-group --log-group-name /monitoring-lab/app
aws logs put-retention-policy --log-group-name /monitoring-lab/app --retention-in-days 7

# Create a log stream
aws logs create-log-stream \
  --log-group-name /monitoring-lab/app \
  --log-stream-name app-server-1

# Push some log events (simulating application logs)
TIMESTAMP=$(($(date +%s) * 1000))

aws logs put-log-events \
  --log-group-name /monitoring-lab/app \
  --log-stream-name app-server-1 \
  --log-events \
    "[{\"timestamp\":$TIMESTAMP,\"message\":\"INFO: Request processed successfully in 120ms\"},
      {\"timestamp\":$((TIMESTAMP+1000)),\"message\":\"INFO: User login from 192.168.1.100\"},
      {\"timestamp\":$((TIMESTAMP+2000)),\"message\":\"ERROR: Database connection timeout after 30s\"},
      {\"timestamp\":$((TIMESTAMP+3000)),\"message\":\"INFO: Request processed successfully in 85ms\"},
      {\"timestamp\":$((TIMESTAMP+4000)),\"message\":\"ERROR: Failed to process payment - invalid card\"},
      {\"timestamp\":$((TIMESTAMP+5000)),\"message\":\"WARN: High memory usage detected: 87%\"},
      {\"timestamp\":$((TIMESTAMP+6000)),\"message\":\"ERROR: S3 upload failed - access denied\"},
      {\"timestamp\":$((TIMESTAMP+7000)),\"message\":\"INFO: Health check passed\"},
      {\"timestamp\":$((TIMESTAMP+8000)),\"message\":\"ERROR: Lambda invocation throttled\"}]"
```

### Step 3 — Create a metric filter

Extract a CloudWatch metric from log events matching "ERROR":

```bash
aws logs put-metric-filter \
  --log-group-name /monitoring-lab/app \
  --filter-name error-count \
  --filter-pattern "ERROR" \
  --metric-transformations \
    metricName=ErrorCount,metricNamespace=MonitoringLab/App,metricValue=1,defaultValue=0

echo "Metric filter created — counts ERROR log entries"
```

Now create an alarm on the error count:

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name monitoring-lab-error-rate \
  --namespace "MonitoringLab/App" \
  --metric-name "ErrorCount" \
  --statistic Sum --period 60 \
  --evaluation-periods 1 --threshold 5 \
  --comparison-operator GreaterThanThreshold \
  --alarm-description "More than 5 errors in 1 minute"
```

Push more error logs and watch the alarm trigger:

```bash
TIMESTAMP=$(($(date +%s) * 1000))
aws logs put-log-events \
  --log-group-name /monitoring-lab/app \
  --log-stream-name app-server-1 \
  --log-events \
    "[{\"timestamp\":$TIMESTAMP,\"message\":\"ERROR: Connection refused\"},
      {\"timestamp\":$((TIMESTAMP+100)),\"message\":\"ERROR: Timeout\"},
      {\"timestamp\":$((TIMESTAMP+200)),\"message\":\"ERROR: 500 Internal Server Error\"},
      {\"timestamp\":$((TIMESTAMP+300)),\"message\":\"ERROR: Out of memory\"},
      {\"timestamp\":$((TIMESTAMP+400)),\"message\":\"ERROR: Disk full\"},
      {\"timestamp\":$((TIMESTAMP+500)),\"message\":\"ERROR: Permission denied\"}]" \
  --sequence-token $(aws logs describe-log-streams \
    --log-group-name /monitoring-lab/app \
    --log-stream-name-prefix app-server-1 \
    --query 'logStreams[0].uploadSequenceToken' --output text 2>/dev/null) 2>/dev/null

sleep 120
aws cloudwatch describe-alarms --alarm-names monitoring-lab-error-rate \
  --query 'MetricAlarms[0].StateValue'
```

**Exam takeaway:** Metric filters extract metrics from log patterns. They're NOT retroactive — only process events published after the filter is created. Common pattern: filter for "ERROR" → create metric → alarm → SNS notification.

### 🧹 Checkpoint

You've published custom metrics and created metric filters that turn log patterns into alarms.

---

## Lab 3: CloudWatch Logs Insights

**What you'll learn:** Query log data interactively — the exam tests basic query syntax.

### Step 1 — Run queries against your logs

```bash
# Find all ERROR messages
QUERY_ID=$(aws logs start-query \
  --log-group-name /monitoring-lab/app \
  --start-time $(date -u -d '1 hour ago' +%s) \
  --end-time $(date -u +%s) \
  --query-string 'fields @timestamp, @message | filter @message like /ERROR/ | sort @timestamp desc | limit 20' \
  --query 'queryId' --output text)

sleep 5
aws logs get-query-results --query-id $QUERY_ID \
  --query 'results[*][*].{Field:field,Value:value}'
```

```bash
# Count errors vs. warnings vs. info
QUERY_ID=$(aws logs start-query \
  --log-group-name /monitoring-lab/app \
  --start-time $(date -u -d '1 hour ago' +%s) \
  --end-time $(date -u +%s) \
  --query-string 'fields @message | stats count(*) as total by substr(@message, 0, 5) as level' \
  --query 'queryId' --output text)

sleep 5
aws logs get-query-results --query-id $QUERY_ID --query 'results'
```

**Key Logs Insights syntax to know for the exam:**

```
# Filter and sort
fields @timestamp, @message
| filter @message like /pattern/
| sort @timestamp desc
| limit 20

# Aggregate by time bucket
stats count(*) as cnt by bin(5m)

# Percentiles
stats pct(@duration, 50) as p50, pct(@duration, 99) as p99

# Parse structured logs
parse @message "* - * [*] \"* *\" * *" as ip, user, timestamp, method, url, status, size
| filter status = "500"
```

**Exam takeaway:** Logs Insights is for real-time, ad-hoc log analysis. Know `fields`, `filter`, `stats`, `sort`, `limit`, `parse`, and `bin()`. Athena is for querying logs already in S3 at scale.

---

## Lab 4: Log Subscriptions — Real-Time Delivery to S3

**What you'll learn:** Stream logs from CloudWatch to S3 via Kinesis Data Firehose in near real-time.

### Step 1 — Create a Firehose delivery stream

```bash
# Create the destination S3 bucket
aws s3 mb s3://monitoring-lab-logs-${ACCOUNT_ID}

# Create the Firehose IAM role
aws iam create-role --role-name FirehoseLabRole \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"firehose.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

aws iam put-role-policy --role-name FirehoseLabRole --policy-name S3Access \
  --policy-document "{
    \"Version\":\"2012-10-17\",
    \"Statement\":[{
      \"Effect\":\"Allow\",
      \"Action\":[\"s3:PutObject\",\"s3:GetBucketLocation\",\"s3:ListBucket\"],
      \"Resource\":[\"arn:aws:s3:::monitoring-lab-logs-${ACCOUNT_ID}\",\"arn:aws:s3:::monitoring-lab-logs-${ACCOUNT_ID}/*\"]
    }]
  }"

sleep 10

# Create the delivery stream
aws firehose create-delivery-stream \
  --delivery-stream-name monitoring-lab-log-delivery \
  --delivery-stream-type DirectPut \
  --s3-destination-configuration "{
    \"RoleARN\":\"arn:aws:iam::${ACCOUNT_ID}:role/FirehoseLabRole\",
    \"BucketARN\":\"arn:aws:s3:::monitoring-lab-logs-${ACCOUNT_ID}\",
    \"Prefix\":\"logs/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/\",
    \"ErrorOutputPrefix\":\"errors/\",
    \"BufferingHints\":{\"SizeInMBs\":1,\"IntervalInSeconds\":60}
  }"

echo "Firehose stream created"
```

### Step 2 — Create the subscription filter

```bash
# CloudWatch Logs needs permission to put records to Firehose
# Create a role for CloudWatch Logs
aws iam create-role --role-name CWLogsToFirehoseRole \
  --assume-role-policy-document "{
    \"Version\":\"2012-10-17\",
    \"Statement\":[{
      \"Effect\":\"Allow\",
      \"Principal\":{\"Service\":\"logs.${REGION}.amazonaws.com\"},
      \"Action\":\"sts:AssumeRole\"
    }]
  }"

aws iam put-role-policy --role-name CWLogsToFirehoseRole --policy-name FirehosePut \
  --policy-document "{
    \"Version\":\"2012-10-17\",
    \"Statement\":[{
      \"Effect\":\"Allow\",
      \"Action\":\"firehose:PutRecord\",
      \"Resource\":\"arn:aws:firehose:${REGION}:${ACCOUNT_ID}:deliverystream/monitoring-lab-log-delivery\"
    }]
  }"

sleep 10

# Create the subscription filter
aws logs put-subscription-filter \
  --log-group-name /monitoring-lab/app \
  --filter-name send-to-s3 \
  --filter-pattern "" \
  --destination-arn "arn:aws:firehose:${REGION}:${ACCOUNT_ID}:deliverystream/monitoring-lab-log-delivery" \
  --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/CWLogsToFirehoseRole"

echo "Subscription filter created — all logs now stream to S3"
```

### Step 3 — Push logs and verify delivery

```bash
# Push more logs
TIMESTAMP=$(($(date +%s) * 1000))
aws logs put-log-events \
  --log-group-name /monitoring-lab/app \
  --log-stream-name app-server-1 \
  --log-events "[{\"timestamp\":$TIMESTAMP,\"message\":\"INFO: Subscription test at $(date)\"}]" 2>/dev/null

echo "Waiting 90 seconds for Firehose to buffer and deliver..."
sleep 90

# Check S3 for delivered logs
aws s3 ls s3://monitoring-lab-logs-${ACCOUNT_ID}/logs/ --recursive
```

**Key distinction for the exam:**
| Method | Latency | Use Case |
|---|---|---|
| Subscription → Firehose → S3 | ~60 seconds | Near real-time log archival |
| `CreateExportTask` | Up to 12 hours | One-time batch export |
| Subscription → Lambda | Seconds | Real-time processing/transformation |
| Subscription → OpenSearch | ~seconds | Real-time search and dashboards |

**Exam takeaway:** For near real-time log delivery to S3, use subscription filter → Firehose. Never use `CreateExportTask` for real-time — it's batch only.

---

## Lab 5: VPC Flow Logs and CloudTrail with Athena

**What you'll learn:** Enable VPC Flow Logs, set up CloudTrail, and query both with Athena.

### Step 1 — Enable VPC Flow Logs to S3

```bash
aws s3 mb s3://monitoring-lab-flowlogs-${ACCOUNT_ID}

aws ec2 create-flow-logs \
  --resource-type VPC \
  --resource-ids $VPC_ID \
  --traffic-type ALL \
  --log-destination-type s3 \
  --log-destination arn:aws:s3:::monitoring-lab-flowlogs-${ACCOUNT_ID}/flow-logs/ \
  --max-aggregation-interval 60

echo "VPC Flow Logs enabled — data will appear in ~5 minutes"
```

### Step 2 — Create an Athena table for flow logs

```bash
# Create an Athena workgroup and results bucket
aws s3 mb s3://monitoring-lab-athena-${ACCOUNT_ID}

aws athena start-query-execution \
  --query-string "CREATE DATABASE IF NOT EXISTS monitoring_lab" \
  --result-configuration "OutputLocation=s3://monitoring-lab-athena-${ACCOUNT_ID}/"

sleep 5

aws athena start-query-execution \
  --query-string "
    CREATE EXTERNAL TABLE IF NOT EXISTS monitoring_lab.vpc_flow_logs (
      version int, account_id string, interface_id string,
      srcaddr string, dstaddr string, srcport int, dstport int,
      protocol bigint, packets bigint, bytes bigint,
      start bigint, end_time bigint, action string, log_status string
    )
    ROW FORMAT DELIMITED FIELDS TERMINATED BY ' '
    LOCATION 's3://monitoring-lab-flowlogs-${ACCOUNT_ID}/flow-logs/AWSLogs/${ACCOUNT_ID}/vpcflowlogs/${REGION}/'
  " \
  --query-execution-context Database=monitoring_lab \
  --result-configuration "OutputLocation=s3://monitoring-lab-athena-${ACCOUNT_ID}/"

echo "Athena table created. Wait 5-10 minutes for flow log data to accumulate."
```

### Step 3 — Query flow logs with Athena

After waiting for data:

```bash
# Find rejected traffic
QUERY_ID=$(aws athena start-query-execution \
  --query-string "
    SELECT srcaddr, dstaddr, dstport, protocol, action, sum(packets) as total_packets
    FROM monitoring_lab.vpc_flow_logs
    WHERE action = 'REJECT'
    GROUP BY srcaddr, dstaddr, dstport, protocol, action
    ORDER BY total_packets DESC
    LIMIT 10
  " \
  --query-execution-context Database=monitoring_lab \
  --result-configuration "OutputLocation=s3://monitoring-lab-athena-${ACCOUNT_ID}/" \
  --query 'QueryExecutionId' --output text)

echo "Query: $QUERY_ID — check results in the Athena console"
sleep 10

aws athena get-query-results --query-execution-id $QUERY_ID \
  --query 'ResultSet.Rows[0:5]' 2>/dev/null
```

**Exam takeaway:** Athena queries logs in S3 using SQL. Use it for CloudTrail, VPC Flow Logs, ALB access logs, and WAF logs. Partition by date to reduce cost. CloudWatch Logs Insights is for real-time; Athena is for historical analysis at scale.

---

## Cleanup

```bash
# Delete subscription filter
aws logs delete-subscription-filter --log-group-name /monitoring-lab/app --filter-name send-to-s3

# Delete Firehose
aws firehose delete-delivery-stream --delivery-stream-name monitoring-lab-log-delivery
aws iam delete-role-policy --role-name FirehoseLabRole --policy-name S3Access
aws iam delete-role --role-name FirehoseLabRole
aws iam delete-role-policy --role-name CWLogsToFirehoseRole --policy-name FirehosePut
aws iam delete-role --role-name CWLogsToFirehoseRole

# Delete CloudWatch resources
aws cloudwatch delete-alarms --alarm-names monitoring-lab-high-memory monitoring-lab-error-rate
aws logs delete-metric-filter --log-group-name /monitoring-lab/app --filter-name error-count
aws logs delete-log-group --log-group-name /monitoring-lab/app
aws logs delete-log-group --log-group-name /monitoring-lab/system 2>/dev/null

# Delete VPC Flow Logs
FLOW_LOG_ID=$(aws ec2 describe-flow-logs --filter Name=resource-id,Values=$VPC_ID \
  --query 'FlowLogs[0].FlowLogId' --output text)
aws ec2 delete-flow-logs --flow-log-ids $FLOW_LOG_ID 2>/dev/null

# Delete Athena resources
aws athena start-query-execution \
  --query-string "DROP TABLE IF EXISTS monitoring_lab.vpc_flow_logs" \
  --query-execution-context Database=monitoring_lab \
  --result-configuration "OutputLocation=s3://monitoring-lab-athena-${ACCOUNT_ID}/" 2>/dev/null
aws athena start-query-execution \
  --query-string "DROP DATABASE IF EXISTS monitoring_lab" \
  --result-configuration "OutputLocation=s3://monitoring-lab-athena-${ACCOUNT_ID}/" 2>/dev/null

# Delete S3 buckets
aws s3 rb s3://monitoring-lab-logs-${ACCOUNT_ID} --force
aws s3 rb s3://monitoring-lab-flowlogs-${ACCOUNT_ID} --force
aws s3 rb s3://monitoring-lab-athena-${ACCOUNT_ID} --force

# Delete SSM parameter
aws ssm delete-parameter --name "/cloudwatch-agent/config"

# Delete EC2 instance
aws ec2 terminate-instances --instance-ids $INSTANCE_ID
aws ec2 wait instance-terminated --instance-ids $INSTANCE_ID
aws iam remove-role-from-instance-profile --instance-profile-name MonitoringLabProfile --role-name MonitoringLabRole
aws iam delete-instance-profile --instance-profile-name MonitoringLabProfile
aws iam detach-role-policy --role-name MonitoringLabRole --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam detach-role-policy --role-name MonitoringLabRole --policy-arn arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy
aws iam delete-role --role-name MonitoringLabRole
```

---

## Session 6 — Key Exam Takeaways

| Topic | What the Exam Tests |
|---|---|
| **CloudWatch agent** | Required for memory/disk metrics. Config in SSM Parameter Store. Deploy via Run Command/State Manager. |
| **Custom metrics** | `PutMetricData` API. High-resolution (1s) vs. standard (60s). Batch up to 1000 data points. |
| **Metric filters** | Extract metrics from log patterns. NOT retroactive. Pattern → metric → alarm → action. |
| **Log subscriptions** | Real-time streaming to Lambda, Kinesis, OpenSearch. Firehose for S3 delivery (~60s). |
| **CreateExportTask** | Batch export to S3. Up to 12 hours delay. NOT real-time. |
| **Logs Insights** | Real-time ad-hoc queries. Know `fields`, `filter`, `stats`, `sort`, `parse`, `bin()`. |
| **Athena** | SQL queries on logs in S3 (CloudTrail, Flow Logs, ALB logs). Partition by date. $5/TB scanned. |
| **CloudTrail** | Management events (default) vs. data events (opt-in). Organization trail for all accounts. Log integrity validation. |
| **VPC Flow Logs** | VPC/subnet/ENI level. Destinations: CloudWatch Logs, S3, Firehose. ACCEPT/REJECT traffic. |
| **Log retention** | Default: never expire. Always set retention to control costs. |
| **Log encryption** | KMS key policy must allow `logs.<region>.amazonaws.com` service principal. |
| **Metric streams** | Near real-time to Firehose → third-party tools (Datadog, Splunk). |

---

**Next:** [Session 7 — Observability & Event-Driven Automation](./07-observability-event-automation.md)
