# Session 9: IAM & Security at Scale — Hands-On (Domain 6 — Security and Compliance, 17%)

> **Task Statement 6.1:** Implement techniques for identity and access management at scale.
>
> In this session you'll create and test IAM policies with conditions, set up permissions boundaries for delegated administration, configure cross-account access via role assumption and resource policies, set up Secrets Manager rotation, and use IAM Access Analyzer to find unintended access.

---

## Prerequisites

- [ ] AWS CLI v2 configured
- [ ] A second AWS account (optional — for cross-account labs)
- [ ] ~$0.50 USD budget

**Estimated time:** 3–4 hours

---

## Lab 1: IAM Policy Evaluation — Understand the Logic

**What you'll learn:** How SCPs, permissions boundaries, identity policies, and resource policies interact.

### Step 1 — Create a test user with limited permissions

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Create a test user
aws iam create-user --user-name iam-lab-developer

# Create a policy that allows S3 and EC2 read
aws iam create-policy --policy-name DevReadPolicy \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": ["s3:GetObject", "s3:ListBucket", "s3:ListAllMyBuckets"],
        "Resource": "*"
      },
      {
        "Effect": "Allow",
        "Action": ["ec2:Describe*"],
        "Resource": "*"
      }
    ]
  }'

aws iam attach-user-policy --user-name iam-lab-developer \
  --policy-arn arn:aws:iam::${ACCOUNT_ID}:policy/DevReadPolicy
```

### Step 2 — Create a permissions boundary

```bash
aws iam create-policy --policy-name DevBoundary \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": ["s3:*", "logs:*", "cloudwatch:*"],
        "Resource": "*"
      },
      {
        "Effect": "Deny",
        "Action": ["s3:DeleteBucket", "s3:PutBucketPolicy"],
        "Resource": "*"
      }
    ]
  }'

# Attach the boundary to the user
aws iam put-user-permissions-boundary --user-name iam-lab-developer \
  --permissions-boundary arn:aws:iam::${ACCOUNT_ID}:policy/DevBoundary
```

### Step 3 — Analyze effective permissions

Now think through what `iam-lab-developer` can actually do:

```
Identity policy allows: s3:GetObject, s3:ListBucket, s3:ListAllMyBuckets, ec2:Describe*
Boundary allows:        s3:*, logs:*, cloudwatch:*
Boundary denies:        s3:DeleteBucket, s3:PutBucketPolicy

Effective permissions (intersection):
  ✅ s3:GetObject       — allowed by both identity policy AND boundary
  ✅ s3:ListBucket      — allowed by both
  ✅ s3:ListAllMyBuckets — allowed by both
  ❌ ec2:Describe*      — allowed by identity policy BUT NOT by boundary → DENIED
  ❌ s3:DeleteBucket    — explicitly denied by boundary → DENIED
  ❌ s3:PutBucketPolicy — explicitly denied by boundary → DENIED
```

**Key insight:** The user has `ec2:Describe*` in their identity policy, but the boundary doesn't include EC2 — so EC2 access is denied. The boundary sets the ceiling.

### Step 4 — Delegated admin pattern with permissions boundaries

This is the most important permissions boundary pattern for the exam:

```bash
# Create a policy that lets developers create roles — but ONLY with the boundary attached
aws iam create-policy --policy-name DelegatedRoleCreation \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "AllowCreateRoleWithBoundary",
        "Effect": "Allow",
        "Action": [
          "iam:CreateRole",
          "iam:AttachRolePolicy",
          "iam:DetachRolePolicy",
          "iam:PutRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:PutRolePermissionsBoundary"
        ],
        "Resource": "arn:aws:iam::'${ACCOUNT_ID}':role/dev-*",
        "Condition": {
          "StringEquals": {
            "iam:PermissionsBoundary": "arn:aws:iam::'${ACCOUNT_ID}':policy/DevBoundary"
          }
        }
      },
      {
        "Sid": "AllowPassRole",
        "Effect": "Allow",
        "Action": "iam:PassRole",
        "Resource": "arn:aws:iam::'${ACCOUNT_ID}':role/dev-*"
      },
      {
        "Sid": "DenyBoundaryRemoval",
        "Effect": "Deny",
        "Action": [
          "iam:DeleteRolePermissionsBoundary",
          "iam:DeleteUserPermissionsBoundary"
        ],
        "Resource": "*"
      }
    ]
  }'
```

**What this achieves:**
- Developers can create roles (prefixed `dev-*`) for their Lambda functions
- Every role they create MUST have the `DevBoundary` attached
- They can't remove the boundary from any role
- The boundary limits what those roles can do — preventing privilege escalation

**Exam takeaway:** Permissions boundaries prevent privilege escalation in delegated admin scenarios. The condition `iam:PermissionsBoundary` ensures developers can't create roles more powerful than intended.

---

## Lab 2: Cross-Account Access

**What you'll learn:** Both patterns for cross-account access — role assumption and resource-based policies.

### Pattern 1: Role Assumption

```bash
# In the TARGET account (Account B), create a role that trusts Account A
# If you only have one account, use your own account ID for both

TARGET_ACCOUNT="222222222222"  # Replace with actual account ID
SOURCE_ACCOUNT=$ACCOUNT_ID

# Create the cross-account role (run in target account)
cat > cross-account-trust.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::${SOURCE_ACCOUNT}:root" },
    "Action": "sts:AssumeRole",
    "Condition": {
      "StringEquals": { "sts:ExternalId": "lab-external-id-12345" }
    }
  }]
}
EOF

aws iam create-role --role-name CrossAccountReadRole \
  --assume-role-policy-document file://cross-account-trust.json

aws iam attach-role-policy --role-name CrossAccountReadRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess

echo "Role created. From Account A, assume it with:"
echo "aws sts assume-role --role-arn arn:aws:iam::${ACCOUNT_ID}:role/CrossAccountReadRole --role-session-name lab-session --external-id lab-external-id-12345"
```

Test the assumption:

```bash
# Assume the role
CREDS=$(aws sts assume-role \
  --role-arn arn:aws:iam::${ACCOUNT_ID}:role/CrossAccountReadRole \
  --role-session-name lab-session \
  --external-id lab-external-id-12345 \
  --query 'Credentials')

echo "Temporary credentials received:"
echo $CREDS | python3 -c "import sys,json; c=json.load(sys.stdin); print(f'AccessKeyId: {c[\"AccessKeyId\"][:10]}...')"
```

**Key points:**
- `ExternalId` prevents the "confused deputy" problem — a third party can't trick you into assuming a role
- The caller gets ONLY the role's permissions (loses their original permissions)
- Temporary credentials expire (default 1 hour, configurable)

### Pattern 2: Resource-Based Policy (S3 example)

```bash
# Create a bucket with a resource policy allowing another account
aws s3 mb s3://iam-lab-cross-account-${ACCOUNT_ID}

aws s3api put-bucket-policy --bucket iam-lab-cross-account-${ACCOUNT_ID} \
  --policy '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::'${ACCOUNT_ID}':root" },
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::iam-lab-cross-account-'${ACCOUNT_ID}'",
        "arn:aws:s3:::iam-lab-cross-account-'${ACCOUNT_ID}'/*"
      ]
    }]
  }'
```

**Key difference from role assumption:** With resource-based policies, the caller retains their original permissions AND gains access to the resource. No role switch needed.

### Pattern 3: Organization-wide access with `aws:PrincipalOrgID`

```bash
# This is the cleanest pattern for org-wide access
# Replace with your actual org ID
cat << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": "*",
    "Action": ["s3:PutObject"],
    "Resource": "arn:aws:s3:::central-logs-bucket/*",
    "Condition": {
      "StringEquals": {
        "aws:PrincipalOrgID": "o-1234567890"
      }
    }
  }]
}
EOF
echo "^ This allows ANY account in the org to write to the bucket — including future accounts"
```

**Exam takeaway:** Role assumption = caller loses original permissions, gets role's permissions. Resource-based policy = caller keeps original permissions + gains resource access. `aws:PrincipalOrgID` = allow all org accounts without listing IDs.

---

## Lab 3: Secrets Manager Rotation

**What you'll learn:** Set up automatic credential rotation.

### Step 1 — Create a secret and enable rotation

```bash
# Create a secret
aws secretsmanager create-secret \
  --name iam-lab/db-credentials \
  --secret-string '{"username":"app_user","password":"InitialPassword123!"}'

# View the secret
aws secretsmanager get-secret-value --secret-id iam-lab/db-credentials \
  --query '{Name:Name,Value:SecretString}'
```

### Step 2 — Understand the rotation lifecycle

Rotation happens in 4 steps (implemented by a Lambda function):

```
1. createSecret  — Generate new credential, store as AWSPENDING
2. setSecret     — Apply the new credential to the target service (e.g., RDS)
3. testSecret    — Verify the new credential works
4. finishSecret  — Mark AWSPENDING as AWSCURRENT, old becomes AWSPREVIOUS
```

For RDS, AWS provides built-in rotation Lambda functions. For custom secrets, you write your own.

```bash
# See the rotation configuration options
echo "
To enable rotation for an RDS secret:

aws secretsmanager rotate-secret \\
  --secret-id iam-lab/db-credentials \\
  --rotation-lambda-arn arn:aws:lambda:REGION:ACCOUNT:function:SecretsManagerRotation \\
  --rotation-rules AutomaticallyAfterDays=30

The rotation Lambda is auto-created when you enable rotation via the console for RDS secrets.
"

# For this lab, let's manually rotate (simulating what the Lambda does)
aws secretsmanager put-secret-value \
  --secret-id iam-lab/db-credentials \
  --secret-string '{"username":"app_user","password":"RotatedPassword456!"}' \
  --version-stages AWSCURRENT

# Check versions
aws secretsmanager list-secret-version-ids --secret-id iam-lab/db-credentials \
  --query 'Versions[*].{VersionId:VersionId,Stages:VersionStages}'
```

**Exam takeaway:** Secrets Manager has built-in rotation for RDS, Redshift, DocumentDB. Custom rotation requires a Lambda function implementing the 4-step lifecycle. Applications should always fetch secrets at runtime (with SDK caching), never hardcode them.

---

## Lab 4: IAM Access Analyzer

**What you'll learn:** Find resources with unintended external access.

### Step 1 — Create an analyzer

```bash
ANALYZER_ARN=$(aws accessanalyzer create-analyzer \
  --analyzer-name iam-lab-analyzer \
  --type ACCOUNT \
  --query 'arn' --output text)

echo "Analyzer: $ANALYZER_ARN"
```

### Step 2 — Check for findings

```bash
# List findings (resources shared externally)
aws accessanalyzer list-findings --analyzer-arn $ANALYZER_ARN \
  --query 'findings[*].{Resource:resource,Type:resourceType,Status:status,Principal:principal}'
```

If you have any S3 buckets with public access, IAM roles with overly broad trust policies, or KMS keys shared cross-account, they'll appear here.

### Step 3 — Validate a policy

```bash
aws accessanalyzer validate-policy \
  --policy-type IDENTITY_POLICY \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": "*",
      "Resource": "*"
    }]
  }' \
  --query 'findings[*].{Type:findingType,Issue:issueCode,Message:findingDetails[0].message}'
```

Access Analyzer will flag this as overly permissive.

### Step 4 — Generate a least-privilege policy (conceptual)

```bash
echo "
Access Analyzer can generate least-privilege policies from CloudTrail activity:

aws accessanalyzer start-policy-generation \\
  --policy-generation-details '{
    \"principalArn\": \"arn:aws:iam::ACCOUNT:role/MyRole\",
    \"cloudTrailDetails\": {
      \"trails\": [{\"cloudTrailArn\": \"arn:aws:cloudtrail:REGION:ACCOUNT:trail/my-trail\", \"allRegions\": true}],
      \"accessRole\": \"arn:aws:iam::ACCOUNT:role/AccessAnalyzerRole\",
      \"startTime\": \"2024-01-01T00:00:00Z\",
      \"endTime\": \"2024-03-01T00:00:00Z\"
    }
  }'

This analyzes 2 months of CloudTrail data and generates a policy with only the permissions actually used.
"
```

**Exam takeaway:** Access Analyzer finds unintended external access (public S3, overly broad roles). Policy validation checks for errors and security issues. Policy generation creates least-privilege policies from actual usage. Unused access analyzer finds stale permissions.

---

## Lab 5: ABAC and Policy Condition Exercises

**What you'll learn:** Use tags for access control decisions.

### Exercise: Write ABAC policies

For each scenario, write the policy condition before revealing the answer.

**Scenario 1:** Allow users to manage only EC2 instances tagged with their department.

<details>
<summary>Reveal answer</summary>

```json
{
  "Effect": "Allow",
  "Action": "ec2:*",
  "Resource": "*",
  "Condition": {
    "StringEquals": {
      "aws:ResourceTag/Department": "${aws:PrincipalTag/Department}"
    }
  }
}
```

</details>

**Scenario 2:** Deny all actions unless the request comes from an approved Region.

<details>
<summary>Reveal answer</summary>

```json
{
  "Effect": "Deny",
  "Action": "*",
  "Resource": "*",
  "Condition": {
    "StringNotEquals": {
      "aws:RequestedRegion": ["us-east-1", "eu-west-1"]
    }
  }
}
```

</details>

**Scenario 3:** Require MFA for all actions except IAM self-service (change own password, manage own MFA).

<details>
<summary>Reveal answer</summary>

```json
{
  "Effect": "Deny",
  "NotAction": ["iam:ChangePassword", "iam:CreateVirtualMFADevice", "iam:EnableMFADevice"],
  "Resource": "*",
  "Condition": {
    "BoolIfExists": { "aws:MultiFactorAuthPresent": "false" }
  }
}
```

</details>

**Scenario 4:** Allow S3 access only over HTTPS.

<details>
<summary>Reveal answer</summary>

```json
{
  "Effect": "Deny",
  "Action": "s3:*",
  "Resource": "*",
  "Condition": {
    "Bool": { "aws:SecureTransport": "false" }
  }
}
```

</details>

---

## Cleanup

```bash
aws accessanalyzer delete-analyzer --analyzer-name iam-lab-analyzer
aws secretsmanager delete-secret --secret-id iam-lab/db-credentials --force-delete-without-recovery
aws s3 rb s3://iam-lab-cross-account-${ACCOUNT_ID} --force
aws iam delete-role --role-name CrossAccountReadRole 2>/dev/null
aws iam detach-role-policy --role-name CrossAccountReadRole --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess 2>/dev/null
aws iam delete-role --role-name CrossAccountReadRole 2>/dev/null
aws iam detach-user-policy --user-name iam-lab-developer --policy-arn arn:aws:iam::${ACCOUNT_ID}:policy/DevReadPolicy
aws iam delete-user-permissions-boundary --user-name iam-lab-developer
aws iam delete-user --user-name iam-lab-developer
aws iam delete-policy --policy-arn arn:aws:iam::${ACCOUNT_ID}:policy/DevReadPolicy
aws iam delete-policy --policy-arn arn:aws:iam::${ACCOUNT_ID}:policy/DevBoundary
aws iam delete-policy --policy-arn arn:aws:iam::${ACCOUNT_ID}:policy/DelegatedRoleCreation
rm -f cross-account-trust.json
```

---

## Session 9 — Key Exam Takeaways

| Topic | What the Exam Tests |
|---|---|
| **Policy evaluation** | Effective permissions = intersection of SCPs + boundary + identity policy + resource policy. Explicit Deny always wins. |
| **Permissions boundaries** | Maximum permissions for an entity. Delegated admin pattern: require boundary on created roles. Prevents privilege escalation. |
| **Cross-account (role)** | Caller loses original permissions, gets role's permissions. ExternalId prevents confused deputy. |
| **Cross-account (resource policy)** | Caller keeps original permissions + gains resource access. No role switch. |
| **`aws:PrincipalOrgID`** | Allow all org accounts in resource policies. Includes future accounts. |
| **Identity Center** | Preferred for human access. Permission sets → IAM roles in each account. |
| **Secrets Manager** | Built-in rotation for RDS. 4-step lifecycle. Applications fetch at runtime. |
| **Parameter Store** | No built-in rotation. Use for config values and non-rotating secrets. Cheaper. |
| **ABAC** | Tag-based access control. `aws:PrincipalTag` vs. `aws:ResourceTag`. Scales better than RBAC. |
| **Access Analyzer** | Find external access. Validate policies. Generate least-privilege from CloudTrail. |
| **MFA enforcement** | `aws:MultiFactorAuthPresent` condition. Can require in role trust policies. |

---

**Next:** [Session 10 — Data Protection & Security Auditing](./10-data-protection-auditing.md)
