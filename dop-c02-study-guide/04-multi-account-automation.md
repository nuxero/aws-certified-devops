# Session 4: Multi-Account Automation & Configuration Management — Hands-On (Domain 2)

> **Task Statements 2.2, 2.3**
>
> In this session you'll write and attach SCPs, use every major Systems Manager capability (Run Command, Patch Manager, State Manager, Automation, Session Manager, Inventory), set up AWS Config rules with auto-remediation, deploy application configuration with AppConfig, and build a Step Functions automation workflow. These are the operational backbone of the DOP-C02 exam.

---

## Prerequisites

- [ ] AWS CLI v2 configured
- [ ] An AWS account (ideally with Organizations enabled — but single-account labs are provided)
- [ ] One running EC2 instance with SSM Agent (we'll create one in Lab 2)
- [ ] Python 3.9+ (for a custom Config rule)
- [ ] ~$1–2 USD budget

**Estimated time:** 4–5 hours

---

## Lab 1: Service Control Policies

**What you'll learn:** Write, attach, and test SCPs. Understand how they interact with IAM policies.

> **Note:** SCPs require AWS Organizations. If you have a single standalone account, you can still create an organization (free) and work with SCPs on it. If you'd rather not, read through this lab conceptually — the exam heavily tests SCP logic.

### Step 1 — Enable Organizations (if not already)

```bash
# Check if you already have an organization
aws organizations describe-organization 2>/dev/null

# If not, create one (free — no charges)
aws organizations create-organization --feature-set ALL
```

### Step 2 — Create an OU and an SCP

```bash
# Get the root ID
ROOT_ID=$(aws organizations list-roots --query 'Roots[0].Id' --output text)
echo "Root ID: $ROOT_ID"

# Create a Sandbox OU
SANDBOX_OU_ID=$(aws organizations create-organizational-unit \
  --parent-id $ROOT_ID \
  --name Sandbox \
  --query 'OrganizationalUnit.Id' --output text)
echo "Sandbox OU: $SANDBOX_OU_ID"
```

### Step 3 — Write and attach a Region-restriction SCP

```bash
cat > region-restrict-scp.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyNonApprovedRegions",
      "Effect": "Deny",
      "Action": "*",
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "aws:RequestedRegion": [
            "us-east-1",
            "eu-west-1"
          ]
        },
        "ArnNotLike": {
          "aws:PrincipalARN": "arn:aws:iam::*:role/OrganizationAdmin"
        }
      }
    }
  ]
}
EOF

SCP_ID=$(aws organizations create-policy \
  --name "RegionRestriction" \
  --description "Deny all actions outside us-east-1 and eu-west-1" \
  --type SERVICE_CONTROL_POLICY \
  --content file://region-restrict-scp.json \
  --query 'Policy.PolicySummary.Id' --output text)

echo "SCP ID: $SCP_ID"
```

**What to notice in this SCP:**
- `Effect: Deny` — SCPs are most commonly used as deny lists
- `StringNotEquals` on `aws:RequestedRegion` — blocks all Regions except the two listed
- `ArnNotLike` exception — allows an `OrganizationAdmin` role to bypass the restriction (break-glass)
- This SCP doesn't grant any permissions — it only restricts what IAM policies can do

### Step 4 — Attach the SCP to the Sandbox OU

```bash
aws organizations attach-policy \
  --policy-id $SCP_ID \
  --target-id $SANDBOX_OU_ID
```

If you moved an account into this OU, any user in that account would be blocked from using services in ap-southeast-1, us-west-2, etc. — even if their IAM policy says `Allow *`.

### Step 5 — Write more SCP patterns (don't attach — just understand them)

**Prevent disabling security services:**

```bash
cat > security-guardrails-scp.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyDisablingCloudTrail",
      "Effect": "Deny",
      "Action": [
        "cloudtrail:StopLogging",
        "cloudtrail:DeleteTrail",
        "cloudtrail:UpdateTrail"
      ],
      "Resource": "*"
    },
    {
      "Sid": "DenyDisablingGuardDuty",
      "Effect": "Deny",
      "Action": [
        "guardduty:DeleteDetector",
        "guardduty:DisassociateFromMasterAccount",
        "guardduty:UpdateDetector"
      ],
      "Resource": "*"
    },
    {
      "Sid": "DenyDisablingConfig",
      "Effect": "Deny",
      "Action": [
        "config:StopConfigurationRecorder",
        "config:DeleteConfigurationRecorder"
      ],
      "Resource": "*"
    },
    {
      "Sid": "DenyLeavingOrg",
      "Effect": "Deny",
      "Action": "organizations:LeaveOrganization",
      "Resource": "*"
    }
  ]
}
EOF
```

**Prevent public S3 buckets:**

```bash
cat > deny-public-s3-scp.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyPublicS3",
      "Effect": "Deny",
      "Action": "s3:PutBucketPublicAccessBlock",
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "s3:PublicAccessBlockConfiguration/BlockPublicAcls": "true"
        }
      }
    }
  ]
}
EOF
```

Read through each one. The exam presents scenarios like "prevent anyone in the organization from disabling GuardDuty" and expects you to write or identify the correct SCP.

**Exam takeaway:** SCPs are deny-based guardrails. They don't grant permissions. The management account is never affected. Common patterns: Region restriction, prevent disabling security services, prevent leaving the organization, enforce encryption.

### 🧹 Checkpoint

You understand how SCPs work, how to write them, and the common patterns the exam tests.

---

## Lab 2: Systems Manager — The Full Tour

**What you'll learn:** Run Command, Session Manager, State Manager, Inventory, Patch Manager, and Automation — all hands-on with a real EC2 instance.

### Step 1 — Launch a managed instance

```bash
# Get the latest Amazon Linux 2023 AMI
AMI_ID=$(aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameter.Value' --output text)

# Create an IAM role for SSM
cat > ssm-trust.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Principal": { "Service": "ec2.amazonaws.com" }, "Action": "sts:AssumeRole" }
  ]
}
EOF

aws iam create-role --role-name SSMLabRole \
  --assume-role-policy-document file://ssm-trust.json

aws iam attach-role-policy --role-name SSMLabRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

aws iam attach-role-policy --role-name SSMLabRole \
  --policy-arn arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy

aws iam create-instance-profile --instance-profile-name SSMLabProfile
aws iam add-role-to-instance-profile \
  --instance-profile-name SSMLabProfile --role-name SSMLabRole

sleep 10

# Launch the instance (no SSH key needed — we'll use Session Manager)
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)
SUBNET_ID=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC_ID \
  --query 'Subnets[0].SubnetId' --output text)

INSTANCE_ID=$(aws ec2 run-instances \
  --image-id $AMI_ID \
  --instance-type t2.micro \
  --iam-instance-profile Name=SSMLabProfile \
  --subnet-id $SUBNET_ID \
  --tag-specifications \
    'ResourceType=instance,Tags=[{Key=Name,Value=SSM-Lab},{Key=Environment,Value=dev},{Key=PatchGroup,Value=dev-servers}]' \
  --query 'Instances[0].InstanceId' --output text)

echo "Instance: $INSTANCE_ID"
aws ec2 wait instance-running --instance-ids $INSTANCE_ID
echo "Instance is running. Waiting 60s for SSM agent to register..."
sleep 60
```

Verify the instance is managed by SSM:

```bash
aws ssm describe-instance-information \
  --filters Key=InstanceIds,Values=$INSTANCE_ID \
  --query 'InstanceInformationList[0].{Id:InstanceId,PingStatus:PingStatus,AgentVersion:AgentVersion}'
```

You should see `PingStatus: Online`. If not, wait another 30 seconds and retry.

### Step 2 — Run Command

Execute commands on the instance without SSH:

```bash
# Run a simple command
COMMAND_ID=$(aws ssm send-command \
  --instance-ids $INSTANCE_ID \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["hostname","uptime","cat /etc/os-release","df -h"]' \
  --comment "System info check" \
  --query 'Command.CommandId' --output text)

echo "Command: $COMMAND_ID"
sleep 5

# Get the output
aws ssm get-command-invocation \
  --command-id $COMMAND_ID \
  --instance-id $INSTANCE_ID \
  --query '{Status:Status,Output:StandardOutputContent}'
```

Now run a command that targets by tag (this is how you'd run across a fleet):

```bash
aws ssm send-command \
  --targets Key=tag:Environment,Values=dev \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["echo Running on $(hostname) at $(date)"]' \
  --comment "Fleet-wide command" \
  --max-concurrency "50%" \
  --max-errors "1"
```

**Key parameters:**
- `--targets` — select instances by tag, not by ID (scales to thousands)
- `--max-concurrency` — run on N instances or N% at a time
- `--max-errors` — stop if N instances fail

**Exam takeaway:** Run Command is the go-to for executing commands across a fleet without SSH. Target by tags for fleet operations. Use `MaxConcurrency` and `MaxErrors` for safe rollouts.

### Step 3 — Session Manager

Connect to the instance without SSH keys or open ports:

```bash
# Start a session (opens an interactive shell)
aws ssm start-session --target $INSTANCE_ID
```

You're now in a shell on the instance. Try:

```bash
whoami          # ssm-user
hostname
cat /etc/os-release
exit
```

**No SSH key. No security group rule for port 22. No bastion host.** Session Manager uses the SSM agent and IAM for authentication.

**Configure session logging** (so all commands are audited):

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region)

# Create an S3 bucket for session logs
aws s3 mb s3://ssm-session-logs-${ACCOUNT_ID}

# Create a CloudWatch log group
aws logs create-log-group --log-group-name /ssm/session-logs

# Update SSM session preferences
cat > session-prefs.json << EOF
{
  "schemaVersion": "1.0",
  "description": "Session Manager settings",
  "sessionManagerConfiguration": {
    "s3BucketName": "ssm-session-logs-${ACCOUNT_ID}",
    "s3EncryptionEnabled": true,
    "cloudWatchLogGroupName": "/ssm/session-logs",
    "cloudWatchEncryptionEnabled": false
  }
}
EOF

aws ssm update-document \
  --name "SSM-SessionManagerRunShell" \
  --document-version '$LATEST' \
  --content file://session-prefs.json 2>/dev/null || \
aws ssm create-document \
  --name "SSM-SessionManagerRunShell" \
  --document-type "Session" \
  --content file://session-prefs.json 2>/dev/null

echo "Session logging configured"
```

**Exam takeaway:** Session Manager replaces SSH/bastion hosts. All sessions can be logged to S3 and CloudWatch Logs for auditing. Access is controlled via IAM policies.

### Step 4 — State Manager

State Manager ensures instances stay in a desired state by running SSM documents on a schedule.

```bash
# Create an association that installs and starts the CloudWatch agent
aws ssm create-association \
  --name "AWS-ConfigureAWSPackage" \
  --targets Key=tag:Environment,Values=dev \
  --parameters '{"action":["Install"],"name":["AmazonCloudWatchAgent"]}' \
  --association-name "install-cw-agent" \
  --schedule-expression "rate(1 day)" \
  --compliance-severity CRITICAL

# Check the association status
aws ssm list-associations \
  --query 'Associations[?AssociationName==`install-cw-agent`].{Name:AssociationName,Status:Overview.Status}'
```

This ensures the CloudWatch agent is installed on every instance tagged `Environment=dev`. If someone uninstalls it, State Manager reinstalls it within 24 hours (or on the next schedule run).

**Exam takeaway:** State Manager maintains desired state. It runs SSM documents on a schedule or on instance launch. Use it for: ensuring agents are installed, applying configurations, maintaining compliance.

### Step 5 — Inventory

Collect metadata about what's installed on your instances:

```bash
# Create an inventory association
aws ssm create-association \
  --name "AWS-GatherSoftwareInventory" \
  --targets Key=tag:Environment,Values=dev \
  --schedule-expression "rate(12 hours)" \
  --association-name "gather-inventory"

# Wait a minute, then check what was collected
sleep 60

aws ssm list-inventory-entries \
  --instance-id $INSTANCE_ID \
  --type-name "AWS:Application" \
  --query 'Entries[0:5].{Name:Name,Version:Version}'
```

You'll see a list of installed packages. This data can be synced to S3 for analysis with Athena, or used with Config for compliance reporting.

### Step 6 — Patch Manager

Set up automated patching:

```bash
# Create a custom patch baseline
BASELINE_ID=$(aws ssm create-patch-baseline \
  --name "DevServerBaseline" \
  --operating-system AMAZON_LINUX_2023 \
  --approval-rules '{
    "PatchRules": [
      {
        "PatchFilterGroup": {
          "PatchFilters": [
            { "Key": "CLASSIFICATION", "Values": ["Security"] },
            { "Key": "SEVERITY", "Values": ["Critical", "Important"] }
          ]
        },
        "ApproveAfterDays": 0,
        "ComplianceLevel": "CRITICAL",
        "EnableNonSecurity": false
      }
    ]
  }' \
  --description "Auto-approve critical security patches immediately" \
  --query 'BaselineId' --output text)

echo "Baseline: $BASELINE_ID"

# Register the patch group
aws ssm register-patch-baseline-for-patch-group \
  --baseline-id $BASELINE_ID \
  --patch-group "dev-servers"
```

Now scan for missing patches (without installing them):

```bash
# Scan only (don't install)
SCAN_CMD=$(aws ssm send-command \
  --document-name "AWS-RunPatchBaseline" \
  --targets Key=tag:PatchGroup,Values=dev-servers \
  --parameters '{"Operation":["Scan"]}' \
  --query 'Command.CommandId' --output text)

echo "Scan command: $SCAN_CMD"
sleep 30

# Check compliance
aws ssm describe-instance-patch-states \
  --instance-ids $INSTANCE_ID \
  --query 'InstancePatchStates[0].{Instance:InstanceId,Installed:InstalledCount,Missing:MissingCount,Failed:FailedCount}'
```

To actually install patches, change `Operation` to `Install`:

```bash
# Install patches (do this in a maintenance window in production)
aws ssm send-command \
  --document-name "AWS-RunPatchBaseline" \
  --targets Key=tag:PatchGroup,Values=dev-servers \
  --parameters '{"Operation":["Install"]}' \
  --comment "Install security patches"
```

**Exam takeaway:** Patch Manager workflow: create baseline → assign patch groups (by tag) → scan or install via `AWS-RunPatchBaseline`. In production, use maintenance windows to schedule patching. The exam tests whether you know the difference between Scan and Install operations.

### Step 7 — Automation runbooks

Run a multi-step automation:

```bash
# Use the built-in runbook to create an AMI
AUTOMATION_ID=$(aws ssm start-automation-execution \
  --document-name "AWS-CreateImage" \
  --parameters "{\"InstanceId\":[\"$INSTANCE_ID\"],\"NoReboot\":[\"true\"]}" \
  --query 'AutomationExecutionId' --output text)

echo "Automation: $AUTOMATION_ID"

# Watch it execute
while true; do
  STATUS=$(aws ssm get-automation-execution \
    --automation-execution-id $AUTOMATION_ID \
    --query 'AutomationExecution.AutomationExecutionStatus' --output text)
  echo "$(date +%H:%M:%S) Status: $STATUS"
  if [ "$STATUS" != "InProgress" ]; then break; fi
  sleep 10
done

# Get the AMI ID that was created
aws ssm get-automation-execution \
  --automation-execution-id $AUTOMATION_ID \
  --query 'AutomationExecution.Outputs'
```

Now let's write a custom runbook. Create `custom-runbook.yaml`:

```yaml
description: Custom runbook - Tag instance and verify
schemaVersion: '0.3'
parameters:
  InstanceId:
    type: String
    description: The instance to tag
  TagValue:
    type: String
    description: Value for the AutomatedBy tag
    default: SSM-Automation
mainSteps:
  - name: TagInstance
    action: aws:executeAwsApi
    inputs:
      Service: ec2
      Api: CreateTags
      Resources:
        - '{{ InstanceId }}'
      Tags:
        - Key: AutomatedBy
          Value: '{{ TagValue }}'
    description: Add a tag to the instance

  - name: VerifyTag
    action: aws:executeAwsApi
    inputs:
      Service: ec2
      Api: DescribeInstances
      InstanceIds:
        - '{{ InstanceId }}'
    outputs:
      - Name: Tags
        Selector: '$.Reservations[0].Instances[0].Tags'
        Type: MapList
    description: Verify the tag was applied

  - name: LogResult
    action: aws:executeAwsApi
    inputs:
      Service: ssm
      Api: PutParameter
      Name: '/automation/last-tagged-instance'
      Value: '{{ InstanceId }}'
      Type: String
      Overwrite: true
    description: Log which instance was tagged
```

```bash
# Create the document
aws ssm create-document \
  --name "Custom-TagAndVerify" \
  --document-type "Automation" \
  --content file://custom-runbook.yaml \
  --document-format YAML

# Run it
aws ssm start-automation-execution \
  --document-name "Custom-TagAndVerify" \
  --parameters "{\"InstanceId\":[\"$INSTANCE_ID\"],\"TagValue\":[\"Lab4-Demo\"]}"
```

**Exam takeaway:** Automation runbooks are YAML-based multi-step workflows. They use `aws:executeAwsApi` to call any AWS API. Pre-built runbooks exist for common tasks. Custom runbooks are used for organization-specific automation. They can be triggered by EventBridge, maintenance windows, or Config remediation.

### 🧹 Checkpoint

You've now used every major SSM capability:
- Run Command (execute commands across fleet)
- Session Manager (SSH replacement with logging)
- State Manager (maintain desired state)
- Inventory (collect instance metadata)
- Patch Manager (scan and install patches)
- Automation (multi-step runbooks)

---

## Lab 3: AWS Config Rules with Auto-Remediation

**What you'll learn:** Set up Config, create managed and custom rules, and wire up automatic remediation via SSM Automation.

### Step 1 — Enable AWS Config (if not already)

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region)

# Create a bucket for Config data
aws s3 mb s3://config-data-${ACCOUNT_ID}

# Create the Config service role
cat > config-trust.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Principal": { "Service": "config.amazonaws.com" }, "Action": "sts:AssumeRole" }
  ]
}
EOF

aws iam create-role --role-name ConfigServiceRole \
  --assume-role-policy-document file://config-trust.json

aws iam attach-role-policy --role-name ConfigServiceRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWS_ConfigRole

aws iam put-role-policy --role-name ConfigServiceRole \
  --policy-name S3Access \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Action\": [\"s3:PutObject\", \"s3:GetBucketAcl\"],
      \"Resource\": [
        \"arn:aws:s3:::config-data-${ACCOUNT_ID}\",
        \"arn:aws:s3:::config-data-${ACCOUNT_ID}/*\"
      ]
    }]
  }"

# Set up the configuration recorder
aws configservice put-configuration-recorder \
  --configuration-recorder name=default,roleARN=arn:aws:iam::${ACCOUNT_ID}:role/ConfigServiceRole \
  --recording-group allSupported=true,includeGlobalResourceTypes=true

# Set up the delivery channel
aws configservice put-delivery-channel \
  --delivery-channel name=default,s3BucketName=config-data-${ACCOUNT_ID}

# Start recording
aws configservice start-configuration-recorder --configuration-recorder-name default

echo "AWS Config is recording"
```

### Step 2 — Add a managed Config rule

```bash
# Rule: S3 buckets must have server-side encryption enabled
aws configservice put-config-rule \
  --config-rule '{
    "ConfigRuleName": "s3-encryption-required",
    "Source": {
      "Owner": "AWS",
      "SourceIdentifier": "S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED"
    },
    "Scope": {
      "ComplianceResourceTypes": ["AWS::S3::Bucket"]
    }
  }'

echo "Config rule created. Waiting for initial evaluation..."
sleep 30

# Check compliance
aws configservice get-compliance-details-by-config-rule \
  --config-rule-name s3-encryption-required \
  --compliance-types NON_COMPLIANT \
  --query 'EvaluationResults[*].{Resource:EvaluationResultIdentifier.EvaluationResultQualifier.ResourceId,Status:ComplianceType}'
```

You might see some non-compliant buckets (any S3 bucket without default encryption).

### Step 3 — Create a non-compliant resource to test

```bash
# Create an S3 bucket WITHOUT encryption (intentionally non-compliant)
aws s3 mb s3://config-test-noncompliant-${ACCOUNT_ID}

# Wait for Config to evaluate
echo "Waiting 60s for Config to evaluate the new bucket..."
sleep 60

# Check — it should be NON_COMPLIANT
aws configservice get-compliance-details-by-config-rule \
  --config-rule-name s3-encryption-required \
  --compliance-types NON_COMPLIANT \
  --query 'EvaluationResults[?EvaluationResultIdentifier.EvaluationResultQualifier.ResourceId==`config-test-noncompliant-'${ACCOUNT_ID}'`].ComplianceType'
```

### Step 4 — Set up auto-remediation

Now wire the Config rule to automatically fix non-compliant buckets:

```bash
# Create an IAM role for the remediation automation
cat > remediation-role-trust.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Principal": { "Service": "ssm.amazonaws.com" }, "Action": "sts:AssumeRole" }
  ]
}
EOF

aws iam create-role --role-name ConfigRemediationRole \
  --assume-role-policy-document file://remediation-role-trust.json

aws iam put-role-policy --role-name ConfigRemediationRole \
  --policy-name S3Encryption \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": [
        "s3:PutEncryptionConfiguration",
        "s3:GetEncryptionConfiguration"
      ],
      "Resource": "*"
    }]
  }'

sleep 10

# Add auto-remediation to the Config rule
aws configservice put-remediation-configurations \
  --remediation-configurations '[{
    "ConfigRuleName": "s3-encryption-required",
    "TargetType": "SSM_DOCUMENT",
    "TargetId": "AWS-EnableS3BucketEncryption",
    "Parameters": {
      "BucketName": {
        "ResourceValue": { "Value": "RESOURCE_ID" }
      },
      "SSEAlgorithm": {
        "StaticValue": { "Values": ["AES256"] }
      },
      "AutomationAssumeRole": {
        "StaticValue": { "Values": ["arn:aws:iam::'${ACCOUNT_ID}':role/ConfigRemediationRole"] }
      }
    },
    "Automatic": true,
    "MaximumAutomaticAttempts": 3,
    "RetryAttemptSeconds": 60
  }]'

echo "Auto-remediation configured!"
```

### Step 5 — Watch the remediation happen

```bash
# Trigger remediation manually (or wait for Config to detect and auto-remediate)
aws configservice start-remediation-execution \
  --config-rule-name s3-encryption-required \
  --resource-keys '[{"resourceType":"AWS::S3::Bucket","resourceId":"config-test-noncompliant-'${ACCOUNT_ID}'"}]'

echo "Remediation triggered. Waiting 30s..."
sleep 30

# Verify the bucket now has encryption
aws s3api get-bucket-encryption \
  --bucket config-test-noncompliant-${ACCOUNT_ID}
```

You should see `AES256` encryption is now enabled — Config detected the non-compliance and SSM Automation fixed it automatically.

**The full flow you just built:**
```
S3 bucket created without encryption
  → Config rule evaluates → NON_COMPLIANT
    → Auto-remediation triggers SSM Automation runbook (AWS-EnableS3BucketEncryption)
      → Runbook enables AES256 encryption on the bucket
        → Config re-evaluates → COMPLIANT
```

**Exam takeaway:** This Config rule + SSM Automation remediation pattern is one of the most tested topics on the exam. Know the flow: Config detects → SSM Automation remediates. Know common managed rules (`s3-bucket-server-side-encryption-enabled`, `restricted-ssh`, `encrypted-volumes`, `cloudtrail-enabled`).

### 🧹 Checkpoint

You've set up AWS Config with a managed rule and automatic remediation. You've seen the full detect → remediate → re-evaluate cycle.

---

## Lab 4: AWS AppConfig — Feature Flags and Configuration Deployment

**What you'll learn:** Deploy application configuration separately from code, with gradual rollout and automatic rollback.

### Step 1 — Create the AppConfig resources

```bash
# Create an application
APP_ID=$(aws appconfig create-application \
  --name devops-lab-app \
  --description "Lab application for AppConfig" \
  --query 'Id' --output text)

# Create environments
DEV_ENV_ID=$(aws appconfig create-environment \
  --application-id $APP_ID \
  --name dev \
  --description "Development environment" \
  --query 'Id' --output text)

PROD_ENV_ID=$(aws appconfig create-environment \
  --application-id $APP_ID \
  --name prod \
  --description "Production environment" \
  --query 'Id' --output text)

echo "App: $APP_ID, Dev: $DEV_ENV_ID, Prod: $PROD_ENV_ID"
```

### Step 2 — Create a configuration profile with feature flags

```bash
# Create a feature flag configuration profile
PROFILE_ID=$(aws appconfig create-configuration-profile \
  --application-id $APP_ID \
  --name feature-flags \
  --location-uri "hosted" \
  --type "AWS.AppConfig.FeatureFlags" \
  --query 'Id' --output text)

echo "Profile: $PROFILE_ID"

# Create the initial configuration version
cat > feature-flags.json << 'EOF'
{
  "version": "1",
  "flags": {
    "dark_mode": {
      "name": "Dark Mode",
      "description": "Enable dark mode UI",
      "attributes": {}
    },
    "new_checkout": {
      "name": "New Checkout Flow",
      "description": "Enable the redesigned checkout experience",
      "attributes": {}
    }
  },
  "values": {
    "dark_mode": {
      "enabled": true
    },
    "new_checkout": {
      "enabled": false
    }
  }
}
EOF

VERSION_NUM=$(aws appconfig create-hosted-configuration-version \
  --application-id $APP_ID \
  --configuration-profile-id $PROFILE_ID \
  --content fileb://feature-flags.json \
  --content-type "application/json" \
  --query 'VersionNumber' --output text)

echo "Config version: $VERSION_NUM"
```

### Step 3 — Create a deployment strategy

```bash
# Linear deployment: roll out over 10 minutes
STRATEGY_ID=$(aws appconfig create-deployment-strategy \
  --name "LinearTenMinutes" \
  --deployment-duration-in-minutes 10 \
  --growth-factor 20 \
  --growth-type LINEAR \
  --replicate-to NONE \
  --description "Linear rollout: 20% every 2 minutes" \
  --query 'Id' --output text)

echo "Strategy: $STRATEGY_ID"
```

### Step 4 — Deploy to dev (instant) and prod (gradual)

```bash
# Deploy to dev — use the built-in instant strategy
aws appconfig start-deployment \
  --application-id $APP_ID \
  --environment-id $DEV_ENV_ID \
  --deployment-strategy-id "AppConfig.AllAtOnce" \
  --configuration-profile-id $PROFILE_ID \
  --configuration-version $VERSION_NUM

echo "Deployed to dev (instant)"

# Deploy to prod — use our gradual strategy
aws appconfig start-deployment \
  --application-id $APP_ID \
  --environment-id $PROD_ENV_ID \
  --deployment-strategy-id $STRATEGY_ID \
  --configuration-profile-id $PROFILE_ID \
  --configuration-version $VERSION_NUM

echo "Deploying to prod (linear over 10 minutes)..."
```

Watch the prod deployment progress:

```bash
# Check deployment status
for i in $(seq 1 6); do
  DEPLOY_STATE=$(aws appconfig list-deployments \
    --application-id $APP_ID \
    --environment-id $PROD_ENV_ID \
    --query 'Items[0].{State:State,Percentage:PercentageComplete}')
  echo "$(date +%H:%M:%S) $DEPLOY_STATE"
  sleep 120
done
```

### Step 5 — Retrieve the configuration (as an application would)

```bash
# Start a configuration session
SESSION_TOKEN=$(aws appconfigdata start-configuration-session \
  --application-identifier $APP_ID \
  --environment-identifier $DEV_ENV_ID \
  --configuration-profile-identifier $PROFILE_ID \
  --query 'InitialConfigurationToken' --output text)

# Get the latest configuration
aws appconfigdata get-latest-configuration \
  --configuration-token $SESSION_TOKEN \
  --output text | python3 -m json.tool
```

You'll see the feature flags with their current values. In a real application, you'd poll this periodically (AppConfig caches and handles the polling efficiently).

### Step 6 — Update a flag and redeploy

```bash
# Enable the new checkout flow
cat > feature-flags-v2.json << 'EOF'
{
  "version": "1",
  "flags": {
    "dark_mode": { "name": "Dark Mode", "description": "Enable dark mode UI", "attributes": {} },
    "new_checkout": { "name": "New Checkout Flow", "description": "Enable the redesigned checkout experience", "attributes": {} }
  },
  "values": {
    "dark_mode": { "enabled": true },
    "new_checkout": { "enabled": true }
  }
}
EOF

VERSION_2=$(aws appconfig create-hosted-configuration-version \
  --application-id $APP_ID \
  --configuration-profile-id $PROFILE_ID \
  --content fileb://feature-flags-v2.json \
  --content-type "application/json" \
  --query 'VersionNumber' --output text)

# Deploy v2 to prod with gradual rollout
aws appconfig start-deployment \
  --application-id $APP_ID \
  --environment-id $PROD_ENV_ID \
  --deployment-strategy-id $STRATEGY_ID \
  --configuration-profile-id $PROFILE_ID \
  --configuration-version $VERSION_2

echo "Deploying v2 to prod (new_checkout enabled)"
```

**Exam takeaway:** AppConfig decouples configuration from code deployments. Key features: gradual rollout (like canary for config), validators (JSON Schema or Lambda), automatic rollback on CloudWatch alarm. Use it for feature flags, operational tuning, and allow/deny lists.

### 🧹 Checkpoint

You've deployed feature flags with AppConfig using gradual rollout — the same pattern the exam tests.

---

## Lab 5: Step Functions Automation Workflow

**What you'll learn:** Build a multi-step automation workflow with error handling, parallel execution, and choice states.

### Step 1 — Create the Step Functions execution role

```bash
cat > sfn-trust.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Principal": { "Service": "states.amazonaws.com" }, "Action": "sts:AssumeRole" }
  ]
}
EOF

aws iam create-role --role-name StepFunctionsLabRole \
  --assume-role-policy-document file://sfn-trust.json

aws iam put-role-policy --role-name StepFunctionsLabRole \
  --policy-name EC2AndSNS \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": ["ec2:DescribeInstances", "ec2:CreateTags", "ec2:CreateSnapshot", "ec2:DescribeSnapshots"],
        "Resource": "*"
      },
      {
        "Effect": "Allow",
        "Action": ["sns:Publish"],
        "Resource": "*"
      }
    ]
  }'
```

### Step 2 — Define the state machine

This workflow simulates an incident response: gather instance info → create a backup snapshot → tag the instance → notify the team.

```bash
cat > incident-response.json << 'DEFINITION'
{
  "Comment": "Incident response workflow - gather info, backup, tag, notify",
  "StartAt": "GatherInstanceInfo",
  "States": {
    "GatherInstanceInfo": {
      "Type": "Task",
      "Resource": "arn:aws:states:::aws-sdk:ec2:describeInstances",
      "Parameters": {
        "InstanceIds.$": "States.Array($.InstanceId)"
      },
      "ResultPath": "$.InstanceInfo",
      "Next": "ParallelActions",
      "Catch": [{
        "ErrorEquals": ["States.ALL"],
        "Next": "HandleError",
        "ResultPath": "$.Error"
      }]
    },

    "ParallelActions": {
      "Type": "Parallel",
      "Branches": [
        {
          "StartAt": "TagAsInvestigating",
          "States": {
            "TagAsInvestigating": {
              "Type": "Task",
              "Resource": "arn:aws:states:::aws-sdk:ec2:createTags",
              "Parameters": {
                "Resources.$": "States.Array($.InstanceId)",
                "Tags": [
                  { "Key": "IncidentStatus", "Value": "Investigating" },
                  { "Key": "IncidentTime.$": "$$.State.EnteredTime" }
                ]
              },
              "End": true
            }
          }
        },
        {
          "StartAt": "GetVolumeId",
          "States": {
            "GetVolumeId": {
              "Type": "Pass",
              "Parameters": {
                "VolumeId.$": "$.InstanceInfo.Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.VolumeId"
              },
              "Next": "CreateForensicSnapshot"
            },
            "CreateForensicSnapshot": {
              "Type": "Task",
              "Resource": "arn:aws:states:::aws-sdk:ec2:createSnapshot",
              "Parameters": {
                "VolumeId.$": "$.VolumeId",
                "Description": "Forensic snapshot - incident response",
                "TagSpecifications": [{
                  "ResourceType": "snapshot",
                  "Tags": [{ "Key": "Purpose", "Value": "ForensicBackup" }]
                }]
              },
              "End": true
            }
          }
        }
      ],
      "ResultPath": "$.ParallelResults",
      "Next": "DetermineSeverity"
    },

    "DetermineSeverity": {
      "Type": "Choice",
      "Choices": [
        {
          "Variable": "$.Severity",
          "StringEquals": "CRITICAL",
          "Next": "NotifyCritical"
        }
      ],
      "Default": "NotifyStandard"
    },

    "NotifyCritical": {
      "Type": "Pass",
      "Result": "CRITICAL incident processed - team notified via PagerDuty",
      "End": true
    },

    "NotifyStandard": {
      "Type": "Pass",
      "Result": "Standard incident processed - logged for review",
      "End": true
    },

    "HandleError": {
      "Type": "Pass",
      "Result": "Error occurred during incident response",
      "End": true
    }
  }
}
DEFINITION
```

### Step 3 — Create and execute the state machine

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

STATE_MACHINE_ARN=$(aws stepfunctions create-state-machine \
  --name incident-response-lab \
  --definition file://incident-response.json \
  --role-arn arn:aws:iam::${ACCOUNT_ID}:role/StepFunctionsLabRole \
  --query 'stateMachineArn' --output text)

echo "State machine: $STATE_MACHINE_ARN"

# Execute it with our lab instance
EXECUTION_ARN=$(aws stepfunctions start-execution \
  --state-machine-arn $STATE_MACHINE_ARN \
  --input "{\"InstanceId\": \"$INSTANCE_ID\", \"Severity\": \"CRITICAL\"}" \
  --query 'executionArn' --output text)

echo "Execution: $EXECUTION_ARN"

# Watch the execution
while true; do
  STATUS=$(aws stepfunctions describe-execution \
    --execution-arn $EXECUTION_ARN \
    --query 'status' --output text)
  echo "$(date +%H:%M:%S) Status: $STATUS"
  if [ "$STATUS" != "RUNNING" ]; then break; fi
  sleep 5
done

# See the execution history
aws stepfunctions get-execution-history \
  --execution-arn $EXECUTION_ARN \
  --query 'events[?type==`TaskStateExited` || type==`ChoiceStateEntered` || type==`ParallelStateExited`].{Type:type,Timestamp:timestamp}'
```

### Step 4 — Verify the results

```bash
# Check the instance was tagged
aws ec2 describe-tags --filters Name=resource-id,Values=$INSTANCE_ID \
  --query 'Tags[?Key==`IncidentStatus`].{Key:Key,Value:Value}'

# Check the forensic snapshot was created
aws ec2 describe-snapshots \
  --filters Name=tag:Purpose,Values=ForensicBackup \
  --query 'Snapshots[0].{Id:SnapshotId,State:State,Description:Description}'
```

Now run it again with `Severity: STANDARD` and observe the Choice state taking the other branch:

```bash
aws stepfunctions start-execution \
  --state-machine-arn $STATE_MACHINE_ARN \
  --input "{\"InstanceId\": \"$INSTANCE_ID\", \"Severity\": \"STANDARD\"}"
```

**What this workflow demonstrates:**
- **Parallel state:** Tag and snapshot happen simultaneously
- **Choice state:** Route based on severity
- **Catch:** Error handling with fallback state
- **SDK integrations:** Direct EC2 API calls without Lambda
- **Context object (`$$`):** Access execution metadata like `$$.State.EnteredTime`

**Exam takeaway:** Step Functions is the answer when the question describes multi-step workflows with error handling, parallel execution, approval gates, or branching logic. Know Standard (long-running, up to 1 year) vs. Express (high-volume, up to 5 minutes) workflows. Know that SDK integrations let you call AWS APIs directly without Lambda.

### 🧹 Checkpoint

You've built a real incident response workflow with parallel execution, branching, and error handling.

---

## Cleanup

```bash
# Delete Step Functions
aws stepfunctions delete-state-machine --state-machine-arn $STATE_MACHINE_ARN
aws iam delete-role-policy --role-name StepFunctionsLabRole --policy-name EC2AndSNS
aws iam delete-role --role-name StepFunctionsLabRole

# Delete forensic snapshots
SNAP_ID=$(aws ec2 describe-snapshots \
  --filters Name=tag:Purpose,Values=ForensicBackup \
  --query 'Snapshots[0].SnapshotId' --output text)
aws ec2 delete-snapshot --snapshot-id $SNAP_ID 2>/dev/null

# Delete AMI created by automation
AMI_ID=$(aws ec2 describe-images --owners self \
  --filters Name=name,Values="*$INSTANCE_ID*" \
  --query 'Images[0].ImageId' --output text)
aws ec2 deregister-image --image-id $AMI_ID 2>/dev/null

# Delete AppConfig
aws appconfig delete-environment --application-id $APP_ID --environment-id $DEV_ENV_ID
aws appconfig delete-environment --application-id $APP_ID --environment-id $PROD_ENV_ID
aws appconfig delete-configuration-profile --application-id $APP_ID --configuration-profile-id $PROFILE_ID
aws appconfig delete-deployment-strategy --deployment-strategy-id $STRATEGY_ID
aws appconfig delete-application --application-id $APP_ID

# Delete Config resources
aws configservice delete-remediation-configuration --config-rule-name s3-encryption-required
aws configservice delete-config-rule --config-rule-name s3-encryption-required
aws configservice stop-configuration-recorder --configuration-recorder-name default
aws configservice delete-delivery-channel --delivery-channel-name default
aws configservice delete-configuration-recorder --configuration-recorder-name default
aws iam delete-role-policy --role-name ConfigRemediationRole --policy-name S3Encryption
aws iam delete-role --role-name ConfigRemediationRole
aws iam delete-role-policy --role-name ConfigServiceRole --policy-name S3Access
aws iam detach-role-policy --role-name ConfigServiceRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWS_ConfigRole
aws iam delete-role --role-name ConfigServiceRole
aws s3 rb s3://config-data-${ACCOUNT_ID} --force
aws s3 rb s3://config-test-noncompliant-${ACCOUNT_ID} --force

# Delete SSM resources
aws ssm delete-association --association-name install-cw-agent 2>/dev/null
aws ssm delete-association --association-name gather-inventory 2>/dev/null
aws ssm delete-document --name Custom-TagAndVerify 2>/dev/null
aws ssm delete-parameter --name /automation/last-tagged-instance 2>/dev/null
aws ssm deregister-patch-baseline-for-patch-group \
  --baseline-id $BASELINE_ID --patch-group dev-servers 2>/dev/null
aws ssm delete-patch-baseline --baseline-id $BASELINE_ID 2>/dev/null

# Delete Session Manager logging
aws logs delete-log-group --log-group-name /ssm/session-logs 2>/dev/null
aws s3 rb s3://ssm-session-logs-${ACCOUNT_ID} --force 2>/dev/null

# Delete EC2 instance
aws ec2 terminate-instances --instance-ids $INSTANCE_ID
aws ec2 wait instance-terminated --instance-ids $INSTANCE_ID
aws iam remove-role-from-instance-profile \
  --instance-profile-name SSMLabProfile --role-name SSMLabRole
aws iam delete-instance-profile --instance-profile-name SSMLabProfile
aws iam detach-role-policy --role-name SSMLabRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam detach-role-policy --role-name SSMLabRole \
  --policy-arn arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy
aws iam delete-role --role-name SSMLabRole

# Delete Organizations resources (if you created them for this lab)
aws organizations detach-policy --policy-id $SCP_ID --target-id $SANDBOX_OU_ID 2>/dev/null
aws organizations delete-policy --policy-id $SCP_ID 2>/dev/null
aws organizations delete-organizational-unit --organizational-unit-id $SANDBOX_OU_ID 2>/dev/null

# Clean up local files
rm -f ssm-trust.json config-trust.json remediation-role-trust.json sfn-trust.json \
  session-prefs.json custom-runbook.yaml incident-response.json \
  region-restrict-scp.json security-guardrails-scp.json deny-public-s3-scp.json \
  feature-flags.json feature-flags-v2.json stackset-admin-role.json
```

---

## Session 4 — Key Exam Takeaways

| Topic | What the Exam Tests |
|---|---|
| **SCPs** | Deny-based guardrails. Don't grant permissions. Management account exempt. Common patterns: Region restriction, prevent disabling security services. |
| **Control Tower** | Landing zone + guardrails (preventive/detective/proactive) + Account Factory. CfCT for custom baselines. |
| **Run Command** | Execute across fleet by tags. `MaxConcurrency` and `MaxErrors` for safe rollouts. No SSH needed. |
| **Session Manager** | SSH replacement. Logged to S3/CloudWatch. IAM-controlled. No open ports. |
| **State Manager** | Maintain desired state on schedule. Ensure agents installed, configs applied. |
| **Patch Manager** | Baseline → patch group (tag) → scan/install via `AWS-RunPatchBaseline`. Maintenance windows for scheduling. |
| **Automation** | Multi-step runbooks. `aws:executeAwsApi` for any AWS API. Triggered by EventBridge, Config, maintenance windows. |
| **Config rules** | Managed or custom (Lambda). Auto-remediation via SSM Automation. Conformance packs for compliance frameworks. |
| **AppConfig** | Feature flags, config deployment. Gradual rollout. Validators. Automatic rollback on alarm. |
| **Step Functions** | Multi-step workflows. Parallel, Choice, Catch states. Standard (long) vs. Express (fast). SDK integrations without Lambda. |

---

**Next:** [Session 5 — Resilient Cloud Solutions](./05-resilient-cloud-solutions.md)
