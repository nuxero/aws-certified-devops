# Session 5: Resilient Cloud Solutions — Hands-On (Domain 3, 15%)

> **Task Statements 3.1, 3.2, 3.3**
>
> In this session you'll build a multi-AZ auto-scaled application behind an ALB, configure lifecycle hooks, set up Route 53 health checks with failover routing, create a cross-Region backup strategy with AWS Backup, and run a chaos engineering experiment with Fault Injection Service. You'll also work through DR strategy decision exercises.

---

## Prerequisites

- [ ] AWS CLI v2 configured
- [ ] A registered domain in Route 53 (optional — Lab 3 can be done conceptually without one)
- [ ] ~$3–5 USD budget (ALB, EC2 instances, NAT gateway charges)

**Estimated time:** 4–5 hours

---

## Lab 1: Multi-AZ Auto Scaling Group with ALB

**What you'll learn:** Build a resilient compute tier with an ALB, ASG across multiple AZs, health checks, scaling policies, and lifecycle hooks.

### Step 1 — Create the networking foundation

```bash
REGION=$(aws configure get region)
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Use the default VPC for simplicity
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)

# Get two subnets in different AZs
SUBNETS=$(aws ec2 describe-subnets \
  --filters Name=vpc-id,Values=$VPC_ID Name=default-for-az,Values=true \
  --query 'Subnets[0:2].SubnetId' --output text)
SUBNET_1=$(echo $SUBNETS | awk '{print $1}')
SUBNET_2=$(echo $SUBNETS | awk '{print $2}')

echo "VPC: $VPC_ID"
echo "Subnet 1: $SUBNET_1"
echo "Subnet 2: $SUBNET_2"

# Create security group for the ALB
ALB_SG=$(aws ec2 create-security-group \
  --group-name resilience-lab-alb-sg \
  --description "ALB security group" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress \
  --group-id $ALB_SG --protocol tcp --port 80 --cidr 0.0.0.0/0

# Create security group for EC2 instances (only allow traffic from ALB)
INSTANCE_SG=$(aws ec2 create-security-group \
  --group-name resilience-lab-instance-sg \
  --description "Instance security group - ALB traffic only" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress \
  --group-id $INSTANCE_SG --protocol tcp --port 80 \
  --source-group $ALB_SG
```

### Step 2 — Create the ALB and target group

```bash
# Create the ALB
ALB_ARN=$(aws elbv2 create-load-balancer \
  --name resilience-lab-alb \
  --subnets $SUBNET_1 $SUBNET_2 \
  --security-groups $ALB_SG \
  --scheme internet-facing \
  --type application \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)

ALB_DNS=$(aws elbv2 describe-load-balancers \
  --load-balancer-arns $ALB_ARN \
  --query 'LoadBalancers[0].DNSName' --output text)

echo "ALB DNS: $ALB_DNS"

# Create a target group with health checks
TG_ARN=$(aws elbv2 create-target-group \
  --name resilience-lab-tg \
  --protocol HTTP --port 80 \
  --vpc-id $VPC_ID \
  --target-type instance \
  --health-check-path "/health" \
  --health-check-interval-seconds 10 \
  --health-check-timeout-seconds 5 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3 \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

# Create a listener
aws elbv2 create-listener \
  --load-balancer-arn $ALB_ARN \
  --protocol HTTP --port 80 \
  --default-actions Type=forward,TargetGroupArn=$TG_ARN
```

**Key health check settings to understand:**
- `health-check-interval-seconds: 10` — check every 10 seconds
- `healthy-threshold-count: 2` — 2 consecutive passes = healthy
- `unhealthy-threshold-count: 3` — 3 consecutive failures = unhealthy
- Time to detect unhealthy: 10s × 3 = 30 seconds
- Time to recover: 10s × 2 = 20 seconds

### Step 3 — Create a launch template

```bash
AMI_ID=$(aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameter.Value' --output text)

# IAM role for instances
cat > instance-trust.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Principal": { "Service": "ec2.amazonaws.com" }, "Action": "sts:AssumeRole" }
  ]
}
EOF

aws iam create-role --role-name ResilienceLabRole \
  --assume-role-policy-document file://instance-trust.json
aws iam attach-role-policy --role-name ResilienceLabRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam create-instance-profile --instance-profile-name ResilienceLabProfile
aws iam add-role-to-instance-profile \
  --instance-profile-name ResilienceLabProfile --role-name ResilienceLabRole
sleep 10

```bash
# Create the launch template with a simple web server
cat > userdata.sh << 'USERDATA'
#!/bin/bash
yum install -y nginx
INSTANCE_ID=$(ec2-metadata -i | cut -d' ' -f2)
AZ=$(ec2-metadata -z | cut -d' ' -f2)

cat > /usr/share/nginx/html/index.html << HTML
<h1>Resilience Lab</h1>
<p>Instance: ${INSTANCE_ID}</p>
<p>AZ: ${AZ}</p>
<p>Time: $(date)</p>
HTML

cat > /usr/share/nginx/html/health << HTML
OK
HTML

# Configure nginx to serve /health
cat > /etc/nginx/conf.d/health.conf << 'NGINX'
server {
    listen 80;
    location /health {
        alias /usr/share/nginx/html/health;
        default_type text/plain;
    }
}
NGINX

systemctl start nginx
systemctl enable nginx
USERDATA

USERDATA_B64=$(base64 -w 0 userdata.sh)

aws ec2 create-launch-template \
  --launch-template-name resilience-lab-lt \
  --launch-template-data "{
    \"ImageId\": \"$AMI_ID\",
    \"InstanceType\": \"t2.micro\",
    \"IamInstanceProfile\": {\"Name\": \"ResilienceLabProfile\"},
    \"SecurityGroupIds\": [\"$INSTANCE_SG\"],
    \"UserData\": \"$USERDATA_B64\",
    \"TagSpecifications\": [{
      \"ResourceType\": \"instance\",
      \"Tags\": [{\"Key\": \"Name\", \"Value\": \"ResilienceLab\"}]
    }]
  }"
```

### Step 4 — Create the Auto Scaling group

```bash
aws autoscaling create-auto-scaling-group \
  --auto-scaling-group-name resilience-lab-asg \
  --launch-template LaunchTemplateName=resilience-lab-lt,Version='$Latest' \
  --min-size 2 \
  --max-size 6 \
  --desired-capacity 2 \
  --vpc-zone-identifier "$SUBNET_1,$SUBNET_2" \
  --target-group-arns $TG_ARN \
  --health-check-type ELB \
  --health-check-grace-period 120 \
  --tags Key=Environment,Value=lab,PropagateAtLaunch=true

echo "ASG created. Waiting for instances to launch..."
sleep 90
```

**Key settings:**
- `health-check-type: ELB` — use ALB health checks (not just EC2 status checks). This is the recommended setting and a common exam topic.
- `health-check-grace-period: 120` — give instances 2 minutes to start before health checks begin. Without this, instances get terminated before the app starts.
- `min-size: 2` across 2 AZs — ensures at least one instance per AZ.

Verify everything is working:

```bash
# Check target health
aws elbv2 describe-target-health --target-group-arn $TG_ARN \
  --query 'TargetHealthDescriptions[*].{Id:Target.Id,Health:TargetHealth.State}'

# Hit the ALB — you should see responses from different instances/AZs
for i in $(seq 1 6); do
  curl -s http://$ALB_DNS | grep -E "(Instance|AZ)"
  sleep 1
done
```

You should see responses alternating between two instances in different AZs. This is cross-zone load balancing in action.

### Step 5 — Add a target tracking scaling policy

```bash
aws autoscaling put-scaling-policy \
  --auto-scaling-group-name resilience-lab-asg \
  --policy-name target-tracking-cpu \
  --policy-type TargetTrackingScaling \
  --target-tracking-configuration '{
    "PredefinedMetricSpecification": {
      "PredefinedMetricType": "ASGAverageCPUUtilization"
    },
    "TargetValue": 50.0,
    "ScaleInCooldown": 60,
    "ScaleOutCooldown": 60
  }'

echo "Target tracking policy: maintain CPU at ~50%"
```

This automatically creates two CloudWatch alarms — one for scale-out (CPU > 50%) and one for scale-in (CPU < 50%). You don't manage the alarms directly.

### Step 6 — Add a lifecycle hook

Lifecycle hooks let you run custom actions when instances launch or terminate.

```bash
# Create an SNS topic for lifecycle notifications
LIFECYCLE_TOPIC_ARN=$(aws sns create-topic --name asg-lifecycle-events \
  --query 'TopicArn' --output text)

# Add a launch lifecycle hook
aws autoscaling put-lifecycle-hook \
  --auto-scaling-group-name resilience-lab-asg \
  --lifecycle-hook-name launch-hook \
  --lifecycle-transition autoscaling:EC2_INSTANCE_LAUNCHING \
  --heartbeat-timeout 300 \
  --default-result CONTINUE \
  --notification-target-arn $LIFECYCLE_TOPIC_ARN \
  --role-arn arn:aws:iam::${ACCOUNT_ID}:role/ResilienceLabRole

echo "Lifecycle hook created"
```

**How lifecycle hooks work:**
```
ASG decides to launch instance
  → Instance enters Pending:Wait state
    → Hook fires (SNS notification / EventBridge event)
      → You run custom actions (install software, register with service discovery, etc.)
        → Signal CONTINUE (proceed) or ABANDON (terminate)
          → If no signal within heartbeat-timeout: default-result applies
```

**Common use cases:**
- **Launch hook:** Install agents, pull configuration, register with service discovery, warm up caches
- **Terminate hook:** Drain connections, deregister from service discovery, push final logs

**Experiment:** Scale the ASG up and watch the lifecycle hook fire:

```bash
aws autoscaling set-desired-capacity \
  --auto-scaling-group-name resilience-lab-asg \
  --desired-capacity 3

# Watch the instance go through Pending:Wait
sleep 10
aws autoscaling describe-auto-scaling-instances \
  --query 'AutoScalingInstances[*].{Id:InstanceId,State:LifecycleState,AZ:AvailabilityZone}'
```

You'll see one instance in `Pending:Wait` state. After the heartbeat timeout (or if you signal CONTINUE), it moves to `InService`.

Scale back down:

```bash
aws autoscaling set-desired-capacity \
  --auto-scaling-group-name resilience-lab-asg \
  --desired-capacity 2
```

### Step 7 — Test resilience: kill an instance

```bash
# Get one of the running instances
VICTIM=$(aws autoscaling describe-auto-scaling-instances \
  --query 'AutoScalingInstances[?AutoScalingGroupName==`resilience-lab-asg`].InstanceId' \
  --output text | awk '{print $1}')

echo "Terminating instance: $VICTIM"
aws ec2 terminate-instances --instance-ids $VICTIM

# Watch the ASG replace it
for i in $(seq 1 8); do
  echo "=== $(date +%H:%M:%S) ==="
  aws autoscaling describe-auto-scaling-instances \
    --query 'AutoScalingInstances[?AutoScalingGroupName==`resilience-lab-asg`].{Id:InstanceId,State:LifecycleState,AZ:AvailabilityZone}'
  sleep 15
done
```

You'll see:
1. The terminated instance disappears
2. A new instance launches in `Pending` → `Pending:Wait` → `InService`
3. The ALB health check marks the new instance healthy
4. Traffic resumes to both AZs

**Exam takeaway:** This is the core HA pattern: ALB + ASG across multiple AZs. The ASG replaces failed instances automatically. ELB health checks (not EC2 status checks) are recommended because they verify the application is actually responding. The health check grace period prevents premature termination during startup.

### 🧹 Checkpoint

You've built a resilient multi-AZ application with auto scaling, health checks, scaling policies, and lifecycle hooks. You've seen self-healing in action.

---

## Lab 2: AWS Backup — Cross-Region DR

**What you'll learn:** Create backup plans, vaults, cross-Region copy rules, and test restore.

### Step 1 — Create a DynamoDB table to back up

```bash
aws dynamodb create-table \
  --table-name resilience-lab-data \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true

# Add some test data
for i in $(seq 1 10); do
  aws dynamodb put-item --table-name resilience-lab-data \
    --item "{\"id\":{\"S\":\"item-$i\"},\"data\":{\"S\":\"Important data $i\"},\"timestamp\":{\"S\":\"$(date -Iseconds)\"}}"
done

echo "Table created with 10 items"
```

### Step 2 — Create backup vaults

```bash
# Primary vault
aws backup create-backup-vault --backup-vault-name resilience-lab-primary

# DR vault in another Region
aws backup create-backup-vault \
  --backup-vault-name resilience-lab-dr \
  --region eu-west-1
```

### Step 3 — Create a backup plan with cross-Region copy

```bash
# Create the IAM role for AWS Backup
cat > backup-trust.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Principal": { "Service": "backup.amazonaws.com" }, "Action": "sts:AssumeRole" }
  ]
}
EOF

aws iam create-role --role-name AWSBackupLabRole \
  --assume-role-policy-document file://backup-trust.json
aws iam attach-role-policy --role-name AWSBackupLabRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup
aws iam attach-role-policy --role-name AWSBackupLabRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores

sleep 10

# Create the backup plan
BACKUP_PLAN_ID=$(aws backup create-backup-plan \
  --backup-plan '{
    "BackupPlanName": "resilience-lab-plan",
    "Rules": [
      {
        "RuleName": "DailyBackupWithCrossRegionCopy",
        "TargetBackupVaultName": "resilience-lab-primary",
        "ScheduleExpression": "cron(0 3 * * ? *)",
        "StartWindowMinutes": 60,
        "CompletionWindowMinutes": 180,
        "Lifecycle": {
          "DeleteAfterDays": 30
        },
        "CopyActions": [
          {
            "DestinationBackupVaultArn": "arn:aws:backup:eu-west-1:'${ACCOUNT_ID}':backup-vault:resilience-lab-dr",
            "Lifecycle": {
              "DeleteAfterDays": 30
            }
          }
        ]
      }
    ]
  }' \
  --query 'BackupPlanId' --output text)

echo "Backup plan: $BACKUP_PLAN_ID"
```

### Step 4 — Assign resources to the backup plan

```bash
aws backup create-backup-selection \
  --backup-plan-id $BACKUP_PLAN_ID \
  --backup-selection '{
    "SelectionName": "DynamoDBTables",
    "IamRoleArn": "arn:aws:iam::'${ACCOUNT_ID}':role/AWSBackupLabRole",
    "Resources": [
      "arn:aws:dynamodb:'${REGION}':'${ACCOUNT_ID}':table/resilience-lab-data"
    ]
  }'
```

### Step 5 — Run an on-demand backup and test restore

Don't wait for the schedule — trigger a backup now:

```bash
BACKUP_JOB_ID=$(aws backup start-backup-job \
  --backup-vault-name resilience-lab-primary \
  --resource-arn arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/resilience-lab-data \
  --iam-role-arn arn:aws:iam::${ACCOUNT_ID}:role/AWSBackupLabRole \
  --query 'BackupJobId' --output text)

echo "Backup job: $BACKUP_JOB_ID"

# Wait for completion
while true; do
  STATUS=$(aws backup describe-backup-job --backup-job-id $BACKUP_JOB_ID \
    --query 'State' --output text)
  echo "$(date +%H:%M:%S) Backup status: $STATUS"
  if [ "$STATUS" = "COMPLETED" ]; then break; fi
  if [ "$STATUS" = "FAILED" ]; then echo "FAILED"; break; fi
  sleep 15
done

# Get the recovery point ARN
RECOVERY_POINT=$(aws backup describe-backup-job --backup-job-id $BACKUP_JOB_ID \
  --query 'RecoveryPointArn' --output text)
echo "Recovery point: $RECOVERY_POINT"
```

Now restore to a new table (simulating DR recovery):

```bash
RESTORE_JOB_ID=$(aws backup start-restore-job \
  --recovery-point-arn $RECOVERY_POINT \
  --iam-role-arn arn:aws:iam::${ACCOUNT_ID}:role/AWSBackupLabRole \
  --metadata '{"targetTableName":"resilience-lab-data-restored","dynamoDBTargetTableName":"resilience-lab-data-restored"}' \
  --query 'RestoreJobId' --output text)

echo "Restore job: $RESTORE_JOB_ID"

while true; do
  STATUS=$(aws backup describe-restore-job --restore-job-id $RESTORE_JOB_ID \
    --query 'Status' --output text)
  echo "$(date +%H:%M:%S) Restore status: $STATUS"
  if [ "$STATUS" = "COMPLETED" ]; then break; fi
  if [ "$STATUS" = "FAILED" ]; then echo "FAILED"; break; fi
  sleep 15
done

# Verify the restored data
aws dynamodb scan --table-name resilience-lab-data-restored \
  --query 'Items[0:3]'
echo "Restored table has $(aws dynamodb scan --table-name resilience-lab-data-restored --select COUNT --query 'Count') items"
```

**Exam takeaway:** AWS Backup provides centralized backup management with cross-Region and cross-account copy. Know the components: backup plan (schedule + lifecycle + copy rules), backup vault (encrypted storage), backup selection (which resources). The exam tests whether you can design a backup strategy that meets specific RTO/RPO requirements.

### 🧹 Checkpoint

You've created a backup plan with cross-Region copy and tested a full backup/restore cycle.

---

## Lab 3: Route 53 Health Checks and Failover

**What you'll learn:** Create health checks, configure failover routing, and understand how Route 53 enables DR.

> **Note:** Full failover routing requires a registered domain. If you don't have one, follow the health check steps (they work without a domain) and read through the failover routing conceptually.

### Step 1 — Create a health check for the ALB

```bash
HEALTH_CHECK_ID=$(aws route53 create-health-check \
  --caller-reference "resilience-lab-$(date +%s)" \
  --health-check-config '{
    "Type": "HTTP",
    "FullyQualifiedDomainName": "'$ALB_DNS'",
    "Port": 80,
    "ResourcePath": "/health",
    "RequestInterval": 10,
    "FailureThreshold": 3
  }' \
  --query 'HealthCheck.Id' --output text)

echo "Health check: $HEALTH_CHECK_ID"

# Tag it for identification
aws route53 change-tags-for-resource \
  --resource-type healthcheck \
  --resource-id $HEALTH_CHECK_ID \
  --add-tags Key=Name,Value=resilience-lab-primary
```

### Step 2 — Monitor the health check

```bash
# Check the status
aws route53 get-health-check-status --health-check-id $HEALTH_CHECK_ID \
  --query 'HealthCheckObservations[0:3].{Region:Region,Status:StatusReport.Status}'
```

You'll see health checkers from multiple Regions reporting the status. Route 53 uses a distributed network of checkers — if enough of them report unhealthy, the health check fails.

### Step 3 — Understand failover routing (conceptual if no domain)

If you have a domain, here's how you'd set up failover:

```bash
# This is the pattern — replace with your actual hosted zone and domain
HOSTED_ZONE_ID="Z1234567890ABC"

# Primary record (points to us-east-1 ALB)
aws route53 change-resource-record-sets \
  --hosted-zone-id $HOSTED_ZONE_ID \
  --change-batch '{
    "Changes": [{
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "app.example.com",
        "Type": "A",
        "SetIdentifier": "primary",
        "Failover": "PRIMARY",
        "AliasTarget": {
          "HostedZoneId": "Z35SXDOTRQ7X7K",
          "DNSName": "primary-alb.us-east-1.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        },
        "HealthCheckId": "primary-health-check-id"
      }
    }]
  }'

# Secondary record (points to eu-west-1 ALB)
aws route53 change-resource-record-sets \
  --hosted-zone-id $HOSTED_ZONE_ID \
  --change-batch '{
    "Changes": [{
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "app.example.com",
        "Type": "A",
        "SetIdentifier": "secondary",
        "Failover": "SECONDARY",
        "AliasTarget": {
          "HostedZoneId": "Z32O12XQLNTSW2",
          "DNSName": "dr-alb.eu-west-1.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'
```

**The failover flow:**
```
User requests app.example.com
  → Route 53 checks primary health check
    → Healthy: return primary ALB IP
    → Unhealthy: return secondary ALB IP (DR Region)
```

**Key points for the exam:**
- `EvaluateTargetHealth: true` on alias records means Route 53 also checks the ALB's health (are targets healthy?)
- Primary record MUST have a health check attached
- Secondary record doesn't need a health check (but can have one)
- Failover happens within 60–90 seconds of health check failure
- Calculated health checks combine multiple checks (e.g., healthy if 2 of 3 endpoints are up)

### Step 4 — Create a CloudWatch alarm-based health check

You can also base Route 53 health checks on CloudWatch alarms:

```bash
# Create a CloudWatch alarm (e.g., on ALB 5xx errors)
aws cloudwatch put-metric-alarm \
  --alarm-name resilience-lab-5xx-alarm \
  --metric-name HTTPCode_Target_5XX_Count \
  --namespace AWS/ApplicationELB \
  --statistic Sum \
  --period 60 \
  --evaluation-periods 3 \
  --threshold 10 \
  --comparison-operator GreaterThanThreshold \
  --dimensions Name=LoadBalancer,Value=$(echo $ALB_ARN | sed 's|.*loadbalancer/||') \
  --treat-missing-data notBreaching

# Create a health check based on the alarm
CW_HEALTH_CHECK_ID=$(aws route53 create-health-check \
  --caller-reference "cw-alarm-$(date +%s)" \
  --health-check-config '{
    "Type": "CLOUDWATCH_METRIC",
    "AlarmIdentifier": {
      "Region": "'$REGION'",
      "Name": "resilience-lab-5xx-alarm"
    },
    "InsufficientDataHealthStatus": "Healthy"
  }' \
  --query 'HealthCheck.Id' --output text)

echo "CloudWatch-based health check: $CW_HEALTH_CHECK_ID"
```

**When to use which health check type:**
| Type | Use When |
|---|---|
| Endpoint (HTTP/TCP) | Checking if a specific URL/port is reachable |
| Calculated | Combining multiple health checks (e.g., 2 of 3 must pass) |
| CloudWatch alarm | Basing health on application metrics (error rates, latency, custom metrics) |

**Exam takeaway:** Route 53 health checks + failover routing is the standard DR traffic switching pattern. Know all three health check types. CloudWatch alarm-based health checks let you fail over based on application-level metrics, not just endpoint reachability.

### 🧹 Checkpoint

You've created Route 53 health checks and understand failover routing patterns.

---

## Lab 4: Fault Injection Service — Chaos Engineering

**What you'll learn:** Run a controlled chaos experiment to validate your HA architecture actually works under failure.

### Step 1 — Create the FIS experiment role

```bash
cat > fis-trust.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "fis.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

aws iam create-role --role-name FISLabRole \
  --assume-role-policy-document file://fis-trust.json

aws iam put-role-policy --role-name FISLabRole \
  --policy-name FISActions \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": [
          "ec2:StopInstances",
          "ec2:StartInstances",
          "ec2:TerminateInstances",
          "ec2:DescribeInstances"
        ],
        "Resource": "*"
      },
      {
        "Effect": "Allow",
        "Action": [
          "ec2:CreateTags"
        ],
        "Resource": "arn:aws:ec2:*:*:instance/*"
      }
    ]
  }'

sleep 10
```

### Step 2 — Create an experiment template

This experiment will stop one instance in the ASG and verify the application stays available:

```bash
EXPERIMENT_TEMPLATE_ID=$(aws fis create-experiment-template \
  --description "Stop one ASG instance - test self-healing" \
  --role-arn arn:aws:iam::${ACCOUNT_ID}:role/FISLabRole \
  --targets '{
    "asg-instances": {
      "resourceType": "aws:ec2:instance",
      "resourceTags": {"Name": "ResilienceLab"},
      "selectionMode": "COUNT(1)",
      "filters": [
        {"path": "State.Name", "values": ["running"]}
      ]
    }
  }' \
  --actions '{
    "stop-instance": {
      "actionId": "aws:ec2:stop-instances",
      "parameters": {},
      "targets": {"Instances": "asg-instances"},
      "description": "Stop one random instance"
    }
  }' \
  --stop-conditions '[{
    "source": "aws:cloudwatch:alarm",
    "value": "arn:aws:cloudwatch:'${REGION}':'${ACCOUNT_ID}':alarm:resilience-lab-5xx-alarm"
  }]' \
  --tags '{"Purpose": "ResilienceLab"}' \
  --query 'experimentTemplate.id' --output text)

echo "Experiment template: $EXPERIMENT_TEMPLATE_ID"
```

**Key components:**
- **Targets:** Which resources to affect (1 random running instance tagged `ResilienceLab`)
- **Actions:** What to do (stop the instance)
- **Stop conditions:** Safety net — if the 5xx alarm fires, abort the experiment immediately

### Step 3 — Run the experiment

Before starting, open a terminal to continuously hit the ALB:

```bash
# In a separate terminal, run this to monitor availability:
# while true; do curl -s -o /dev/null -w "%{http_code} " http://<ALB_DNS>/; sleep 1; done
```

Now run the experiment:

```bash
EXPERIMENT_ID=$(aws fis start-experiment \
  --experiment-template-id $EXPERIMENT_TEMPLATE_ID \
  --query 'experiment.id' --output text)

echo "Experiment started: $EXPERIMENT_ID"
```

### Step 4 — Observe the self-healing

```bash
# Watch the experiment and ASG simultaneously
for i in $(seq 1 12); do
  echo "=== $(date +%H:%M:%S) ==="

  # Experiment status
  EXP_STATUS=$(aws fis get-experiment --id $EXPERIMENT_ID \
    --query 'experiment.state.status' --output text)
  echo "Experiment: $EXP_STATUS"

  # ASG instance states
  aws autoscaling describe-auto-scaling-instances \
    --query 'AutoScalingInstances[?AutoScalingGroupName==`resilience-lab-asg`].{Id:InstanceId,State:LifecycleState,AZ:AvailabilityZone}'

  # Target health
  aws elbv2 describe-target-health --target-group-arn $TG_ARN \
    --query 'TargetHealthDescriptions[*].{Id:Target.Id,Health:TargetHealth.State}'

  sleep 15
done
```

**What you should observe:**
1. FIS stops one instance
2. ALB health check detects the stopped instance as unhealthy (~30 seconds)
3. ALB routes all traffic to the remaining healthy instance (no downtime for users)
4. ASG detects the unhealthy instance and launches a replacement
5. New instance starts, passes health checks, and enters service
6. Full capacity restored

If your monitoring terminal showed continuous 200 responses throughout, your HA architecture works.

**Exam takeaway:** Fault Injection Service is the AWS-native chaos engineering tool. Experiment templates define targets (what to break), actions (how to break it), and stop conditions (safety nets). Use FIS to validate that your HA/DR architecture actually works — not just in theory.

### 🧹 Checkpoint

You've run a real chaos experiment and validated that your multi-AZ architecture self-heals.

---

## Lab 5: DR Strategy Decision Exercise

**What you'll learn:** Map business requirements (RTO/RPO) to the correct DR strategy — the core skill the exam tests.

For each scenario, decide the strategy before revealing the answer.

### Scenario 1
> "RPO: 24 hours. RTO: 24 hours. Budget: minimal. The application is internal and can tolerate a full day of downtime."

<details>
<summary>Reveal answer</summary>

**Backup & Restore.** Use AWS Backup to take daily snapshots of EBS, RDS, and DynamoDB. Copy snapshots to the DR Region. On disaster, restore from snapshots and rebuild the infrastructure from CloudFormation templates. Cheapest option — you only pay for snapshot storage in the DR Region.

</details>

### Scenario 2
> "RPO: 1 hour. RTO: 15 minutes. The application is customer-facing. Database must not lose more than 1 hour of data."

<details>
<summary>Reveal answer</summary>

**Warm Standby.** Run a scaled-down copy of the full stack in the DR Region. RDS cross-Region read replica provides continuous replication (RPO < 1 hour). On failover: promote the read replica, scale up the compute tier, update Route 53. The 15-minute RTO is achievable because everything is already running — you just scale up.

</details>

### Scenario 3
> "RPO: near zero. RTO: near zero. This is a financial trading platform. Any data loss or downtime is unacceptable."

<details>
<summary>Reveal answer</summary>

**Multi-Site Active-Active.** Full production in both Regions. DynamoDB Global Tables for multi-active database replication (near-zero RPO). Route 53 latency-based routing distributes traffic. Both Regions serve production traffic simultaneously. If one Region fails, the other absorbs all traffic automatically. Most expensive, but meets the near-zero requirements.

</details>

### Scenario 4
> "RPO: 5 minutes. RTO: 1 hour. The application has a large database but lightweight compute. Budget is moderate."

<details>
<summary>Reveal answer</summary>

**Pilot Light.** Keep the database continuously replicated to the DR Region (Aurora Global Database or RDS cross-Region read replica — RPO of seconds to minutes). Compute infrastructure is defined in CloudFormation but not running. On failover: promote the DB replica, launch compute from CloudFormation, update Route 53. The 1-hour RTO allows time to spin up compute.

</details>

### Scenario 5
> "The application uses DynamoDB, Lambda, and API Gateway. It needs multi-Region availability with automatic failover."

<details>
<summary>Reveal answer</summary>

**Multi-Site Active-Active (serverless).** DynamoDB Global Tables replicate data across Regions automatically. Deploy Lambda functions and API Gateway in both Regions. Use Route 53 latency-based or failover routing with health checks. Serverless makes this cheaper than traditional active-active because you only pay for actual usage in each Region.

</details>

### Quick Reference: DR Strategy Selection

```
What's your RTO/RPO budget?

Hours / Hours (cheapest)
  └── Backup & Restore

Minutes / Minutes
  ├── Pilot Light (if compute can be launched on demand)
  └── Warm Standby (if faster RTO needed)

Seconds / Near-zero (most expensive)
  └── Multi-Site Active-Active
```

---

## Cleanup

```bash
# Delete FIS experiment template
aws fis delete-experiment-template --id $EXPERIMENT_TEMPLATE_ID
aws iam delete-role-policy --role-name FISLabRole --policy-name FISActions
aws iam delete-role --role-name FISLabRole

# Delete Route 53 health checks
aws route53 delete-health-check --health-check-id $HEALTH_CHECK_ID
aws route53 delete-health-check --health-check-id $CW_HEALTH_CHECK_ID
aws cloudwatch delete-alarms --alarm-names resilience-lab-5xx-alarm

# Delete ASG (terminates instances automatically)
aws autoscaling delete-auto-scaling-group \
  --auto-scaling-group-name resilience-lab-asg --force-delete
echo "Waiting for instances to terminate..."
sleep 60

# Delete launch template
aws ec2 delete-launch-template --launch-template-name resilience-lab-lt

# Delete ALB resources
LISTENER_ARN=$(aws elbv2 describe-listeners --load-balancer-arn $ALB_ARN \
  --query 'Listeners[0].ListenerArn' --output text)
aws elbv2 delete-listener --listener-arn $LISTENER_ARN
aws elbv2 delete-target-group --target-group-arn $TG_ARN
aws elbv2 delete-load-balancer --load-balancer-arn $ALB_ARN
echo "Waiting for ALB to delete..."
sleep 30

# Delete security groups
aws ec2 delete-security-group --group-id $INSTANCE_SG
aws ec2 delete-security-group --group-id $ALB_SG

# Delete IAM resources
aws iam remove-role-from-instance-profile \
  --instance-profile-name ResilienceLabProfile --role-name ResilienceLabRole
aws iam delete-instance-profile --instance-profile-name ResilienceLabProfile
aws iam detach-role-policy --role-name ResilienceLabRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam delete-role --role-name ResilienceLabRole

# Delete SNS topic
aws sns delete-topic --topic-arn $LIFECYCLE_TOPIC_ARN

# Delete AWS Backup resources
SELECTION_ID=$(aws backup list-backup-selections --backup-plan-id $BACKUP_PLAN_ID \
  --query 'BackupSelectionsList[0].SelectionId' --output text)
aws backup delete-backup-selection --backup-plan-id $BACKUP_PLAN_ID --selection-id $SELECTION_ID
aws backup delete-backup-plan --backup-plan-id $BACKUP_PLAN_ID

# Delete recovery points (required before deleting vaults)
for RP in $(aws backup list-recovery-points-by-backup-vault \
  --backup-vault-name resilience-lab-primary \
  --query 'RecoveryPoints[*].RecoveryPointArn' --output text 2>/dev/null); do
  aws backup delete-recovery-point --backup-vault-name resilience-lab-primary --recovery-point-arn $RP
done
aws backup delete-backup-vault --backup-vault-name resilience-lab-primary 2>/dev/null

for RP in $(aws backup list-recovery-points-by-backup-vault \
  --backup-vault-name resilience-lab-dr --region eu-west-1 \
  --query 'RecoveryPoints[*].RecoveryPointArn' --output text 2>/dev/null); do
  aws backup delete-recovery-point --backup-vault-name resilience-lab-dr \
    --recovery-point-arn $RP --region eu-west-1
done
aws backup delete-backup-vault --backup-vault-name resilience-lab-dr --region eu-west-1 2>/dev/null

aws iam detach-role-policy --role-name AWSBackupLabRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup
aws iam detach-role-policy --role-name AWSBackupLabRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores
aws iam delete-role --role-name AWSBackupLabRole

# Delete DynamoDB tables
aws dynamodb delete-table --table-name resilience-lab-data
aws dynamodb delete-table --table-name resilience-lab-data-restored 2>/dev/null

# Clean up local files
rm -f instance-trust.json userdata.sh backup-trust.json fis-trust.json
```

---

## Session 5 — Key Exam Takeaways

| Topic | What the Exam Tests |
|---|---|
| **Multi-AZ ASG + ALB** | The core HA pattern. ELB health checks (not EC2). Health check grace period. Cross-zone load balancing. |
| **Lifecycle hooks** | Launch hooks for initialization, terminate hooks for draining. `Pending:Wait` → signal CONTINUE/ABANDON. |
| **Scaling policies** | Target tracking (recommended default), step scaling (fine-grained), scheduled (predictable), predictive (ML). |
| **SQS-based scaling** | Scale ASG on `ApproximateNumberOfMessagesVisible`. Classic decoupling pattern. |
| **ECS resilience** | Circuit breaker for failed deployments. Capacity providers for ASG scaling. Fargate for serverless. Native blue/green, canary, and linear deployments (Oct 2025). |
| **Route 53 failover** | Health checks (endpoint, calculated, CloudWatch alarm) + failover routing. `EvaluateTargetHealth` on alias records. |
| **DR strategies** | Backup & Restore (hours/$), Pilot Light (minutes/$$), Warm Standby (minutes/$$$), Active-Active (seconds/$$$$). |
| **AWS Backup** | Centralized backup. Plans + vaults + selections. Cross-Region and cross-account copy. |
| **FIS** | Chaos engineering. Experiment templates: targets + actions + stop conditions. Validate HA/DR works. |
| **Aurora Global DB** | Cross-Region replication <1s lag. Promote secondary on failover. |
| **DynamoDB Global Tables** | Multi-Region multi-active. Near-zero RPO. Higher SLA (99.999%). |
| **CloudFront origin failover** | Origin groups: primary + secondary. Auto-failover on 5xx from primary. |

---

**Next:** [Session 6 — Monitoring, Metrics & Logs](./06-monitoring-metrics-logs.md)
