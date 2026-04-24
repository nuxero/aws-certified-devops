# Session 8: Incident & Event Response — Hands-On (Domain 5, 14%)

> **Task Statements 5.1, 5.2, 5.3**
>
> In this session you'll build an automated security remediation pipeline using EventBridge + Lambda, create a Config rule that auto-remediates open security groups, set up a CloudWatch Synthetics canary for proactive monitoring, and work through troubleshooting exercises for failed deployments.

---

## Prerequisites

- [ ] AWS CLI v2 configured
- [ ] Python 3.9+ (for Lambda functions)
- [ ] ~$1 USD budget

**Estimated time:** 3–4 hours

---

## Lab 1: EventBridge + Lambda — Auto-Remediate Open Security Groups

**What you'll learn:** Detect a security group change via CloudTrail/EventBridge and automatically revert it with Lambda.

### Step 1 — Create the remediation Lambda

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region)

mkdir -p incident-lab && cd incident-lab

cat > remediate_sg.py << 'EOF'
import json
import boto3

ec2 = boto3.client('ec2')
sns = boto3.client('sns')

TOPIC_ARN = None  # Set via environment variable

def handler(event, context):
    print(f"Event: {json.dumps(event)}")

    detail = event.get('detail', {})
    event_name = detail.get('eventName', '')
    request_params = detail.get('requestParameters', {})

    if event_name != 'AuthorizeSecurityGroupIngress':
        return {'status': 'skipped', 'reason': 'Not an ingress authorization'}

    sg_id = request_params.get('groupId', '')
    ip_permissions = request_params.get('ipPermissions', {}).get('items', [])

    revoked = []
    for perm in ip_permissions:
        ip_ranges = perm.get('ipRanges', {}).get('items', [])
        for ip_range in ip_ranges:
            cidr = ip_range.get('cidrIp', '')
            if cidr == '0.0.0.0/0':
                from_port = perm.get('fromPort', 0)
                to_port = perm.get('toPort', 65535)
                protocol = perm.get('ipProtocol', 'tcp')

                try:
                    ec2.revoke_security_group_ingress(
                        GroupId=sg_id,
                        IpPermissions=[{
                            'IpProtocol': protocol,
                            'FromPort': from_port,
                            'ToPort': to_port,
                            'IpRanges': [{'CidrIp': '0.0.0.0/0'}]
                        }]
                    )
                    revoked.append(f"{protocol}:{from_port}-{to_port}")
                    print(f"Revoked: {sg_id} {protocol}:{from_port}-{to_port} from 0.0.0.0/0")
                except Exception as e:
                    print(f"Error revoking: {e}")

    if revoked and TOPIC_ARN:
        user = detail.get('userIdentity', {}).get('arn', 'unknown')
        sns.publish(
            TopicArn=TOPIC_ARN,
            Subject=f"Security Group Remediated: {sg_id}",
            Message=f"Revoked rules: {', '.join(revoked)}\nOpened by: {user}\nSG: {sg_id}"
        )

    return {'status': 'remediated', 'sg': sg_id, 'revoked': revoked}
EOF

zip remediate_sg.zip remediate_sg.py

# Create the Lambda role
aws iam create-role --role-name IncidentLabRole \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name IncidentLabRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam put-role-policy --role-name IncidentLabRole --policy-name EC2AndSNS \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["ec2:RevokeSecurityGroupIngress","ec2:DescribeSecurityGroups"],"Resource":"*"},{"Effect":"Allow","Action":"sns:Publish","Resource":"*"}]}'
sleep 10

# Create SNS topic
TOPIC_ARN=$(aws sns create-topic --name sg-remediation-alerts --query 'TopicArn' --output text)

# Create the Lambda function
aws lambda create-function \
  --function-name sg-auto-remediate \
  --runtime python3.12 --handler remediate_sg.handler \
  --role arn:aws:iam::${ACCOUNT_ID}:role/IncidentLabRole \
  --zip-file fileb://remediate_sg.zip \
  --environment Variables={TOPIC_ARN=$TOPIC_ARN} \
  --timeout 30
```

### Step 2 — Create the EventBridge rule

```bash
aws events put-rule --name detect-open-sg \
  --event-pattern '{
    "source": ["aws.ec2"],
    "detail-type": ["AWS API Call via CloudTrail"],
    "detail": {
      "eventSource": ["ec2.amazonaws.com"],
      "eventName": ["AuthorizeSecurityGroupIngress"]
    }
  }'

# Grant EventBridge permission to invoke the Lambda
aws lambda add-permission \
  --function-name sg-auto-remediate \
  --statement-id eventbridge-invoke \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/detect-open-sg

aws events put-targets --rule detect-open-sg \
  --targets "Id=remediate,Arn=arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:sg-auto-remediate"
```

### Step 3 — Test it

```bash
# Create a test security group
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)

TEST_SG=$(aws ec2 create-security-group \
  --group-name incident-lab-test-sg \
  --description "Test SG for remediation" \
  --vpc-id $VPC_ID --query 'GroupId' --output text)

echo "Test SG: $TEST_SG"

# Open SSH to the world (this is what we want to auto-remediate)
aws ec2 authorize-security-group-ingress \
  --group-id $TEST_SG --protocol tcp --port 22 --cidr 0.0.0.0/0

echo "Opened port 22 to 0.0.0.0/0 — waiting for EventBridge + Lambda to remediate..."
echo "(CloudTrail events can take 1-5 minutes to appear in EventBridge)"
sleep 120

# Check if the rule was revoked
RULES=$(aws ec2 describe-security-groups --group-ids $TEST_SG \
  --query 'SecurityGroups[0].IpPermissions')
echo "Current ingress rules: $RULES"
```

If the remediation worked, the ingress rules should be empty — the Lambda revoked the 0.0.0.0/0 rule automatically.

**Check the Lambda logs:**
```bash
aws logs tail /aws/lambda/sg-auto-remediate --since 5m
```

**The full flow:**
```
Someone opens SG port 22 to 0.0.0.0/0
  → CloudTrail logs AuthorizeSecurityGroupIngress
    → EventBridge matches the event pattern
      → Lambda function invoked
        → Checks if any rule has 0.0.0.0/0
          → Revokes the rule
            → Sends SNS notification
```

**Exam takeaway:** This EventBridge + Lambda pattern is the go-to for real-time security remediation. For compliance-based remediation (periodic checks), use Config rules + SSM Automation instead.

---

## Lab 2: Troubleshooting Exercises

**What you'll learn:** Diagnose common deployment and infrastructure failures — the exam presents these as scenarios.

### Exercise 1: CodeDeploy Failure

> A CodeDeploy deployment to an ASG fails. 3 of 5 instances succeed, but 2 fail at the `AfterInstall` hook. The deployment uses `CodeDeployDefault.HalfAtATime`.

**Troubleshooting steps (work through these mentally):**

1. Where to look first?
   - CodeDeploy console → deployment → view events per instance
   - On the failing instances: `/opt/codedeploy-agent/deployment-root/<deployment-group>/<deployment-id>/logs/scripts.log`

2. Common causes for `AfterInstall` failures:
   - Script doesn't have execute permissions (`chmod +x`)
   - Script references a file/package not yet installed
   - Script assumes a specific working directory
   - AZ-specific issue (e.g., an EFS mount point only available in certain AZs)

3. How to debug:
   - Use Session Manager to connect to a failing instance (no SSH needed)
   - Check the script log for the exact error
   - Run the script manually to reproduce

4. How to prevent:
   - Add `set -e` to scripts (fail fast on any error)
   - Add logging to each script step
   - Use `ValidateService` hook to verify the deployment before marking success
   - Configure automatic rollback on failure + CloudWatch alarm

### Exercise 2: CloudFormation Stack Update Failure

> A CloudFormation stack update fails with `UPDATE_ROLLBACK_COMPLETE`. The engineer can't determine what went wrong.

**Troubleshooting steps:**

```bash
# Find the first failure event
aws cloudformation describe-stack-events --stack-name <STACK_NAME> \
  --query 'StackEvents[?ResourceStatus==`UPDATE_FAILED`] | [0].{Resource:LogicalResourceId,Reason:ResourceStatusReason}'
```

Common causes:
- IAM permissions insufficient for the resource being created/updated
- Resource limit reached (e.g., max VPCs, max EIPs)
- Property value invalid (e.g., wrong AMI ID for the Region)
- Dependency not ready (use `DependsOn` to fix ordering)
- Resource replacement blocked by stack policy

**Tip:** Use `--disable-rollback` during development to inspect the failed state without automatic rollback.

### Exercise 3: ECS Service Not Reaching Steady State

> An ECS service keeps starting and stopping tasks. The desired count is 3 but only 1 task is running.

**Troubleshooting steps:**

```bash
# Check stopped task reasons
aws ecs describe-tasks --cluster <CLUSTER> \
  --tasks $(aws ecs list-tasks --cluster <CLUSTER> --desired-status STOPPED \
    --query 'taskArns[0:3]' --output text) \
  --query 'tasks[*].{Reason:stoppedReason,Status:lastStatus}'
```

Common causes:
- Container exits immediately (check CloudWatch Logs for the container)
- Health check failing (wrong path, wrong port, app not ready in time)
- Insufficient memory/CPU (task definition requests more than available)
- Image not found (ECR permissions, wrong image URI)
- Port conflict (another task using the same host port)

### Exercise 4: ASG Instances Cycling

> ASG keeps launching and terminating instances in a loop. Desired=2, but instances never stay healthy.

**Diagnosis:**

```bash
aws autoscaling describe-scaling-activities \
  --auto-scaling-group-name <ASG_NAME> \
  --query 'Activities[0:5].{Status:StatusCode,Cause:Cause}'
```

Common causes:
- Health check grace period too short (app hasn't started yet when health check runs)
- Wrong health check path (returns 404 instead of 200)
- Security group blocks health check traffic from ALB
- Application crashes on startup (check instance logs)

**Fix:** Increase `health-check-grace-period`, verify health check path, check security group rules.

**Exam takeaway:** The exam presents failure scenarios and asks you to identify the root cause or the correct troubleshooting approach. Know where to look for each service: CodeDeploy (agent logs on instance), CloudFormation (stack events), ECS (stopped task reason), ASG (scaling activities).

---

## Lab 3: OpsCenter — Centralized Incident Management

**What you'll learn:** How OpsCenter aggregates operational issues.

```bash
# Create an OpsItem manually (in production, these are auto-created from alarms/events)
aws ssm create-ops-item \
  --title "High error rate on production API" \
  --description "Error rate exceeded 5% for 10 minutes. Investigating root cause." \
  --source "CloudWatch" \
  --severity "2" \
  --priority 1 \
  --operational-data '{
    "AlarmName": {"Value": "prod-api-error-rate", "Type": "SearchableString"},
    "Service": {"Value": "payment-api", "Type": "SearchableString"}
  }'

# List OpsItems
aws ssm describe-ops-items \
  --ops-item-filters Key=Status,Values=Open,Operator=Equal \
  --query 'OpsItemSummaries[*].{Id:OpsItemId,Title:Title,Severity:Severity,Status:Status}'
```

**The OpsCenter flow:**
```
CloudWatch alarm fires → EventBridge → Creates OpsItem
  → Engineer sees it in OpsCenter
    → Investigates (linked CloudWatch data, runbooks)
      → Runs SSM Automation to remediate
        → Resolves OpsItem
```

**Exam takeaway:** OpsCenter is the centralized place for operational issues. OpsItems are auto-created from CloudWatch alarms, Config rules, and EventBridge events. Engineers investigate and remediate from a single pane.

---

## Cleanup

```bash
# Delete Lambda and EventBridge
aws events remove-targets --rule detect-open-sg --ids remediate
aws events delete-rule --name detect-open-sg
aws lambda delete-function --function-name sg-auto-remediate
aws iam delete-role-policy --role-name IncidentLabRole --policy-name EC2AndSNS
aws iam detach-role-policy --role-name IncidentLabRole --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name IncidentLabRole
aws sns delete-topic --topic-arn $TOPIC_ARN
aws ec2 delete-security-group --group-id $TEST_SG

# Resolve OpsItems
for OPS_ID in $(aws ssm describe-ops-items --ops-item-filters Key=Status,Values=Open,Operator=Equal \
  --query 'OpsItemSummaries[*].OpsItemId' --output text); do
  aws ssm update-ops-item --ops-item-id $OPS_ID --status Resolved
done

rm -rf incident-lab
```

---

## Session 8 — Key Exam Takeaways

| Topic | What the Exam Tests |
|---|---|
| **EventBridge + Lambda** | Real-time event-driven remediation. Know event patterns for security events. |
| **Config + SSM Automation** | Compliance-based remediation. Periodic or on-change evaluation. |
| **Troubleshooting CodeDeploy** | Agent logs on instance. AppSpec errors. Script permissions. Lifecycle hook failures. |
| **Troubleshooting CloudFormation** | Stack events → first `*_FAILED` event. `--disable-rollback` for debugging. |
| **Troubleshooting ECS** | Stopped task reason. Container logs. Health check path/port. Memory/CPU limits. |
| **Troubleshooting ASG** | Scaling activities. Health check grace period. Security group rules. |
| **AWS Health + EventBridge** | Auto-respond to instance retirement, scheduled maintenance. |
| **OpsCenter** | Centralized OpsItems. Auto-created from alarms/events. Link to runbooks. |
| **Synthetics** | Proactive endpoint monitoring. Detect issues before users. |
| **RCA framework** | Detect → Triage → Investigate → Identify → Remediate → Prevent. |

---

**Next:** [Session 9 — IAM & Security at Scale](./09-iam-security-at-scale.md)
