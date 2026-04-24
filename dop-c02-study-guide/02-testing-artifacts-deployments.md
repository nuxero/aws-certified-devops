# Session 2: Testing, Artifacts & Deployment Strategies — Hands-On (Domain 1 — SDLC Automation)

> **Task Statements 1.2, 1.3, 1.4**
>
> In this session you'll integrate automated testing into a pipeline, build and manage container images in ECR, set up a CodeArtifact package repository, and deploy an application using CodeDeploy with different strategies (in-place, blue/green, canary). You'll see each deployment strategy in action and understand when to pick which.

---

## Prerequisites

- [ ] Completed Session 1 (or at least have AWS CLI configured and basic Git knowledge)
- [ ] Docker installed locally (for ECR labs)
- [ ] An AWS account with permissions for CodeBuild, CodeDeploy, ECR, EC2, IAM, S3
- [ ] ~$2–3 USD budget (EC2 instances for CodeDeploy labs)

**Estimated time:** 4–5 hours

---

## Lab 1: Automated Testing in a Pipeline

**What you'll learn:** How to structure tests across pipeline stages, gate deployments on test results, and trigger builds on pull requests.

### Step 1 — Create a project with multiple test levels

Create a working directory:

```bash
mkdir -p devops-lab-testing && cd devops-lab-testing
git init
```

Create `package.json`:

```json
{
  "name": "devops-lab-testing",
  "version": "1.0.0",
  "scripts": {
    "test:unit": "mocha --reporter mocha-junit-reporter --reporter-options mochaFile=./test-results/unit.xml test/unit/**/*.test.js",
    "test:integration": "mocha --reporter mocha-junit-reporter --reporter-options mochaFile=./test-results/integration.xml test/integration/**/*.test.js",
    "test:all": "npm run test:unit && npm run test:integration"
  },
  "devDependencies": {
    "mocha": "^10.2.0",
    "mocha-junit-reporter": "^2.2.0",
    "assert": "^2.1.0"
  }
}
```

Create `app.js`:

```javascript
function add(a, b) { return a + b; }
function isHealthy() { return { status: 'ok', uptime: process.uptime() }; }
function fetchConfig(env) {
  const configs = { dev: { debug: true }, prod: { debug: false } };
  return configs[env] || null;
}
module.exports = { add, isHealthy, fetchConfig };
```

Create unit tests in `test/unit/app.test.js`:

```javascript
const assert = require('assert');
const { add, isHealthy, fetchConfig } = require('../../app');

describe('Unit Tests', function() {
  describe('add()', function() {
    it('should add two positive numbers', function() {
      assert.strictEqual(add(2, 3), 5);
    });
    it('should handle negative numbers', function() {
      assert.strictEqual(add(-1, 1), 0);
    });
    it('should handle zero', function() {
      assert.strictEqual(add(0, 0), 0);
    });
  });

  describe('isHealthy()', function() {
    it('should return status ok', function() {
      const result = isHealthy();
      assert.strictEqual(result.status, 'ok');
    });
    it('should include uptime', function() {
      const result = isHealthy();
      assert.strictEqual(typeof result.uptime, 'number');
    });
  });

  describe('fetchConfig()', function() {
    it('should return dev config', function() {
      assert.deepStrictEqual(fetchConfig('dev'), { debug: true });
    });
    it('should return null for unknown env', function() {
      assert.strictEqual(fetchConfig('unknown'), null);
    });
  });
});
```

Create integration tests in `test/integration/config.test.js`:

```javascript
const assert = require('assert');
const { fetchConfig, isHealthy } = require('../../app');

describe('Integration Tests', function() {
  it('health check should work with config loaded', function() {
    const config = fetchConfig('prod');
    const health = isHealthy();
    assert.strictEqual(health.status, 'ok');
    assert.strictEqual(config.debug, false);
  });

  it('should handle full lifecycle: config then health', function() {
    const envs = ['dev', 'prod'];
    envs.forEach(env => {
      const config = fetchConfig(env);
      assert.notStrictEqual(config, null);
      const health = isHealthy();
      assert.strictEqual(health.status, 'ok');
    });
  });
});
```

### Step 2 — Create a buildspec that runs tests in stages

Create `buildspec.yml`:

```yaml
version: 0.2

phases:
  install:
    runtime-versions:
      nodejs: 18
    commands:
      - echo "=== Installing dependencies ==="
      - npm install

  pre_build:
    commands:
      - echo "=== Running unit tests (fast gate) ==="
      - npm run test:unit
      - echo "Unit tests passed — proceeding to build"

  build:
    commands:
      - echo "=== Building application ==="
      - echo "Build step would go here (compile, bundle, etc.)"

  post_build:
    commands:
      - echo "=== Running integration tests ==="
      - npm run test:integration
      - echo "All tests passed"

artifacts:
  files:
    - '**/*'
  exclude-paths:
    - 'node_modules/**'

reports:
  unit-tests:
    files:
      - 'unit.xml'
    base-directory: test-results
    file-format: JUNITXML
  integration-tests:
    files:
      - 'integration.xml'
    base-directory: test-results
    file-format: JUNITXML
```

**Key design decision:** Unit tests run in `pre_build` — if they fail, we never reach the build phase. Integration tests run in `post_build` — they validate the built artifact. This is the pattern the exam expects you to know.

### Step 3 — Push to CodeCommit and run

```bash
# Create the repo
aws codecommit create-repository --repository-name devops-lab-testing

# Set up remote and push
git remote add origin https://git-codecommit.<REGION>.amazonaws.com/v1/repos/devops-lab-testing
git add .
git commit -m "Initial commit with unit and integration tests"
git push -u origin main
```

Create a CodeBuild project (reuse the role from Session 1 or create a new one):

```bash
aws codebuild create-project \
  --name devops-lab-testing \
  --source type=CODECOMMIT,location=https://git-codecommit.<REGION>.amazonaws.com/v1/repos/devops-lab-testing \
  --artifacts type=NO_ARTIFACTS \
  --environment type=LINUX_CONTAINER,computeType=BUILD_GENERAL1_SMALL,image=aws/codebuild/amazonlinux2-x86_64-standard:5.0 \
  --service-role arn:aws:iam::<ACCOUNT_ID>:role/CodeBuildServiceRole
```

Run it and check the reports:

```bash
BUILD_ID=$(aws codebuild start-build --project-name devops-lab-testing \
  --query 'build.id' --output text)
echo "Build: $BUILD_ID"

# Wait for completion
aws codebuild batch-get-builds --ids "$BUILD_ID" \
  --query 'builds[0].{Status:buildStatus,Phases:phases[*].{Name:phaseType,Status:phaseStatus}}'
```

Go to the CodeBuild console → devops-lab-testing → Reports. You'll see both test report groups with individual test results.

### Step 4 — Experiment: break a test and observe

Edit `test/unit/app.test.js` — change an assertion to fail:

```javascript
it('should add two positive numbers', function() {
  assert.strictEqual(add(2, 3), 999); // This will fail
});
```

Push and rebuild. Observe:
- The build fails in `pre_build` phase
- The `build` and `post_build` phases never execute
- The pipeline (if connected) stops — no deployment happens

Fix the test and push again. This is exactly how test gating works.

**Exam takeaway:** Exit codes drive pipeline behavior. Non-zero exit = phase failure = pipeline stops. The exam tests whether you understand that tests in earlier phases gate later phases.

### Step 5 — Set up PR-triggered builds

This pattern runs tests on pull request branches before they're merged.

```bash
# Create an EventBridge rule that triggers CodeBuild on PR events
aws events put-rule \
  --name pr-test-trigger \
  --event-pattern '{
    "source": ["aws.codecommit"],
    "detail-type": ["CodeCommit Pull Request State Change"],
    "resources": ["arn:aws:codecommit:<REGION>:<ACCOUNT_ID>:devops-lab-testing"],
    "detail": {
      "event": ["pullRequestCreated", "pullRequestSourceBranchUpdated"]
    }
  }'
```

You'd then add a CodeBuild target to this rule (similar to the EventBridge setup in Session 1). The CodeBuild project uses the `sourceVersion` from the event to check out the PR branch.

**Exam takeaway:** PR-triggered builds use EventBridge rules matching `CodeCommit Pull Request State Change` events. The build runs against the PR source branch, not `main`.

### 🧹 Checkpoint

You now have:
- A project with unit and integration tests in separate stages
- CodeBuild reports showing individual test results
- Understanding of how test failures gate the pipeline
- Knowledge of PR-triggered build patterns

---

## Lab 2: Container Images with Amazon ECR

**What you'll learn:** Create an ECR repository, build and push Docker images, configure lifecycle policies, enable scanning, and set up cross-account access.

### Step 1 — Create an ECR repository

```bash
aws ecr create-repository \
  --repository-name devops-lab-app \
  --image-scanning-configuration scanOnPush=true \
  --encryption-configuration encryptionType=AES256
```

Note the `repositoryUri` in the output (e.g., `<ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/devops-lab-app`).

### Step 2 — Create a Dockerfile

In your project directory, create `Dockerfile`:

```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY app.js ./

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "app.js"]
```

### Step 3 — Build and push the image

```bash
# Authenticate Docker to ECR
aws ecr get-login-password --region <REGION> | \
  docker login --username AWS --password-stdin \
  <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com

# Build the image
docker build -t devops-lab-app:v1.0.0 .
docker tag devops-lab-app:v1.0.0 \
  <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/devops-lab-app:v1.0.0
docker tag devops-lab-app:v1.0.0 \
  <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/devops-lab-app:latest

# Push both tags
docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/devops-lab-app:v1.0.0
docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/devops-lab-app:latest
```

### Step 4 — Check the scan results

Since we enabled `scanOnPush`, Inspector scans the image automatically:

```bash
# Wait ~30 seconds for the scan, then:
aws ecr describe-image-scan-findings \
  --repository-name devops-lab-app \
  --image-id imageTag=v1.0.0 \
  --query 'imageScanFindings.{Status:imageScanStatus.status,Counts:findingSeverityCounts}'
```

You'll see a severity breakdown (CRITICAL, HIGH, MEDIUM, LOW, INFORMATIONAL). In a real pipeline, you'd fail the build if CRITICAL > 0.

**Experiment:** Try pushing an image based on an older, unpatched base image (e.g., `node:14`) and compare the scan results.

### Step 5 — Configure a lifecycle policy

```bash
aws ecr put-lifecycle-policy \
  --repository-name devops-lab-app \
  --lifecycle-policy-text '{
    "rules": [
      {
        "rulePriority": 1,
        "description": "Expire untagged images after 1 day",
        "selection": {
          "tagStatus": "untagged",
          "countType": "sinceImagePushed",
          "countUnit": "days",
          "countNumber": 1
        },
        "action": { "type": "expire" }
      },
      {
        "rulePriority": 2,
        "description": "Keep only last 10 tagged images",
        "selection": {
          "tagStatus": "tagged",
          "tagPrefixList": ["v"],
          "countType": "imageCountMoreThan",
          "countNumber": 10
        },
        "action": { "type": "expire" }
      }
    ]
  }'
```

Verify it:

```bash
aws ecr get-lifecycle-policy --repository-name devops-lab-app
```

### Step 6 — Set up cross-account pull access

If you have a second account (e.g., production), allow it to pull images:

```bash
aws ecr set-repository-policy \
  --repository-name devops-lab-app \
  --policy-text '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "AllowProdAccountPull",
        "Effect": "Allow",
        "Principal": { "AWS": "arn:aws:iam::<PROD_ACCOUNT_ID>:root" },
        "Action": [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:BatchCheckLayerAvailability"
        ]
      }
    ]
  }'
```

If you only have one account, still run this with a fake account ID to see the policy structure — then delete it:

```bash
aws ecr delete-repository-policy --repository-name devops-lab-app
```

### Step 7 — Configure cross-Region replication

```bash
aws ecr put-replication-configuration \
  --replication-configuration '{
    "rules": [
      {
        "destinations": [
          {
            "region": "eu-west-1",
            "registryId": "<ACCOUNT_ID>"
          }
        ]
      }
    ]
  }'
```

Now any image pushed to your primary Region automatically replicates to eu-west-1. Verify:

```bash
aws ecr describe-repositories --region eu-west-1 \
  --query 'repositories[?repositoryName==`devops-lab-app`].repositoryUri'
```

**Exam takeaway:** ECR replication is configured at the registry level (not per-repository). It supports both cross-Region and cross-account replication. The exam tests this in multi-Region deployment scenarios.

### 🧹 Checkpoint

You now have:
- An ECR repository with scan-on-push, lifecycle policies, and replication
- Hands-on experience with the Docker build/push/scan workflow
- Understanding of cross-account and cross-Region ECR patterns

---

## Lab 3: Package Management with CodeArtifact

**What you'll learn:** Set up a CodeArtifact domain and repository, use it as an npm proxy, and understand cross-account sharing.

### Step 1 — Create a domain and repository

```bash
# Create a domain (shared across your organization)
aws codeartifact create-domain --domain devops-lab

# Create a repository with an upstream connection to npmjs
aws codeartifact create-repository \
  --domain devops-lab \
  --repository devops-lab-npm \
  --description "Internal npm packages with upstream to npmjs"

# Create the upstream connection to public npm
aws codeartifact create-repository \
  --domain devops-lab \
  --repository npm-store \
  --description "Upstream proxy for npmjs.com"

aws codeartifact associate-external-connection \
  --domain devops-lab \
  --repository npm-store \
  --external-connection public:npmjs

# Link them: devops-lab-npm → npm-store → npmjs.com
aws codeartifact update-repository \
  --domain devops-lab \
  --repository devops-lab-npm \
  --upstreams repositoryName=npm-store
```

### Step 2 — Configure npm to use CodeArtifact

```bash
# Get an auth token (valid for 12 hours)
aws codeartifact login \
  --tool npm \
  --domain devops-lab \
  --repository devops-lab-npm
```

This updates your `~/.npmrc` to point to CodeArtifact. Now install a package:

```bash
cd devops-lab-testing
npm install lodash
```

Check that the package was cached in CodeArtifact:

```bash
aws codeartifact list-packages \
  --domain devops-lab \
  --repository devops-lab-npm \
  --query 'packages[*].{Name:package,Namespace:namespace}'
```

You'll see `lodash` listed — it was fetched from npmjs.com via the upstream and cached locally.

### Step 3 — Understand the value

**Why this matters for the exam:**
- CodeArtifact acts as a proxy — if npmjs.com goes down, your builds still work (packages are cached)
- You control which packages are available (security: block vulnerable packages)
- Cross-account sharing via domain policies — all teams in the org use the same cache
- In CodeBuild, you'd add `aws codeartifact login` to the `install` phase of your buildspec

### Step 4 — Clean up CodeArtifact

```bash
aws codeartifact delete-repository --domain devops-lab --repository devops-lab-npm
aws codeartifact delete-repository --domain devops-lab --repository npm-store
aws codeartifact delete-domain --domain devops-lab

# Restore npm config
npm config delete registry
```

### 🧹 Checkpoint

You now understand:
- CodeArtifact domain → repository → upstream chain
- How it proxies public registries and caches packages
- How to integrate it with npm (and by extension Maven, pip, etc.)

---

## Lab 4: CodeDeploy — In-Place Deployment to EC2

**What you'll learn:** Install the CodeDeploy agent, write an AppSpec file, deploy to EC2 with in-place (rolling) strategy, and observe lifecycle hooks.

> This is the most important lab in this session. Deployment strategies are heavily tested on the exam.

### Step 1 — Launch an EC2 instance with the CodeDeploy agent

First, create an IAM role for the EC2 instance:

```bash
cat > ec2-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ec2.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

aws iam create-role \
  --role-name EC2CodeDeployRole \
  --assume-role-policy-document file://ec2-trust-policy.json

aws iam attach-role-policy --role-name EC2CodeDeployRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam attach-role-policy --role-name EC2CodeDeployRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess

aws iam create-instance-profile --instance-profile-name EC2CodeDeployProfile
aws iam add-role-to-instance-profile \
  --instance-profile-name EC2CodeDeployProfile \
  --role-name EC2CodeDeployRole
```

Launch the instance (Amazon Linux 2023, t2.micro for free tier):

```bash
# Get the latest AL2023 AMI
AMI_ID=$(aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameter.Value' --output text)

# Get your default VPC and a subnet
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)
SUBNET_ID=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC_ID \
  --query 'Subnets[0].SubnetId' --output text)

# Create a security group allowing HTTP
SG_ID=$(aws ec2 create-security-group \
  --group-name codedeploy-lab-sg \
  --description "CodeDeploy lab" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID --protocol tcp --port 80 --cidr 0.0.0.0/0

# User data script to install CodeDeploy agent + nginx
cat > userdata.sh << 'USERDATA'
#!/bin/bash
yum update -y
yum install -y ruby wget nginx

# Install CodeDeploy agent
cd /home/ec2-user
wget https://aws-codedeploy-<REGION>.s3.<REGION>.amazonaws.com/latest/install
chmod +x ./install
./install auto

# Start nginx
systemctl start nginx
systemctl enable nginx

echo "<h1>Version 1.0 - Original</h1>" > /usr/share/nginx/html/index.html
USERDATA

# Launch the instance
INSTANCE_ID=$(aws ec2 run-instances \
  --image-id $AMI_ID \
  --instance-type t2.micro \
  --iam-instance-profile Name=EC2CodeDeployProfile \
  --security-group-ids $SG_ID \
  --subnet-id $SUBNET_ID \
  --user-data file://userdata.sh \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=CodeDeployLab},{Key=Environment,Value=dev}]' \
  --query 'Instances[0].InstanceId' --output text)

echo "Instance: $INSTANCE_ID"
echo "Waiting for instance to be running..."
aws ec2 wait instance-running --instance-ids $INSTANCE_ID

PUBLIC_IP=$(aws ec2 describe-instances --instance-ids $INSTANCE_ID \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "Public IP: $PUBLIC_IP"
```

Wait 2–3 minutes for the user data script to complete, then verify:

```bash
curl http://$PUBLIC_IP
# Should show: <h1>Version 1.0 - Original</h1>
```

### Step 2 — Create the deployment application and group

```bash
# IAM role for CodeDeploy service
cat > codedeploy-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "codedeploy.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

aws iam create-role \
  --role-name CodeDeployServiceRole \
  --assume-role-policy-document file://codedeploy-trust-policy.json

aws iam attach-role-policy --role-name CodeDeployServiceRole \
  --policy-arn arn:aws:iam::aws:policy/AWSCodeDeployRole

# Create the application
aws deploy create-application --application-name devops-lab-app

# Create a deployment group targeting instances by tag
aws deploy create-deployment-group \
  --application-name devops-lab-app \
  --deployment-group-name dev-group \
  --service-role-arn arn:aws:iam::<ACCOUNT_ID>:role/CodeDeployServiceRole \
  --ec2-tag-filters Key=Environment,Value=dev,Type=KEY_AND_VALUE \
  --deployment-config-name CodeDeployDefault.AllAtOnce
```

### Step 3 — Create the deployment bundle with AppSpec

Create a deployment directory:

```bash
mkdir -p deploy-bundle/scripts
```

Create `deploy-bundle/appspec.yml`:

```yaml
version: 0.0
os: linux
files:
  - source: /html/index.html
    destination: /usr/share/nginx/html/

hooks:
  BeforeInstall:
    - location: scripts/before_install.sh
      timeout: 120
      runas: root
  AfterInstall:
    - location: scripts/after_install.sh
      timeout: 120
      runas: root
  ApplicationStart:
    - location: scripts/start_server.sh
      timeout: 60
      runas: root
  ValidateService:
    - location: scripts/validate.sh
      timeout: 60
      runas: root
```

Create `deploy-bundle/html/index.html`:

```html
<h1>Version 2.0 - Deployed via CodeDeploy!</h1>
<p>Deployment time: DEPLOY_TIMESTAMP</p>
```

Create the lifecycle hook scripts:

`deploy-bundle/scripts/before_install.sh`:
```bash
#!/bin/bash
echo "[BeforeInstall] Cleaning up old deployment..."
rm -f /usr/share/nginx/html/index.html
echo "[BeforeInstall] Done at $(date)"
```

`deploy-bundle/scripts/after_install.sh`:
```bash
#!/bin/bash
echo "[AfterInstall] Configuring deployed files..."
sed -i "s/DEPLOY_TIMESTAMP/$(date)/" /usr/share/nginx/html/index.html
echo "[AfterInstall] Done at $(date)"
```

`deploy-bundle/scripts/start_server.sh`:
```bash
#!/bin/bash
echo "[ApplicationStart] Restarting nginx..."
systemctl restart nginx
echo "[ApplicationStart] nginx restarted at $(date)"
```

`deploy-bundle/scripts/validate.sh`:
```bash
#!/bin/bash
echo "[ValidateService] Checking if nginx is running..."
systemctl is-active nginx
if [ $? -ne 0 ]; then
  echo "[ValidateService] FAILED - nginx is not running"
  exit 1
fi

echo "[ValidateService] Checking HTTP response..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost)
if [ "$HTTP_CODE" != "200" ]; then
  echo "[ValidateService] FAILED - HTTP status $HTTP_CODE"
  exit 1
fi

echo "[ValidateService] SUCCESS - nginx is healthy"
exit 0
```

Make scripts executable and bundle:

```bash
chmod +x deploy-bundle/scripts/*.sh
```

### Step 4 — Upload and deploy

```bash
# Create an S3 bucket for deployment artifacts
aws s3 mb s3://devops-lab-deploy-<ACCOUNT_ID>

# Bundle and upload
cd deploy-bundle
zip -r ../devops-lab-v2.zip .
cd ..

aws s3 cp devops-lab-v2.zip s3://devops-lab-deploy-<ACCOUNT_ID>/

# Create the deployment
DEPLOYMENT_ID=$(aws deploy create-deployment \
  --application-name devops-lab-app \
  --deployment-group-name dev-group \
  --s3-location bucket=devops-lab-deploy-<ACCOUNT_ID>,key=devops-lab-v2.zip,bundleType=zip \
  --description "Deploy v2.0" \
  --query 'deploymentId' --output text)

echo "Deployment: $DEPLOYMENT_ID"
```

### Step 5 — Watch the deployment lifecycle

```bash
# Poll deployment status
while true; do
  STATUS=$(aws deploy get-deployment --deployment-id $DEPLOYMENT_ID \
    --query 'deploymentInfo.status' --output text)
  echo "$(date +%H:%M:%S) Status: $STATUS"
  if [ "$STATUS" != "InProgress" ] && [ "$STATUS" != "Created" ]; then break; fi
  sleep 5
done

# See lifecycle events for each instance
aws deploy list-deployment-instances --deployment-id $DEPLOYMENT_ID
aws deploy get-deployment-instance \
  --deployment-id $DEPLOYMENT_ID \
  --instance-id $INSTANCE_ID \
  --query 'instanceSummary.lifecycleEvents[*].{Event:lifecycleEventName,Status:status}'
```

You'll see each lifecycle event in order:
```
ApplicationStop → DownloadBundle → BeforeInstall → Install →
AfterInstall → ApplicationStart → ValidateService
```

Verify the deployment:

```bash
curl http://$PUBLIC_IP
# Should show: Version 2.0 - Deployed via CodeDeploy!
```

**Experiment:** Make the `validate.sh` script fail (change the expected HTTP code). Redeploy and observe how CodeDeploy marks the deployment as failed at the `ValidateService` event.

**Exam takeaway:** Know the lifecycle hook order cold. The exam presents scenarios where a deployment fails at a specific hook and asks you to troubleshoot. Also know that `ApplicationStop` runs the *previous* revision's stop script (not the new one).

### 🧹 Checkpoint

You've now:
- Deployed to EC2 using CodeDeploy with an in-place strategy
- Written an AppSpec file with all major lifecycle hooks
- Observed the deployment lifecycle event by event
- Understood how validation scripts gate deployment success

---

## Lab 5: CodeDeploy — Lambda Canary Deployment

**What you'll learn:** Deploy a Lambda function with canary traffic shifting, pre/post-traffic hooks, and automatic rollback.

### Step 1 — Create the Lambda function

```bash
# Create the function code
mkdir -p lambda-deploy && cd lambda-deploy

cat > index.mjs << 'EOF'
export const handler = async (event) => {
  return {
    statusCode: 200,
    body: JSON.stringify({ version: "1.0", message: "Hello from v1" })
  };
};
EOF

zip function-v1.zip index.mjs

# Create execution role
cat > lambda-trust.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

aws iam create-role --role-name LambdaDeployLabRole \
  --assume-role-policy-document file://lambda-trust.json
aws iam attach-role-policy --role-name LambdaDeployLabRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# Wait for role propagation
sleep 10

# Create the function
aws lambda create-function \
  --function-name devops-lab-canary \
  --runtime nodejs18.x \
  --handler index.handler \
  --role arn:aws:iam::<ACCOUNT_ID>:role/LambdaDeployLabRole \
  --zip-file fileb://function-v1.zip

# Publish version 1
VERSION_1=$(aws lambda publish-version \
  --function-name devops-lab-canary \
  --query 'Version' --output text)
echo "Published version: $VERSION_1"

# Create an alias pointing to version 1
aws lambda create-alias \
  --function-name devops-lab-canary \
  --name live \
  --function-version $VERSION_1
```

### Step 2 — Create v2 of the function

```bash
cat > index.mjs << 'EOF'
export const handler = async (event) => {
  return {
    statusCode: 200,
    body: JSON.stringify({ version: "2.0", message: "Hello from v2 - canary!" })
  };
};
EOF

zip function-v2.zip index.mjs

aws lambda update-function-code \
  --function-name devops-lab-canary \
  --zip-file fileb://function-v2.zip

# Wait for update to complete
aws lambda wait function-updated --function-name devops-lab-canary

VERSION_2=$(aws lambda publish-version \
  --function-name devops-lab-canary \
  --query 'Version' --output text)
echo "Published version: $VERSION_2"
```

### Step 3 — Create a pre-traffic validation hook

This Lambda function runs before traffic shifts to the new version. If it fails, the deployment rolls back.

```bash
cat > pre_traffic_hook.mjs << 'EOF'
import { CodeDeployClient, PutLifecycleEventHookExecutionStatusCommand } from "@aws-sdk/client-codedeploy";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const codedeploy = new CodeDeployClient();
const lambda = new LambdaClient();

export const handler = async (event) => {
  console.log("PreTraffic hook triggered:", JSON.stringify(event));

  const deploymentId = event.DeploymentId;
  const lifecycleEventHookExecutionId = event.LifecycleEventHookExecutionId;
  let status = "Succeeded";

  try {
    // Invoke the NEW version of the function to validate it
    const result = await lambda.send(new InvokeCommand({
      FunctionName: 'devops-lab-canary',
      InvocationType: 'RequestResponse',
      Qualifier: '$LATEST'  // This points to the newest code
    }));

    const payload = JSON.parse(Buffer.from(result.Payload).toString());
    console.log("Validation response:", payload);

    if (payload.statusCode !== 200) {
      throw new Error(`Unexpected status code: ${payload.statusCode}`);
    }

    console.log("Validation PASSED");
  } catch (err) {
    console.error("Validation FAILED:", err);
    status = "Failed";
  }

  // Report back to CodeDeploy
  await codedeploy.send(new PutLifecycleEventHookExecutionStatusCommand({
    deploymentId,
    lifecycleEventHookExecutionId,
    status
  }));
};
EOF

zip pre_traffic_hook.zip pre_traffic_hook.mjs

# The hook function needs permissions to invoke Lambda and report to CodeDeploy
cat > hook-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "lambda:InvokeFunction",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "codedeploy:PutLifecycleEventHookExecutionStatus",
      "Resource": "*"
    }
  ]
}
EOF

aws iam put-role-policy --role-name LambdaDeployLabRole \
  --policy-name HookPermissions --policy-document file://hook-policy.json

aws lambda create-function \
  --function-name devops-lab-pre-traffic-hook \
  --runtime nodejs18.x \
  --handler pre_traffic_hook.handler \
  --role arn:aws:iam::<ACCOUNT_ID>:role/LambdaDeployLabRole \
  --zip-file fileb://pre_traffic_hook.zip \
  --timeout 60
```

### Step 4 — Create the AppSpec and deploy with canary

```bash
cat > appspec.yml << 'EOF'
version: 0.0
Resources:
  - devopsLabCanary:
      Type: AWS::Lambda::Function
      Properties:
        Name: devops-lab-canary
        Alias: live
        CurrentVersion: VERSION_1_PLACEHOLDER
        TargetVersion: VERSION_2_PLACEHOLDER
Hooks:
  - BeforeAllowTraffic: devops-lab-pre-traffic-hook
EOF

# Replace placeholders
sed -i "s/VERSION_1_PLACEHOLDER/$VERSION_1/" appspec.yml
sed -i "s/VERSION_2_PLACEHOLDER/$VERSION_2/" appspec.yml

cat appspec.yml  # Verify the versions are correct
```

Create the CodeDeploy application for Lambda:

```bash
aws deploy create-application \
  --application-name devops-lab-lambda \
  --compute-platform Lambda

aws deploy create-deployment-group \
  --application-name devops-lab-lambda \
  --deployment-group-name canary-group \
  --service-role-arn arn:aws:iam::<ACCOUNT_ID>:role/CodeDeployServiceRole \
  --deployment-config-name CodeDeployDefault.LambdaCanary10Percent5Minutes \
  --deployment-style deploymentType=BLUE_GREEN,deploymentOption=WITH_TRAFFIC_CONTROL
```

Deploy:

```bash
# Upload appspec
aws s3 cp appspec.yml s3://devops-lab-deploy-<ACCOUNT_ID>/lambda-appspec.yml

LAMBDA_DEPLOY_ID=$(aws deploy create-deployment \
  --application-name devops-lab-lambda \
  --deployment-group-name canary-group \
  --s3-location bucket=devops-lab-deploy-<ACCOUNT_ID>,key=lambda-appspec.yml,bundleType=YAML \
  --query 'deploymentId' --output text)

echo "Lambda deployment: $LAMBDA_DEPLOY_ID"
```

### Step 5 — Observe the canary in action

```bash
# Watch the deployment
while true; do
  STATUS=$(aws deploy get-deployment --deployment-id $LAMBDA_DEPLOY_ID \
    --query 'deploymentInfo.status' --output text)
  echo "$(date +%H:%M:%S) Status: $STATUS"
  if [ "$STATUS" != "InProgress" ] && [ "$STATUS" != "Created" ]; then break; fi

  # Check the alias routing config
  aws lambda get-alias --function-name devops-lab-canary --name live \
    --query '{Version:FunctionVersion,RoutingConfig:RoutingConfig}' 2>/dev/null

  sleep 15
done
```

During the canary phase, you'll see the alias routing config show something like:
```json
{
  "FunctionVersion": "1",
  "RoutingConfig": {
    "AdditionalVersionWeights": { "2": 0.1 }
  }
}
```

This means 90% of traffic goes to v1, 10% to v2. After 5 minutes (the canary interval), if no alarms trigger, all traffic shifts to v2.

Invoke the function several times during the canary window to see both versions respond:

```bash
for i in $(seq 1 20); do
  aws lambda invoke --function-name devops-lab-canary --qualifier live \
    /dev/stdout 2>/dev/null | head -1
done
```

You should see a mix of v1 and v2 responses (~90/10 split).

**Exam takeaway:** Lambda canary deployments use alias routing weights. `Canary10Percent5Minutes` means 10% for 5 minutes, then 100%. The pre-traffic hook runs *before* any traffic shifts. If the hook fails, the deployment rolls back immediately — no traffic ever reaches the new version.

### 🧹 Checkpoint

You've now:
- Deployed a Lambda function with canary traffic shifting
- Written a pre-traffic validation hook
- Observed alias routing weights change in real time
- Understood how CodeDeploy manages Lambda deployments

---

## Lab 6: Deployment Strategy Decision Exercise

**What you'll learn:** How to pick the right deployment strategy for a given scenario — the core skill the exam tests.

This is not a build lab. It's a decision-making exercise. For each scenario, decide the strategy before reading the answer.

### Scenario 1
> "We need zero downtime. If something goes wrong, we need to roll back instantly. Cost is not a concern."

**Your answer:** _______________

<details>
<summary>Reveal answer</summary>

**Blue/Green.** Two full environments. Instant rollback by switching traffic back to blue. Zero downtime because traffic switches at the load balancer or DNS level.

</details>

### Scenario 2
> "We're deploying a new Lambda function version. We want to test it with 10% of traffic for 10 minutes before going fully live. If error rates spike, roll back automatically."

**Your answer:** _______________

<details>
<summary>Reveal answer</summary>

**Canary (CodeDeploy `LambdaCanary10Percent10Minutes`).** Configure a CloudWatch alarm on the Lambda `Errors` metric. Attach the alarm to the deployment group for automatic rollback.

</details>

### Scenario 3
> "We have 20 EC2 instances behind an ALB. We need to deploy with no capacity reduction. Budget is tight."

**Your answer:** _______________

<details>
<summary>Reveal answer</summary>

**Rolling with additional batch (Elastic Beanstalk)** or **Rolling with minimum healthy percentage set high (CodeDeploy).** Launches extra instances to maintain capacity during deployment. Cheaper than blue/green (no full duplicate environment).

</details>

### Scenario 4
> "Our application has configuration drift issues. Instances that have been running for months behave differently from fresh ones. We need deployments that guarantee a clean state."

**Your answer:** _______________

<details>
<summary>Reveal answer</summary>

**Immutable deployment.** Launches entirely new instances from a fresh AMI. Old instances are untouched until new ones are verified. Eliminates configuration drift by definition.

</details>

### Scenario 5
> "We're deploying to a dev environment. Speed is the priority. Downtime is acceptable."

**Your answer:** _______________

<details>
<summary>Reveal answer</summary>

**All-at-once.** Fastest deployment. All instances updated simultaneously. Acceptable for non-production where downtime doesn't matter.

</details>

### Scenario 6
> "We run an ECS service on Fargate. We want to deploy a new task definition and validate it with a test listener before shifting production traffic. If validation fails, no production traffic should ever hit the new version."

**Your answer:** _______________

<details>
<summary>Reveal answer</summary>

**Blue/Green with CodeDeploy for ECS** (or ECS-native blue/green, available since October 2025). Configure a test listener on the ALB. Use the `AfterAllowTestTraffic` hook to run validation against the test listener. Only after validation passes does production traffic shift. If validation fails, the deployment rolls back — production traffic never touches the new task set. Note: ECS now also supports native canary and linear deployments without CodeDeploy.

</details>

---

## Cleanup

```bash
# Delete Lambda resources
aws lambda delete-function --function-name devops-lab-canary
aws lambda delete-function --function-name devops-lab-pre-traffic-hook
aws iam delete-role-policy --role-name LambdaDeployLabRole --policy-name HookPermissions
aws iam detach-role-policy --role-name LambdaDeployLabRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name LambdaDeployLabRole

# Delete CodeDeploy resources
aws deploy delete-deployment-group --application-name devops-lab-lambda --deployment-group-name canary-group
aws deploy delete-application --application-name devops-lab-lambda
aws deploy delete-deployment-group --application-name devops-lab-app --deployment-group-name dev-group
aws deploy delete-application --application-name devops-lab-app
aws iam detach-role-policy --role-name CodeDeployServiceRole \
  --policy-arn arn:aws:iam::aws:policy/AWSCodeDeployRole
aws iam delete-role --role-name CodeDeployServiceRole

# Delete EC2 resources
aws ec2 terminate-instances --instance-ids $INSTANCE_ID
aws ec2 wait instance-terminated --instance-ids $INSTANCE_ID
aws ec2 delete-security-group --group-id $SG_ID
aws iam remove-role-from-instance-profile \
  --instance-profile-name EC2CodeDeployProfile --role-name EC2CodeDeployRole
aws iam delete-instance-profile --instance-profile-name EC2CodeDeployProfile
aws iam detach-role-policy --role-name EC2CodeDeployRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam detach-role-policy --role-name EC2CodeDeployRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess
aws iam delete-role --role-name EC2CodeDeployRole

# Delete ECR
aws ecr delete-repository --repository-name devops-lab-app --force

# Delete S3 artifacts
aws s3 rm s3://devops-lab-deploy-<ACCOUNT_ID> --recursive
aws s3 rb s3://devops-lab-deploy-<ACCOUNT_ID>

# Delete CodeCommit repo
aws codecommit delete-repository --repository-name devops-lab-testing

# Delete CodeBuild project
aws codebuild delete-project --name devops-lab-testing

# Delete EventBridge rule
aws events remove-targets --rule pr-test-trigger --ids 1 2>/dev/null
aws events delete-rule --name pr-test-trigger 2>/dev/null

# Clean up local files
rm -rf devops-lab-testing deploy-bundle lambda-deploy
rm -f ec2-trust-policy.json codedeploy-trust-policy.json lambda-trust.json \
  hook-policy.json userdata.sh devops-lab-v2.zip
```

---

## Session 2 — Key Exam Takeaways

| Topic | What the Exam Tests |
|---|---|
| **Test placement** | Unit tests early (pre_build), integration tests later (post_build). Exit codes gate the pipeline. |
| **ECR** | Scan-on-push, lifecycle policies, cross-Region replication, cross-account repository policies. |
| **CodeArtifact** | Domain → repository → upstream chain. Proxy for public registries. Cross-account via domain policies. |
| **AppSpec (EC2)** | Lifecycle hook order: `ApplicationStop → DownloadBundle → BeforeInstall → Install → AfterInstall → ApplicationStart → ValidateService` |
| **AppSpec (Lambda)** | `BeforeAllowTraffic` and `AfterAllowTraffic` hooks. Alias routing weights for canary. |
| **AppSpec (ECS)** | `AfterAllowTestTraffic` hook for validation before production traffic shift. |
| **ECS native deployments** | As of October 2025, ECS supports built-in blue/green, canary, and linear deployments natively — without CodeDeploy. ECS-native is now the recommended default for new deployments. CodeDeploy for ECS is still supported and may appear on the exam. |
| **Deployment strategies** | Blue/green = zero downtime + instant rollback. Canary = lowest risk. Immutable = no drift. All-at-once = fastest. |
| **Rollback** | CodeDeploy rollback = new deployment of previous revision (not a revert). Can be triggered by CloudWatch alarms. |
| **Storage patterns** | EFS for shared state across instances. EBS for per-instance state. S3 for artifacts and static assets. |

---

**Next:** [Session 3 — Infrastructure as Code](./03-infrastructure-as-code.md)
