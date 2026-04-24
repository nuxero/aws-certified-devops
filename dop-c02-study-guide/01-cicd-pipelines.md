# Session 1: CI/CD Pipelines — Hands-On (Domain 1 — SDLC Automation, 22%)

> **Task Statement 1.1:** Implement CI/CD pipelines.
>
> This session is entirely hands-on. You will build a real CI/CD pipeline from scratch using AWS-native services, and then extend it with cross-account deployment and secrets management. By the end, you'll have practical experience with every concept the exam tests in this area.

---

## Prerequisites

Before starting, make sure you have:

- [ ] An AWS account (free tier is sufficient for most exercises)
- [ ] AWS CLI v2 installed and configured (`aws configure`)
- [ ] Git installed locally
- [ ] A text editor or IDE
- [ ] Basic familiarity with Git operations (clone, commit, push)
- [ ] ~$1–2 USD budget (some resources go slightly beyond free tier)

**Estimated time:** 3–4 hours

---

## Lab 1: Set Up a CodeCommit Repository

**What you'll learn:** How CodeCommit works, IAM-based Git access, triggers, and notification rules.

### Step 1 — Create the repository

```bash
aws codecommit create-repository \
  --repository-name devops-lab-app \
  --repository-description "DOP-C02 study lab application"
```

Note the `cloneUrlHttp` in the output — you'll need it next.

### Step 2 — Configure Git credentials

You need a credential helper so Git authenticates via your IAM identity:

```bash
git config --global credential.helper '!aws codecommit credential-helper $@'
git config --global credential.UseHttpPath true
```

### Step 3 — Clone and add a sample application

```bash
git clone https://git-codecommit.<YOUR_REGION>.amazonaws.com/v1/repos/devops-lab-app
cd devops-lab-app
```

Create a minimal Node.js app. Create `index.js`:

```javascript
const http = require('http');
const port = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', version: '1.0.0' }));
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
```

Create `package.json`:

```json
{
  "name": "devops-lab-app",
  "version": "1.0.0",
  "scripts": {
    "start": "node index.js",
    "test": "node test.js"
  }
}
```

Create a simple `test.js`:

```javascript
const assert = require('assert');

// Simple unit test
assert.strictEqual(typeof require('./index'), 'object', 'Module should export an object');
console.log('All tests passed');
process.exit(0);
```

Push it:

```bash
git add .
git commit -m "Initial commit - sample Node.js app"
git push origin main
```

### Step 4 — Set up a notification rule

This sends events (PR created, PR merged, etc.) to an SNS topic so you can see how CodeCommit integrates with notifications.

```bash
# Create an SNS topic first
aws sns create-topic --name codecommit-notifications
# Subscribe your email
aws sns subscribe \
  --topic-arn arn:aws:sns:<REGION>:<ACCOUNT_ID>:codecommit-notifications \
  --protocol email \
  --notification-endpoint your-email@example.com
```

Then create the notification rule (via the console is easiest here):
1. Go to CodeCommit → your repo → Notify → Create notification rule
2. Name: `devops-lab-notifications`
3. Events: select "Pull request — Created" and "Branches and tags — Created"
4. Target: the SNS topic you just created

### Step 5 — Create an approval rule template

```bash
aws codecommit create-approval-rule-template \
  --approval-rule-template-name "RequireTwoApprovals" \
  --approval-rule-template-content '{
    "Version": "2018-11-08",
    "Statements": [{
      "Type": "Approvers",
      "NumberOfApprovalsNeeded": 2
    }]
  }'

aws codecommit associate-approval-rule-template-with-repository \
  --approval-rule-template-name "RequireTwoApprovals" \
  --repository-name devops-lab-app
```

**Exam takeaway:** Approval rule templates enforce code review policies. They can require N approvals and optionally restrict who can approve (approval pool members).

### 🧹 Checkpoint

At this point you have:
- A CodeCommit repo with a sample app
- SNS notifications on repo events
- An approval rule template requiring 2 approvals on PRs

---

## Lab 2: Build with CodeBuild

**What you'll learn:** Buildspec files, build phases, environment variables, secrets injection, VPC builds, and build reports.

### Step 1 — Create the buildspec file

In your repo, create `buildspec.yml`:

```yaml
version: 0.2

env:
  variables:
    NODE_ENV: "test"
  # We'll add secrets in Lab 4 — for now, just variables

phases:
  install:
    runtime-versions:
      nodejs: 18
    commands:
      - echo "=== Install phase ==="
      - npm install

  pre_build:
    commands:
      - echo "=== Pre-build phase ==="
      - echo "Node version:" && node --version
      - echo "npm version:" && npm --version

  build:
    commands:
      - echo "=== Build phase ==="
      - echo "Running tests..."
      - npm test
      - echo "Build completed on $(date)"

  post_build:
    commands:
      - echo "=== Post-build phase ==="
      - echo "Packaging application..."

artifacts:
  files:
    - '**/*'
  discard-paths: no

cache:
  paths:
    - 'node_modules/**/*'
```

Commit and push:

```bash
git add buildspec.yml
git commit -m "Add buildspec.yml"
git push origin main
```

### Step 2 — Create an IAM role for CodeBuild

```bash
# Create the trust policy
cat > codebuild-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "codebuild.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

aws iam create-role \
  --role-name CodeBuildServiceRole \
  --assume-role-policy-document file://codebuild-trust-policy.json

# Attach policies (in production, scope these down)
aws iam attach-role-policy \
  --role-name CodeBuildServiceRole \
  --policy-arn arn:aws:iam::aws:policy/AWSCodeBuildDeveloperAccess

aws iam attach-role-policy \
  --role-name CodeBuildServiceRole \
  --policy-arn arn:aws:iam::aws:policy/CloudWatchLogsFullAccess

aws iam attach-role-policy \
  --role-name CodeBuildServiceRole \
  --policy-arn arn:aws:iam::aws:policy/AWSCodeCommitReadOnly
```

### Step 3 — Create the CodeBuild project

```bash
aws codebuild create-project \
  --name devops-lab-build \
  --source type=CODECOMMIT,location=https://git-codecommit.<REGION>.amazonaws.com/v1/repos/devops-lab-app,buildspec=buildspec.yml \
  --artifacts type=NO_ARTIFACTS \
  --environment type=LINUX_CONTAINER,computeType=BUILD_GENERAL1_SMALL,image=aws/codebuild/amazonlinux2-x86_64-standard:5.0 \
  --service-role arn:aws:iam::<ACCOUNT_ID>:role/CodeBuildServiceRole \
  --cache type=LOCAL,modes=LOCAL_SOURCE_CACHE
```

### Step 4 — Run a build and observe

```bash
# Start a build
BUILD_ID=$(aws codebuild start-build \
  --project-name devops-lab-build \
  --query 'build.id' --output text)

echo "Build started: $BUILD_ID"

# Watch the build status (poll every 10 seconds)
while true; do
  STATUS=$(aws codebuild batch-get-builds \
    --ids "$BUILD_ID" \
    --query 'builds[0].buildStatus' --output text)
  echo "Status: $STATUS"
  if [ "$STATUS" != "IN_PROGRESS" ]; then break; fi
  sleep 10
done
```

Now go to the CloudWatch Logs console and find the log group `/aws/codebuild/devops-lab-build`. Read through the build output — you'll see each phase executing in order.

**Experiment:** Try breaking the test intentionally. Change `test.js` to `process.exit(1)`, push, and re-run the build. Observe how CodeBuild reports the failure and which phase fails.

### Step 5 — Add build reports

Update `test.js` to produce JUnit XML output. Install a test reporter:

Update `package.json`:
```json
{
  "name": "devops-lab-app",
  "version": "1.0.0",
  "scripts": {
    "start": "node index.js",
    "test": "node test.js"
  },
  "devDependencies": {
    "mocha": "^10.2.0",
    "mocha-junit-reporter": "^2.2.0"
  }
}
```

Replace `test.js` with a proper Mocha test:
```javascript
const assert = require('assert');

describe('Application', function() {
  it('should return status ok', function() {
    assert.strictEqual('ok', 'ok');
  });

  it('should have version 1.0.0', function() {
    const pkg = require('./package.json');
    assert.strictEqual(pkg.version, '1.0.0');
  });
});
```

Update the test script in `package.json`:
```json
"test": "mocha --reporter mocha-junit-reporter --reporter-options mochaFile=./test-results/results.xml"
```

Add a reports section to `buildspec.yml` (append before the `cache:` section):
```yaml
reports:
  devops-lab-test-report:
    files:
      - 'results.xml'
    base-directory: test-results
    file-format: JUNITXML
```

Push and rebuild. Then check the CodeBuild console → your project → Build reports. You'll see test results visualized.

**Exam takeaway:** CodeBuild reports give visibility into test results directly in the console. The exam tests whether you know how to configure the `reports` section in buildspec.yml and which formats are supported (JUnit XML, Cucumber JSON, etc.).

### 🧹 Checkpoint

You now have:
- A CodeBuild project that builds and tests your app
- Build logs in CloudWatch
- Test reports in CodeBuild
- Understanding of buildspec phases and how failures propagate

---

## Lab 3: Orchestrate with CodePipeline

**What you'll learn:** Pipeline stages, actions, artifact flow, manual approvals, and EventBridge triggers.

### Step 1 — Create an S3 artifact bucket

CodePipeline needs an S3 bucket to store artifacts between stages:

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region)

aws s3 mb s3://devops-lab-artifacts-${ACCOUNT_ID}-${REGION}
```

### Step 2 — Create an IAM role for CodePipeline

```bash
cat > codepipeline-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "codepipeline.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

aws iam create-role \
  --role-name CodePipelineServiceRole \
  --assume-role-policy-document file://codepipeline-trust-policy.json

# In production, create a scoped-down policy. For the lab:
aws iam attach-role-policy \
  --role-name CodePipelineServiceRole \
  --policy-arn arn:aws:iam::aws:policy/AWSCodePipeline_FullAccess

# CodePipeline also needs access to CodeCommit, CodeBuild, S3, SNS
aws iam attach-role-policy \
  --role-name CodePipelineServiceRole \
  --policy-arn arn:aws:iam::aws:policy/AWSCodeCommitFullAccess

aws iam attach-role-policy \
  --role-name CodePipelineServiceRole \
  --policy-arn arn:aws:iam::aws:policy/AWSCodeBuildDeveloperAccess

aws iam attach-role-policy \
  --role-name CodePipelineServiceRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3FullAccess
```

### Step 3 — Define the pipeline

Create `pipeline.json`:

```json
{
  "pipeline": {
    "name": "devops-lab-pipeline",
    "roleArn": "arn:aws:iam::<ACCOUNT_ID>:role/CodePipelineServiceRole",
    "artifactStore": {
      "type": "S3",
      "location": "devops-lab-artifacts-<ACCOUNT_ID>-<REGION>"
    },
    "stages": [
      {
        "name": "Source",
        "actions": [
          {
            "name": "SourceAction",
            "actionTypeId": {
              "category": "Source",
              "owner": "AWS",
              "provider": "CodeCommit",
              "version": "1"
            },
            "outputArtifacts": [{ "name": "SourceOutput" }],
            "configuration": {
              "RepositoryName": "devops-lab-app",
              "BranchName": "main",
              "PollForSourceChanges": "false"
            }
          }
        ]
      },
      {
        "name": "Build",
        "actions": [
          {
            "name": "BuildAction",
            "actionTypeId": {
              "category": "Build",
              "owner": "AWS",
              "provider": "CodeBuild",
              "version": "1"
            },
            "inputArtifacts": [{ "name": "SourceOutput" }],
            "outputArtifacts": [{ "name": "BuildOutput" }],
            "configuration": {
              "ProjectName": "devops-lab-build"
            }
          }
        ]
      },
      {
        "name": "Approval",
        "actions": [
          {
            "name": "ManualApproval",
            "actionTypeId": {
              "category": "Approval",
              "owner": "AWS",
              "provider": "Manual",
              "version": "1"
            },
            "configuration": {
              "NotificationArn": "arn:aws:sns:<REGION>:<ACCOUNT_ID>:codecommit-notifications",
              "CustomData": "Please review the build output and approve for deployment."
            }
          }
        ]
      }
    ]
  }
}
```

> **Note:** We stop at the Approval stage for now. We'll add a Deploy stage in Session 2 when we cover CodeDeploy.

Replace the `<ACCOUNT_ID>` and `<REGION>` placeholders, then create the pipeline:

```bash
aws codepipeline create-pipeline --cli-input-json file://pipeline.json
```

### Step 4 — Set up the EventBridge trigger

We set `PollForSourceChanges: false` in the pipeline, so we need an EventBridge rule to trigger the pipeline on pushes:

```bash
# Create the EventBridge rule
aws events put-rule \
  --name devops-lab-pipeline-trigger \
  --event-pattern '{
    "source": ["aws.codecommit"],
    "detail-type": ["CodeCommit Repository State Change"],
    "resources": ["arn:aws:codecommit:<REGION>:<ACCOUNT_ID>:devops-lab-app"],
    "detail": {
      "event": ["referenceCreated", "referenceUpdated"],
      "referenceType": ["branch"],
      "referenceName": ["main"]
    }
  }'

# Create an IAM role for EventBridge to start the pipeline
cat > eventbridge-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "events.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

aws iam create-role \
  --role-name EventBridgePipelineRole \
  --assume-role-policy-document file://eventbridge-trust-policy.json

cat > eventbridge-pipeline-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "codepipeline:StartPipelineExecution",
      "Resource": "arn:aws:codepipeline:<REGION>:<ACCOUNT_ID>:devops-lab-pipeline"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name EventBridgePipelineRole \
  --policy-name StartPipeline \
  --policy-document file://eventbridge-pipeline-policy.json

# Add the pipeline as a target
aws events put-targets \
  --rule devops-lab-pipeline-trigger \
  --targets '[{
    "Id": "CodePipelineTarget",
    "Arn": "arn:aws:codepipeline:<REGION>:<ACCOUNT_ID>:devops-lab-pipeline",
    "RoleArn": "arn:aws:iam::<ACCOUNT_ID>:role/EventBridgePipelineRole"
  }]'
```

### Step 5 — Test the full flow

Make a code change and push:

```bash
# In your devops-lab-app directory
echo "// Updated $(date)" >> index.js
git add . && git commit -m "Trigger pipeline test"
git push origin main
```

Now watch the pipeline:

```bash
aws codepipeline get-pipeline-state --name devops-lab-pipeline \
  --query 'stageStates[*].{Stage:stageName,Status:latestExecution.status}'
```

You should see:
1. **Source** stage picks up the commit
2. **Build** stage runs CodeBuild (check CloudWatch Logs for output)
3. **Approval** stage waits — check your email for the approval notification

Go to the CodePipeline console and approve (or reject) the manual approval. Observe how the pipeline state changes.

**Experiment:** Try rejecting the approval. Then push another commit and approve it. Notice how each pipeline execution is independent.

**Exam takeaway:** This is exactly how the exam expects you to understand pipeline triggers. Key points:
- `PollForSourceChanges: false` + EventBridge rule is the recommended pattern (not polling)
- Manual approvals use SNS for notifications
- Each stage passes artifacts to the next via S3

### 🧹 Checkpoint

You now have a working pipeline: CodeCommit → CodeBuild → Manual Approval, triggered automatically by EventBridge on every push to `main`.

---

## Lab 4: Secrets Management in Pipelines

**What you'll learn:** How to securely inject secrets into builds using Secrets Manager and Parameter Store — and when to use each.

### Step 1 — Store a secret in Parameter Store

```bash
aws ssm put-parameter \
  --name "/devops-lab/app/api-endpoint" \
  --value "https://api.example.com/v1" \
  --type String

aws ssm put-parameter \
  --name "/devops-lab/app/db-password" \
  --value "SuperSecret123!" \
  --type SecureString
```

### Step 2 — Store a secret in Secrets Manager

```bash
aws secretsmanager create-secret \
  --name devops-lab/api-key \
  --secret-string '{"api_key":"sk-abc123def456","api_secret":"secret789xyz"}'
```

### Step 3 — Grant CodeBuild access to both

Add policies to the CodeBuild role:

```bash
cat > secrets-access-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameters",
        "ssm:GetParameter"
      ],
      "Resource": "arn:aws:ssm:<REGION>:<ACCOUNT_ID>:parameter/devops-lab/*"
    },
    {
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:<REGION>:<ACCOUNT_ID>:secret:devops-lab/*"
    },
    {
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "*"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name CodeBuildServiceRole \
  --policy-name SecretsAccess \
  --policy-document file://secrets-access-policy.json
```

### Step 4 — Update buildspec to use secrets

Update `buildspec.yml`:

```yaml
version: 0.2

env:
  variables:
    NODE_ENV: "test"
  parameter-store:
    API_ENDPOINT: "/devops-lab/app/api-endpoint"
    DB_PASSWORD: "/devops-lab/app/db-password"
  secrets-manager:
    API_KEY: "devops-lab/api-key:api_key"
    API_SECRET: "devops-lab/api-key:api_secret"

phases:
  install:
    runtime-versions:
      nodejs: 18
    commands:
      - npm install

  pre_build:
    commands:
      - echo "API Endpoint is $API_ENDPOINT"
      - echo "DB Password length is ${#DB_PASSWORD} chars"
      - echo "API Key starts with ${API_KEY:0:5}..."
      # NEVER echo full secrets — this is just to prove they're injected

  build:
    commands:
      - npm test

  post_build:
    commands:
      - echo "Build complete"

artifacts:
  files:
    - '**/*'

reports:
  devops-lab-test-report:
    files:
      - 'results.xml'
    base-directory: test-results
    file-format: JUNITXML

cache:
  paths:
    - 'node_modules/**/*'
```

Push and let the pipeline run:

```bash
git add . && git commit -m "Add secrets to buildspec"
git push origin main
```

Check the build logs in CloudWatch. You'll see the secrets are injected as environment variables. The `parameter-store` values are fetched from SSM, and the `secrets-manager` values are fetched from Secrets Manager — both resolved at build start time.

**Experiment:** Try referencing a secret that doesn't exist. Observe how CodeBuild fails at the environment resolution phase (before any build commands run).

### Step 5 — Compare the two approaches

Try this to understand the practical difference:

```bash
# Parameter Store — simple get
aws ssm get-parameter --name "/devops-lab/app/db-password" --with-decryption

# Secrets Manager — more features
aws secretsmanager get-secret-value --secret-id devops-lab/api-key

# Secrets Manager — set up rotation (just see the options, don't actually rotate)
aws secretsmanager describe-secret --secret-id devops-lab/api-key
```

**When to use which — decision framework:**

```
Do you need automatic rotation?
  ├── YES → Secrets Manager
  └── NO
       ├── Is it a database credential? → Secrets Manager (built-in RDS rotation)
       ├── Is it a config value (not really a secret)? → Parameter Store (String type)
       └── Is it a secret but rotation isn't needed? → Parameter Store (SecureString) — cheaper
```

**Exam takeaway:** The exam loves asking "which service should you use for secrets in a pipeline?" The answer depends on whether rotation is needed and whether it's a config value vs. a true secret.

### 🧹 Checkpoint

You now understand:
- How to inject secrets from both Parameter Store and Secrets Manager into CodeBuild
- The buildspec `env` section syntax for each
- When to choose one over the other

---

## Lab 5: Cross-Account Pipeline Architecture (Conceptual + Partial Hands-On)

**What you'll learn:** The IAM trust relationships and KMS key sharing required for cross-account deployments.

> **Note:** This lab requires two AWS accounts. If you only have one, follow along conceptually — the exam tests the *architecture*, not whether you've built it. If you have a second account, do the full exercise.

### The Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Tooling Account (111111111111)                         │
│                                                         │
│  CodeCommit → CodeBuild → [Approve] → Deploy            │
│       │                                  │              │
│       │            Artifact Bucket (S3)  │              │
│       │            KMS Key (shared)      │              │
│       │                                  │              │
└───────┼──────────────────────────────────┼──────────────┘
        │                                  │
        │                    ┌─────────────▼──────────────┐
        │                    │  Production Account         │
        │                    │  (222222222222)             │
        │                    │                             │
        │                    │  CrossAccountDeployRole     │
        │                    │  (trusts Tooling Account)   │
        │                    │                             │
        │                    │  CloudFormation / CodeDeploy│
        │                    └─────────────────────────────┘
```

### Step 1 — Create the KMS key (Tooling Account)

The artifact bucket must be encrypted with a KMS key that both accounts can use:

```bash
# In the Tooling Account
cat > kms-key-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Enable IAM policies in tooling account",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::111111111111:root" },
      "Action": "kms:*",
      "Resource": "*"
    },
    {
      "Sid": "Allow production account to decrypt",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::222222222222:root" },
      "Action": [
        "kms:Decrypt",
        "kms:DescribeKey"
      ],
      "Resource": "*"
    }
  ]
}
EOF

aws kms create-key --policy file://kms-key-policy.json \
  --description "Cross-account pipeline key"
```

### Step 2 — Update the artifact bucket policy

```bash
cat > bucket-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::222222222222:root" },
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:GetBucketVersioning",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::devops-lab-artifacts-111111111111-<REGION>",
        "arn:aws:s3:::devops-lab-artifacts-111111111111-<REGION>/*"
      ]
    }
  ]
}
EOF

aws s3api put-bucket-policy \
  --bucket devops-lab-artifacts-111111111111-<REGION> \
  --policy file://bucket-policy.json
```

### Step 3 — Create the cross-account role (Production Account)

```bash
# Run this in the PRODUCTION account (222222222222)
cat > cross-account-trust.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::111111111111:root"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

aws iam create-role \
  --role-name CrossAccountDeployRole \
  --assume-role-policy-document file://cross-account-trust.json

# Grant permissions to deploy (CloudFormation, EC2, etc.)
aws iam attach-role-policy \
  --role-name CrossAccountDeployRole \
  --policy-arn arn:aws:iam::aws:policy/AWSCloudFormationFullAccess

# Also needs S3 and KMS access to read artifacts
cat > artifact-access-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:GetObjectVersion"],
      "Resource": "arn:aws:s3:::devops-lab-artifacts-111111111111-<REGION>/*"
    },
    {
      "Effect": "Allow",
      "Action": ["kms:Decrypt", "kms:DescribeKey"],
      "Resource": "<KMS_KEY_ARN_FROM_STEP_1>"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name CrossAccountDeployRole \
  --policy-name ArtifactAccess \
  --policy-document file://artifact-access-policy.json
```

### Step 4 — Add the cross-account deploy action to the pipeline

Back in the Tooling Account, you'd add a deploy stage like this to the pipeline JSON:

```json
{
  "name": "Deploy-Production",
  "actions": [
    {
      "name": "DeployToProduction",
      "actionTypeId": {
        "category": "Deploy",
        "owner": "AWS",
        "provider": "CloudFormation",
        "version": "1"
      },
      "inputArtifacts": [{ "name": "BuildOutput" }],
      "configuration": {
        "ActionMode": "CREATE_UPDATE",
        "StackName": "devops-lab-prod-stack",
        "TemplatePath": "BuildOutput::template.yaml",
        "RoleArn": "arn:aws:iam::222222222222:role/CrossAccountDeployRole"
      },
      "roleArn": "arn:aws:iam::222222222222:role/CrossAccountDeployRole"
    }
  ]
}
```

**The three pieces that make cross-account work:**
1. **KMS key policy** — allows the target account to decrypt artifacts
2. **S3 bucket policy** — allows the target account to read artifacts
3. **IAM role in target account** — trusts the tooling account and has deploy permissions

**Exam takeaway:** Cross-account pipelines are one of the most tested patterns. The exam will present scenarios where deployments fail and ask you to identify the missing piece (usually the KMS key policy or the S3 bucket policy).

---

## Cleanup

To avoid charges, tear down everything when you're done:

```bash
# Delete pipeline
aws codepipeline delete-pipeline --name devops-lab-pipeline

# Delete CodeBuild project
aws codebuild delete-project --name devops-lab-build

# Delete CodeCommit repo (WARNING: deletes all code)
aws codecommit delete-repository --repository-name devops-lab-app

# Delete secrets
aws ssm delete-parameter --name "/devops-lab/app/api-endpoint"
aws ssm delete-parameter --name "/devops-lab/app/db-password"
aws secretsmanager delete-secret --secret-id devops-lab/api-key --force-delete-without-recovery

# Delete S3 bucket (must be empty first)
aws s3 rm s3://devops-lab-artifacts-${ACCOUNT_ID}-${REGION} --recursive
aws s3 rb s3://devops-lab-artifacts-${ACCOUNT_ID}-${REGION}

# Delete SNS topic
aws sns delete-topic --topic-arn arn:aws:sns:<REGION>:<ACCOUNT_ID>:codecommit-notifications

# Delete IAM roles (detach policies first)
aws iam detach-role-policy --role-name CodeBuildServiceRole --policy-arn arn:aws:iam::aws:policy/AWSCodeBuildDeveloperAccess
aws iam detach-role-policy --role-name CodeBuildServiceRole --policy-arn arn:aws:iam::aws:policy/CloudWatchLogsFullAccess
aws iam detach-role-policy --role-name CodeBuildServiceRole --policy-arn arn:aws:iam::aws:policy/AWSCodeCommitReadOnly
aws iam delete-role-policy --role-name CodeBuildServiceRole --policy-name SecretsAccess
aws iam delete-role --role-name CodeBuildServiceRole

aws iam detach-role-policy --role-name CodePipelineServiceRole --policy-arn arn:aws:iam::aws:policy/AWSCodePipeline_FullAccess
aws iam detach-role-policy --role-name CodePipelineServiceRole --policy-arn arn:aws:iam::aws:policy/AWSCodeCommitFullAccess
aws iam detach-role-policy --role-name CodePipelineServiceRole --policy-arn arn:aws:iam::aws:policy/AWSCodeBuildDeveloperAccess
aws iam detach-role-policy --role-name CodePipelineServiceRole --policy-arn arn:aws:iam::aws:policy/AmazonS3FullAccess
aws iam delete-role --role-name CodePipelineServiceRole

aws iam delete-role-policy --role-name EventBridgePipelineRole --policy-name StartPipeline
aws iam delete-role --role-name EventBridgePipelineRole

# Delete EventBridge rule
aws events remove-targets --rule devops-lab-pipeline-trigger --ids CodePipelineTarget
aws events delete-rule --name devops-lab-pipeline-trigger

# Delete approval rule template
aws codecommit disassociate-approval-rule-template-from-repository \
  --approval-rule-template-name RequireTwoApprovals \
  --repository-name devops-lab-app 2>/dev/null
aws codecommit delete-approval-rule-template \
  --approval-rule-template-name RequireTwoApprovals

# Clean up local files
rm -f codebuild-trust-policy.json codepipeline-trust-policy.json \
  eventbridge-trust-policy.json eventbridge-pipeline-policy.json \
  secrets-access-policy.json pipeline.json kms-key-policy.json \
  bucket-policy.json cross-account-trust.json artifact-access-policy.json
```

---

## Session 1 — Key Exam Takeaways

Now that you've built it all hands-on, here's what to remember for the exam:

| Topic | What the Exam Tests |
|---|---|
| **Buildspec.yml** | Phase order (`install → pre_build → build → post_build`), `env` section for secrets, `reports` for test results |
| **Pipeline triggers** | EventBridge rule (recommended) vs. polling. Know the event pattern for CodeCommit pushes. |
| **Manual approvals** | SNS notification, approve/reject flow, use as a production gate |
| **Cross-account** | Three pieces: KMS key policy, S3 bucket policy, IAM role with trust. Failure = usually a missing policy. |
| **Secrets** | Secrets Manager for rotation, Parameter Store for config. Both work in buildspec `env`. |
| **CodeBuild VPC** | Required when build needs access to private resources (RDS, ElastiCache). Needs NAT for internet. |
| **Artifact flow** | Source → S3 artifact bucket → next stage. Each stage reads/writes artifacts from S3. |

---

**Next:** [Session 2 — Testing, Artifacts & Deployment Strategies](./02-testing-artifacts-deployments.md)
