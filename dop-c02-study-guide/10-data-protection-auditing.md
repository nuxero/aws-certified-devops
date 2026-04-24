# Session 10: Data Protection & Security Auditing — Hands-On (Domain 6)

> **Task Statements 6.2, 6.3**
>
> In this session you'll create and manage KMS keys with cross-account access, set up WAF rules on an ALB, enable GuardDuty and build an automated response, configure Security Hub for centralized findings, and set up CloudTrail with log integrity validation.

---

## Prerequisites

- [ ] AWS CLI v2 configured
- [ ] ~$1–2 USD budget

**Estimated time:** 3–4 hours

---

## Lab 1: KMS — Key Management and Encryption

**What you'll learn:** Create customer-managed keys, key policies, key rotation, and cross-account access.

### Step 1 — Create a customer-managed KMS key

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region)

KEY_ID=$(aws kms create-key \
  --description "Security lab encryption key" \
  --key-usage ENCRYPT_DECRYPT \
  --origin AWS_KMS \
  --query 'KeyMetadata.KeyId' --output text)

aws kms create-alias --alias-name alias/security-lab-key --target-key-id $KEY_ID
echo "Key: $KEY_ID"
```

### Step 2 — Encrypt and decrypt data

```bash
# Encrypt a plaintext string
CIPHERTEXT=$(aws kms encrypt \
  --key-id alias/security-lab-key \
  --plaintext "This is sensitive data" \
  --query 'CiphertextBlob' --output text)

echo "Ciphertext: ${CIPHERTEXT:0:40}..."

# Decrypt it
aws kms decrypt \
  --ciphertext-blob fileb://<(echo $CIPHERTEXT | base64 --decode) \
  --query 'Plaintext' --output text | base64 --decode
```

### Step 3 — Enable key rotation

```bash
aws kms enable-key-rotation --key-id $KEY_ID

aws kms get-key-rotation-status --key-id $KEY_ID
# Should show: KeyRotationEnabled: true
```

**Key rotation facts:**
- Rotates annually (creates new key material)
- Key ID stays the same — no application changes needed
- Old key material is retained for decrypting old data
- AWS-managed keys rotate automatically (you can't disable it)

### Step 4 — Understand the key policy

```bash
aws kms get-key-policy --key-id $KEY_ID --policy-name default \
  --query 'Policy' --output text | python3 -m json.tool
```

The default key policy gives the account root full access. For cross-account access, you'd add:

```json
{
  "Sid": "AllowCrossAccountDecrypt",
  "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::222222222222:root" },
  "Action": ["kms:Decrypt", "kms:DescribeKey"],
  "Resource": "*"
}
```

**Exam takeaway:** KMS key policies are required — IAM policies alone aren't sufficient for KMS access. Cross-account KMS access needs BOTH a key policy entry AND an IAM policy in the other account. Key rotation keeps the same key ID. Multi-Region keys share key material across Regions.

### Step 5 — Encrypt an S3 bucket with the key

```bash
aws s3 mb s3://security-lab-encrypted-${ACCOUNT_ID}

aws s3api put-bucket-encryption \
  --bucket security-lab-encrypted-${ACCOUNT_ID} \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "aws:kms",
        "KMSMasterKeyID": "'$KEY_ID'"
      },
      "BucketKeyEnabled": true
    }]
  }'

# BucketKeyEnabled reduces KMS API calls (and cost) for S3 encryption
echo "Bucket encrypted with customer-managed KMS key + S3 Bucket Key"
```

---

## Lab 2: WAF — Protect a Web Application

**What you'll learn:** Create a WAF Web ACL with IP blocking, rate limiting, and managed rules.

### Step 1 — Create a WAF IP set and Web ACL

```bash
# Create an IP set to block specific IPs
IP_SET_ID=$(aws wafv2 create-ip-set \
  --name security-lab-blocked-ips \
  --scope REGIONAL \
  --ip-address-version IPV4 \
  --addresses "198.51.100.0/24" "203.0.113.0/24" \
  --query 'Summary.Id' --output text)

IP_SET_ARN=$(aws wafv2 create-ip-set \
  --name security-lab-blocked-ips \
  --scope REGIONAL \
  --ip-address-version IPV4 \
  --addresses "198.51.100.0/24" "203.0.113.0/24" \
  --query 'Summary.ARN' --output text 2>/dev/null)

# Get the ARN
IP_SET_ARN="arn:aws:wafv2:${REGION}:${ACCOUNT_ID}:regional/ipset/security-lab-blocked-ips/${IP_SET_ID}"
```

### Step 2 — Create the Web ACL with multiple rule types

```bash
aws wafv2 create-web-acl \
  --name security-lab-waf \
  --scope REGIONAL \
  --default-action '{"Allow":{}}' \
  --visibility-config SampledRequestsEnabled=true,CloudWatchMetricsEnabled=true,MetricName=SecurityLabWAF \
  --rules '[
    {
      "Name": "BlockBadIPs",
      "Priority": 1,
      "Statement": {
        "IPSetReferenceStatement": { "ARN": "'$IP_SET_ARN'" }
      },
      "Action": { "Block": {} },
      "VisibilityConfig": { "SampledRequestsEnabled": true, "CloudWatchMetricsEnabled": true, "MetricName": "BlockBadIPs" }
    },
    {
      "Name": "RateLimit",
      "Priority": 2,
      "Statement": {
        "RateBasedStatement": {
          "Limit": 1000,
          "AggregateKeyType": "IP"
        }
      },
      "Action": { "Block": {} },
      "VisibilityConfig": { "SampledRequestsEnabled": true, "CloudWatchMetricsEnabled": true, "MetricName": "RateLimit" }
    },
    {
      "Name": "AWSManagedRulesCommon",
      "Priority": 3,
      "Statement": {
        "ManagedRuleGroupStatement": {
          "VendorName": "AWS",
          "Name": "AWSManagedRulesCommonRuleSet"
        }
      },
      "OverrideAction": { "None": {} },
      "VisibilityConfig": { "SampledRequestsEnabled": true, "CloudWatchMetricsEnabled": true, "MetricName": "CommonRules" }
    },
    {
      "Name": "AWSManagedRulesSQLi",
      "Priority": 4,
      "Statement": {
        "ManagedRuleGroupStatement": {
          "VendorName": "AWS",
          "Name": "AWSManagedRulesSQLiRuleSet"
        }
      },
      "OverrideAction": { "None": {} },
      "VisibilityConfig": { "SampledRequestsEnabled": true, "CloudWatchMetricsEnabled": true, "MetricName": "SQLiRules" }
    }
  ]'
```

**What each rule does:**
1. **BlockBadIPs** — Block requests from known bad IP ranges
2. **RateLimit** — Block IPs sending more than 1000 requests per 5 minutes (DDoS/brute force protection)
3. **AWSManagedRulesCommon** — OWASP Top 10 protections (XSS, bad bots, etc.)
4. **AWSManagedRulesSQLi** — SQL injection protection

**Note:** Managed rule groups use `OverrideAction` (not `Action`) because the rules inside the group have their own actions.

**Exam takeaway:** WAF protects against L7 attacks (SQLi, XSS, bad bots). Shield protects against L3/L4 DDoS. Rate-based rules for brute force. Managed rule groups for OWASP Top 10. WAF can be attached to CloudFront (global), ALB, API Gateway, or AppSync (regional). Firewall Manager deploys WAF rules across all accounts.

---

## Lab 3: GuardDuty — Threat Detection and Automated Response

**What you'll learn:** Enable GuardDuty, generate sample findings, and build an automated response.

### Step 1 — Enable GuardDuty

```bash
DETECTOR_ID=$(aws guardduty create-detector --enable \
  --finding-publishing-frequency FIFTEEN_MINUTES \
  --query 'DetectorId' --output text)

echo "GuardDuty detector: $DETECTOR_ID"
```

### Step 2 — Generate sample findings

```bash
aws guardduty create-sample-findings \
  --detector-id $DETECTOR_ID \
  --finding-types \
    "UnauthorizedAccess:EC2/MaliciousIPCaller.Custom" \
    "Recon:EC2/PortProbeUnprotectedPort" \
    "CryptoCurrency:EC2/BitcoinTool.B!DNS"

sleep 10

# List the findings
aws guardduty list-findings --detector-id $DETECTOR_ID \
  --query 'FindingIds[0:3]' --output text | while read FINDING_ID; do
  aws guardduty get-findings --detector-id $DETECTOR_ID \
    --finding-ids $FINDING_ID \
    --query 'Findings[0].{Type:Type,Severity:Severity,Title:Title}'
done
```

### Step 3 — Build an automated response

Create an EventBridge rule that triggers on high-severity GuardDuty findings:

```bash
# Create a Lambda for automated response
cat > guardduty_response.py << 'EOF'
import json
import boto3

ec2 = boto3.client('ec2')

# Isolation security group — no inbound, no outbound
ISOLATION_SG_NAME = 'guardduty-isolation'

def handler(event, context):
    detail = event.get('detail', {})
    finding_type = detail.get('type', '')
    severity = detail.get('severity', 0)

    print(f"Finding: {finding_type}, Severity: {severity}")

    # Only act on high severity findings for EC2
    if severity < 7:
        return {'action': 'skipped', 'reason': 'Low severity'}

    resource = detail.get('resource', {})
    instance_details = resource.get('instanceDetails', {})
    instance_id = instance_details.get('instanceId', '')

    if not instance_id:
        return {'action': 'skipped', 'reason': 'No instance ID'}

    print(f"Isolating instance: {instance_id}")

    # Tag the instance
    ec2.create_tags(Resources=[instance_id], Tags=[
        {'Key': 'GuardDutyFinding', 'Value': finding_type},
        {'Key': 'SecurityStatus', 'Value': 'Investigating'}
    ])

    return {'action': 'tagged', 'instance': instance_id, 'finding': finding_type}
EOF

zip guardduty_response.zip guardduty_response.py

aws iam create-role --role-name GuardDutyResponseRole \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name GuardDutyResponseRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam put-role-policy --role-name GuardDutyResponseRole --policy-name EC2Access \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["ec2:CreateTags","ec2:ModifyInstanceAttribute","ec2:DescribeSecurityGroups"],"Resource":"*"}]}'
sleep 10

aws lambda create-function --function-name guardduty-auto-response \
  --runtime python3.12 --handler guardduty_response.handler \
  --role arn:aws:iam::${ACCOUNT_ID}:role/GuardDutyResponseRole \
  --zip-file fileb://guardduty_response.zip --timeout 30

# Create EventBridge rule for high-severity findings
aws events put-rule --name guardduty-high-severity \
  --event-pattern '{
    "source": ["aws.guardduty"],
    "detail-type": ["GuardDuty Finding"],
    "detail": { "severity": [{ "numeric": [">=", 7] }] }
  }'

aws lambda add-permission --function-name guardduty-auto-response \
  --statement-id eventbridge --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/guardduty-high-severity

aws events put-targets --rule guardduty-high-severity \
  --targets "Id=respond,Arn=arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:guardduty-auto-response"

echo "Automated response configured for high-severity GuardDuty findings"
```

**The full pattern:**
```
Threat detected (compromised instance, crypto mining, port scan)
  → GuardDuty generates finding
    → EventBridge matches high-severity findings
      → Lambda tags instance, isolates it (swap SG), notifies team
```

**Exam takeaway:** GuardDuty detects threats. Inspector finds vulnerabilities. Macie discovers sensitive data. Security Hub aggregates all findings. Detective investigates findings. Know the automated response pattern: GuardDuty → EventBridge → Lambda.

---

## Lab 4: CloudTrail — Auditing and Integrity

**What you'll learn:** Create a trail with log integrity validation and KMS encryption.

### Step 1 — Create an encrypted trail

```bash
aws s3 mb s3://security-lab-trail-${ACCOUNT_ID}

# Bucket policy for CloudTrail
aws s3api put-bucket-policy --bucket security-lab-trail-${ACCOUNT_ID} \
  --policy '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "AWSCloudTrailAclCheck",
        "Effect": "Allow",
        "Principal": { "Service": "cloudtrail.amazonaws.com" },
        "Action": "s3:GetBucketAcl",
        "Resource": "arn:aws:s3:::security-lab-trail-'${ACCOUNT_ID}'"
      },
      {
        "Sid": "AWSCloudTrailWrite",
        "Effect": "Allow",
        "Principal": { "Service": "cloudtrail.amazonaws.com" },
        "Action": "s3:PutObject",
        "Resource": "arn:aws:s3:::security-lab-trail-'${ACCOUNT_ID}'/AWSLogs/*",
        "Condition": { "StringEquals": { "s3:x-amz-acl": "bucket-owner-full-control" } }
      }
    ]
  }'

# Create the trail with integrity validation and KMS encryption
aws cloudtrail create-trail \
  --name security-lab-trail \
  --s3-bucket-name security-lab-trail-${ACCOUNT_ID} \
  --is-multi-region-trail \
  --enable-log-file-validation \
  --kms-key-id alias/security-lab-key

aws cloudtrail start-logging --name security-lab-trail
echo "Trail created with log integrity validation and KMS encryption"
```

### Step 2 — Verify log integrity

```bash
# After a few minutes, validate the digest files
aws cloudtrail validate-logs \
  --trail-arn arn:aws:cloudtrail:${REGION}:${ACCOUNT_ID}:trail/security-lab-trail \
  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ)
```

If anyone tampers with the log files in S3, the validation will detect it (SHA-256 hash chain).

**Exam takeaway:** CloudTrail log file validation uses SHA-256 digest files to detect tampering. Organization trails cover all accounts. Management events are logged by default; data events (S3 GetObject, Lambda Invoke) are opt-in and cost extra. CloudTrail Lake provides SQL-based querying with up to 7 years retention.

---

## Lab 5: Security Service Decision Exercise

For each scenario, identify the correct AWS security service.

| Scenario | Your Answer | Correct Service |
|---|---|---|
| "Detect if an EC2 instance is communicating with a known malicious IP" | ___ | GuardDuty |
| "Find S3 buckets containing credit card numbers" | ___ | Macie |
| "Check if all EBS volumes are encrypted" | ___ | AWS Config |
| "Scan ECR container images for OS vulnerabilities" | ___ | Inspector |
| "Aggregate security findings from GuardDuty, Inspector, and Macie" | ___ | Security Hub |
| "Investigate the blast radius of a compromised IAM credential" | ___ | Detective |
| "Find S3 buckets with public access across all accounts" | ___ | IAM Access Analyzer |
| "Block SQL injection attacks on an ALB" | ___ | WAF |
| "Protect against volumetric DDoS attacks" | ___ | Shield |
| "Enforce WAF rules across all ALBs in all accounts" | ___ | Firewall Manager |

---

## Cleanup

```bash
# Delete CloudTrail
aws cloudtrail stop-logging --name security-lab-trail
aws cloudtrail delete-trail --name security-lab-trail
aws s3 rb s3://security-lab-trail-${ACCOUNT_ID} --force

# Delete GuardDuty
aws events remove-targets --rule guardduty-high-severity --ids respond
aws events delete-rule --name guardduty-high-severity
aws lambda delete-function --function-name guardduty-auto-response
aws iam delete-role-policy --role-name GuardDutyResponseRole --policy-name EC2Access
aws iam detach-role-policy --role-name GuardDutyResponseRole --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name GuardDutyResponseRole
aws guardduty delete-detector --detector-id $DETECTOR_ID

# Delete WAF
WAF_ACL_ID=$(aws wafv2 list-web-acls --scope REGIONAL \
  --query 'WebACLs[?Name==`security-lab-waf`].Id' --output text)
WAF_LOCK=$(aws wafv2 list-web-acls --scope REGIONAL \
  --query 'WebACLs[?Name==`security-lab-waf`].LockToken' --output text)
aws wafv2 delete-web-acl --name security-lab-waf --scope REGIONAL \
  --id $WAF_ACL_ID --lock-token $WAF_LOCK 2>/dev/null

IP_SET_LOCK=$(aws wafv2 list-ip-sets --scope REGIONAL \
  --query 'IPSets[?Name==`security-lab-blocked-ips`].LockToken' --output text)
aws wafv2 delete-ip-set --name security-lab-blocked-ips --scope REGIONAL \
  --id $IP_SET_ID --lock-token $IP_SET_LOCK 2>/dev/null

# Delete KMS and S3
aws s3 rb s3://security-lab-encrypted-${ACCOUNT_ID} --force
aws kms disable-key --key-id $KEY_ID
aws kms schedule-key-deletion --key-id $KEY_ID --pending-window-in-days 7

rm -f guardduty_response.py guardduty_response.zip
```

---

## Session 10 — Key Exam Takeaways

| Topic | What the Exam Tests |
|---|---|
| **KMS** | Key policies required (IAM alone not enough). Cross-account = key policy + IAM policy. Rotation keeps same key ID. Multi-Region keys for cross-Region encryption. S3 Bucket Key reduces cost. |
| **WAF** | L7 protection (SQLi, XSS). Rate-based rules for brute force. Managed rule groups. Attach to CloudFront/ALB/API GW. |
| **Shield** | Standard (free, L3/L4). Advanced ($3K/mo, DDoS Response Team, cost protection). |
| **GuardDuty** | Threat detection. Data sources: CloudTrail, Flow Logs, DNS. Auto-response via EventBridge → Lambda. |
| **Inspector** | Vulnerability scanning. EC2, ECR images, Lambda. Continuous scanning. |
| **Macie** | Sensitive data discovery in S3. PII, financial data, credentials. |
| **Security Hub** | Aggregates findings. Compliance standards (CIS, PCI). Custom actions → EventBridge. |
| **Detective** | Investigate findings. Graph model of resource interactions. |
| **CloudTrail** | API audit log. Log integrity validation (SHA-256). Organization trail. Management vs. data events. |
| **ACM** | Free public TLS certs. Auto-renewal. Private CA for internal/mTLS ($400/mo). |
| **Firewall Manager** | Centralized WAF/Shield/SG/Network Firewall policies across accounts. |
| **Defense in depth** | Layer controls: edge (WAF+Shield) → network (SG+NACL) → compute (Inspector+SSM) → data (KMS+Macie) → monitoring (GuardDuty+Config). |

---

## Congratulations! 🎯

You've completed all 10 hands-on sessions. Here's your next steps:

1. Take a practice exam to find your weak spots
2. Re-do the labs for any domains where you scored below 70%
3. Take 2–3 more practice exams until you consistently score 80%+
4. Schedule your exam

The hands-on experience from these labs gives you a significant advantage — the exam tests practical knowledge, not just memorization.

---

**Back to:** [Overview & Study Plan](./00-overview.md)
