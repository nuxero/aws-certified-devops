# Cross-Account ECS Deployments with AWS CodePipeline

In the real world, most organizations don't run everything in a single AWS account. They separate concerns — CI/CD tooling in one account, production workloads in another. This gives you stronger security boundaries, cleaner billing, and limits the blast radius when something goes wrong. Your pipeline infrastructure stays isolated from the services it deploys to.

But it introduces a challenge: how does your CI/CD pipeline in a tooling account deploy to a production account?

In this post, we'll take an existing CodePipeline (source + build) in a **Tooling Account** and wire it up to deploy a containerized application to an ECS Fargate service in a separate **Production Account**. We'll cover every piece that makes cross-account deployment work: KMS key sharing, S3 bucket policies, IAM trust relationships, and ECR image access.

## Architecture

Here's what we're building:

![Cross-Account ECS Deployment Architecture](cross-account-deployment.png)

Three things make cross-account CodePipeline deployments work:

1. **A KMS Customer Managed Key** — CodePipeline encrypts artifacts in S3. The production account needs to decrypt them. The default `aws/s3` managed key can't be shared across accounts, so you need your own key.
2. **An S3 bucket policy** — The production account's role needs permission to read artifact objects from the tooling account's bucket.
3. **An IAM role in the production account** — This role trusts the tooling account's pipeline role and has permissions to deploy to ECS.

## Prerequisites

You need **two AWS accounts**. We'll call them:
- **Account A (Tooling):** `111111111111` — where the pipeline lives
- **Account B (Production):** `222222222222` — where we deploy to

The production account needs a VPC with public subnets so the ECS Fargate task can pull images and serve traffic. The default VPC that comes with every AWS account works fine.

Replace these placeholder account IDs with your own throughout the post.

To get the baseline infrastructure in place quickly, we provide two CloudFormation templates — one per account. This lets us focus entirely on the cross-account wiring.

### Template A — Tooling Account

Deploy this in Account A. It creates:
- A CodeCommit repository with a sample Node.js application
- An ECR repository
- A CodeBuild project that builds a Docker image and produces `imagedefinitions.json`
- An S3 artifact bucket with versioning
- A KMS Customer Managed Key (we'll update its policy later)
- A CodePipeline with Source → Build stages (no deploy stage yet)
- The required IAM service roles

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: 'Cross-Account Pipeline Lab - Tooling Account (Account A)'

Parameters:
  ProductionAccountId:
    Type: String
    Description: 'The AWS Account ID of the production account (Account B)'

Resources:
  # --- KMS Key for artifact encryption ---
  PipelineKMSKey:
    Type: AWS::KMS::Key
    Properties:
      Description: 'KMS key for cross-account pipeline artifact encryption'
      KeyPolicy:
        Version: '2012-10-17'
        Statement:
          - Sid: EnableToolingAccountAccess
            Effect: Allow
            Principal:
              AWS: !Sub 'arn:aws:iam::${AWS::AccountId}:root'
            Action: 'kms:*'
            Resource: '*'
          - Sid: AllowProductionAccountDecrypt
            Effect: Allow
            Principal:
              AWS: !Sub 'arn:aws:iam::${ProductionAccountId}:root'
            Action:
              - kms:Decrypt
              - kms:DescribeKey
            Resource: '*'

  PipelineKMSKeyAlias:
    Type: AWS::KMS::Alias
    Properties:
      AliasName: alias/cross-account-pipeline-key
      TargetKeyId: !Ref PipelineKMSKey

  # --- S3 Artifact Bucket ---
  ArtifactBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub 'cross-account-pipeline-artifacts-${AWS::AccountId}'
      VersioningConfiguration:
        Status: Enabled

  ArtifactBucketPolicy:
    Type: AWS::S3::BucketPolicy
    Properties:
      Bucket: !Ref ArtifactBucket
      PolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Sid: AllowProductionAccountRead
            Effect: Allow
            Principal:
              AWS: !Sub 'arn:aws:iam::${ProductionAccountId}:root'
            Action:
              - s3:GetObject
              - s3:GetObjectVersion
            Resource: !Sub '${ArtifactBucket.Arn}/*'
          - Sid: AllowProductionAccountList
            Effect: Allow
            Principal:
              AWS: !Sub 'arn:aws:iam::${ProductionAccountId}:root'
            Action:
              - s3:GetBucketVersioning
              - s3:ListBucket
            Resource: !GetAtt ArtifactBucket.Arn

  # --- ECR Repository ---
  ECRRepository:
    Type: AWS::ECR::Repository
    Properties:
      RepositoryName: cross-account-app
      RepositoryPolicyText:
        Version: '2012-10-17'
        Statement:
          - Sid: AllowProductionAccountPull
            Effect: Allow
            Principal:
              AWS: !Sub 'arn:aws:iam::${ProductionAccountId}:root'
            Action:
              - ecr:GetDownloadUrlForLayer
              - ecr:BatchGetImage
              - ecr:BatchCheckLayerAvailability

  # --- CodeCommit Repository ---
  CodeCommitRepo:
    Type: AWS::CodeCommit::Repository
    Properties:
      RepositoryName: cross-account-app
      RepositoryDescription: 'Sample app for cross-account deployment lab'

  # --- CodeBuild IAM Role ---
  CodeBuildRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: CrossAccountLab-CodeBuildRole
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: codebuild.amazonaws.com
            Action: sts:AssumeRole
      Policies:
        - PolicyName: CodeBuildAccess
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action:
                  - logs:CreateLogGroup
                  - logs:CreateLogStream
                  - logs:PutLogEvents
                Resource: '*'
              - Effect: Allow
                Action:
                  - s3:GetObject
                  - s3:PutObject
                  - s3:GetObjectVersion
                Resource: !Sub '${ArtifactBucket.Arn}/*'
              - Effect: Allow
                Action:
                  - ecr:GetAuthorizationToken
                Resource: '*'
              - Effect: Allow
                Action:
                  - ecr:BatchCheckLayerAvailability
                  - ecr:GetDownloadUrlForLayer
                  - ecr:BatchGetImage
                  - ecr:PutImage
                  - ecr:InitiateLayerUpload
                  - ecr:UploadLayerPart
                  - ecr:CompleteLayerUpload
                Resource: !GetAtt ECRRepository.Arn
              - Effect: Allow
                Action:
                  - kms:Decrypt
                  - kms:GenerateDataKey
                Resource: !GetAtt PipelineKMSKey.Arn
              - Effect: Allow
                Action:
                  - codecommit:GitPull
                Resource: !GetAtt CodeCommitRepo.Arn

  # --- CodeBuild Project ---
  CodeBuildProject:
    Type: AWS::CodeBuild::Project
    Properties:
      Name: cross-account-app-build
      ServiceRole: !GetAtt CodeBuildRole.Arn
      Source:
        Type: CODEPIPELINE
        BuildSpec: buildspec.yml
      Artifacts:
        Type: CODEPIPELINE
      Environment:
        Type: LINUX_CONTAINER
        ComputeType: BUILD_GENERAL1_SMALL
        Image: aws/codebuild/amazonlinux2-x86_64-standard:5.0
        PrivilegedMode: true
        EnvironmentVariables:
          - Name: ECR_REPO_URI
            Value: !Sub '${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/cross-account-app'

  # --- CodePipeline IAM Role ---
  CodePipelineRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: CrossAccountLab-CodePipelineRole
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: codepipeline.amazonaws.com
            Action: sts:AssumeRole
      Policies:
        - PolicyName: PipelineAccess
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action:
                  - s3:GetObject
                  - s3:PutObject
                  - s3:GetObjectVersion
                  - s3:GetBucketVersioning
                  - s3:ListBucket
                Resource:
                  - !GetAtt ArtifactBucket.Arn
                  - !Sub '${ArtifactBucket.Arn}/*'
              - Effect: Allow
                Action:
                  - codecommit:GetBranch
                  - codecommit:GetCommit
                  - codecommit:UploadArchive
                  - codecommit:GetUploadArchiveStatus
                Resource: !GetAtt CodeCommitRepo.Arn
              - Effect: Allow
                Action:
                  - codebuild:StartBuild
                  - codebuild:BatchGetBuilds
                Resource: !GetAtt CodeBuildProject.Arn
              - Effect: Allow
                Action:
                  - kms:Decrypt
                  - kms:GenerateDataKey
                Resource: !GetAtt PipelineKMSKey.Arn
              - Effect: Allow
                Action:
                  - sts:AssumeRole
                Resource: !Sub 'arn:aws:iam::${ProductionAccountId}:role/CrossAccountPipelineRole'

  # --- CodePipeline (Source + Build only) ---
  Pipeline:
    Type: AWS::CodePipeline::Pipeline
    Properties:
      Name: cross-account-app-pipeline
      RoleArn: !GetAtt CodePipelineRole.Arn
      ArtifactStore:
        Type: S3
        Location: !Ref ArtifactBucket
        EncryptionKey:
          Id: !GetAtt PipelineKMSKey.Arn
          Type: KMS
      Stages:
        - Name: Source
          Actions:
            - Name: CodeCommitSource
              ActionTypeId:
                Category: Source
                Owner: AWS
                Provider: CodeCommit
                Version: '1'
              OutputArtifacts:
                - Name: SourceOutput
              Configuration:
                RepositoryName: cross-account-app
                BranchName: main
                PollForSourceChanges: 'false'
        - Name: Build
          Actions:
            - Name: DockerBuild
              ActionTypeId:
                Category: Build
                Owner: AWS
                Provider: CodeBuild
                Version: '1'
              InputArtifacts:
                - Name: SourceOutput
              OutputArtifacts:
                - Name: BuildOutput
              Configuration:
                ProjectName: !Ref CodeBuildProject

  # --- EventBridge Rule to trigger pipeline on CodeCommit push ---
  EventBridgeRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: CrossAccountLab-EventBridgeRole
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: events.amazonaws.com
            Action: sts:AssumeRole
      Policies:
        - PolicyName: StartPipeline
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action: codepipeline:StartPipelineExecution
                Resource: !Sub 'arn:aws:codepipeline:${AWS::Region}:${AWS::AccountId}:${Pipeline}'

  CodeCommitPushRule:
    Type: AWS::Events::Rule
    Properties:
      Name: cross-account-app-pipeline-trigger
      EventPattern:
        source:
          - aws.codecommit
        detail-type:
          - CodeCommit Repository State Change
        resources:
          - !GetAtt CodeCommitRepo.Arn
        detail:
          event:
            - referenceCreated
            - referenceUpdated
          referenceType:
            - branch
          referenceName:
            - main
      Targets:
        - Id: CodePipelineTarget
          Arn: !Sub 'arn:aws:codepipeline:${AWS::Region}:${AWS::AccountId}:${Pipeline}'
          RoleArn: !GetAtt EventBridgeRole.Arn

Outputs:
  PipelineName:
    Value: !Ref Pipeline
  ArtifactBucketName:
    Value: !Ref ArtifactBucket
  ECRRepositoryUri:
    Value: !Sub '${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/cross-account-app'
  KMSKeyArn:
    Value: !GetAtt PipelineKMSKey.Arn
  CodePipelineRoleArn:
    Value: !GetAtt CodePipelineRole.Arn
  CodeCommitCloneUrl:
    Value: !GetAtt CodeCommitRepo.CloneUrlHttp
```

Deploy it:

```bash
aws cloudformation deploy \
  --template-file template-tooling.yaml \
  --stack-name cross-account-pipeline-tooling \
  --parameter-overrides ProductionAccountId=222222222222 \
  --capabilities CAPABILITY_NAMED_IAM
```

Once the stack is created, push the sample application to CodeCommit. Create these files:

**`index.mjs`:**

```javascript
import { createServer } from 'node:http';

const port = process.env.PORT ?? 3000;

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    message: 'Hello from cross-account deployment!',
    version: '1.0.0',
    account: process.env.AWS_ACCOUNT_ID ?? 'unknown'
  }));
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
```

**`Dockerfile`:**

```dockerfile
FROM public.ecr.aws/docker/library/node:24-alpine
WORKDIR /usr/src/app
COPY index.mjs ./
EXPOSE 3000
CMD ["node", "index.mjs"]
```

**`buildspec.yml`:**

```yaml
version: 0.2

phases:
  pre_build:
    commands:
      - echo Logging in to Amazon ECR...
      - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $ECR_REPO_URI
      - COMMIT_HASH=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c 1-7)
      - IMAGE_TAG=${COMMIT_HASH:-latest}
  build:
    commands:
      - echo Building the Docker image...
      - docker build -t $ECR_REPO_URI:latest .
      - docker tag $ECR_REPO_URI:latest $ECR_REPO_URI:$IMAGE_TAG
  post_build:
    commands:
      - echo Pushing the Docker images...
      - docker push $ECR_REPO_URI:latest
      - docker push $ECR_REPO_URI:$IMAGE_TAG
      - printf '[{"name":"cross-account-app-container","imageUri":"%s"}]' $ECR_REPO_URI:$IMAGE_TAG > imagedefinitions.json

artifacts:
  files: imagedefinitions.json
```

Push to CodeCommit:

> **Note:** The simplest way to clone a CodeCommit repository is to upload an SSH public key to your IAM user and clone using the SSH URL. See the [AWS documentation on setting up SSH connections to CodeCommit](https://docs.aws.amazon.com/codecommit/latest/userguide/setting-up-ssh-unixes.html) for instructions.

```bash
git clone ssh://git-codecommit.<REGION>.amazonaws.com/v1/repos/cross-account-app
cd cross-account-app

# Create the files above, then:
git add .
git commit -m "Initial commit - sample app"
git push origin main
```

Verify the pipeline runs successfully through the Build stage before moving on.

### Template B — Production Account

Deploy this in Account B. It creates:
- An ECS Cluster (Fargate)
- An ECS Service + Task Definition (starting with 0 tasks)
- An ECS Task Execution Role
- A security group allowing inbound traffic on port 3000

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: 'Cross-Account Pipeline Lab - Production Account (Account B)'

Parameters:
  ToolingAccountId:
    Type: String
    Description: 'The AWS Account ID of the tooling account (Account A)'
  VpcId:
    Type: AWS::EC2::VPC::Id
    Description: 'VPC to deploy the ECS service into'
  SubnetIds:
    Type: List<AWS::EC2::Subnet::Id>
    Description: 'Subnets for the ECS tasks (must have internet access)'

Resources:
  # --- Security Group ---
  ECSSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: 'Allow inbound HTTP on port 3000'
      VpcId: !Ref VpcId
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 3000
          ToPort: 3000
          CidrIp: 0.0.0.0/0

  # --- ECS Task Execution Role ---
  ECSTaskExecutionRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: CrossAccountLab-ECSTaskExecutionRole
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: ecs-tasks.amazonaws.com
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
      Policies:
        - PolicyName: CrossAccountECRPull
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action:
                  - ecr:GetDownloadUrlForLayer
                  - ecr:BatchGetImage
                  - ecr:BatchCheckLayerAvailability
                Resource: !Sub 'arn:aws:ecr:${AWS::Region}:${ToolingAccountId}:repository/cross-account-app'
              - Effect: Allow
                Action:
                  - ecr:GetAuthorizationToken
                Resource: '*'

  # --- ECS Cluster ---
  ECSCluster:
    Type: AWS::ECS::Cluster
    Properties:
      ClusterName: cross-account-prod-cluster

  # --- Task Definition ---
  TaskDefinition:
    Type: AWS::ECS::TaskDefinition
    Properties:
      Family: cross-account-app-task
      NetworkMode: awsvpc
      RequiresCompatibilities:
        - FARGATE
      Cpu: '256'
      Memory: '512'
      ExecutionRoleArn: !GetAtt ECSTaskExecutionRole.Arn
      ContainerDefinitions:
        - Name: cross-account-app-container
          Image: !Sub '${ToolingAccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/cross-account-app:latest'
          PortMappings:
            - ContainerPort: 3000
              Protocol: tcp

  # --- ECS Service ---
  ECSService:
    Type: AWS::ECS::Service
    Properties:
      ServiceName: cross-account-app-service
      Cluster: !Ref ECSCluster
      TaskDefinition: !Ref TaskDefinition
      DesiredCount: 0
      LaunchType: FARGATE
      NetworkConfiguration:
        AwsvpcConfiguration:
          AssignPublicIp: ENABLED
          SecurityGroups:
            - !Ref ECSSecurityGroup
          Subnets: !Ref SubnetIds

Outputs:
  ECSClusterName:
    Value: !Ref ECSCluster
  ECSServiceName:
    Value: !GetAtt ECSService.Name
  TaskExecutionRoleArn:
    Value: !GetAtt ECSTaskExecutionRole.Arn
  SecurityGroupId:
    Value: !Ref ECSSecurityGroup
```

Deploy it in the production account:

```bash
aws cloudformation deploy \
  --template-file template-production.yaml \
  --stack-name cross-account-pipeline-production \
  --parameter-overrides \
    ToolingAccountId=111111111111 \
    VpcId=vpc-xxxxxxxx \
    SubnetIds=subnet-aaaa,subnet-bbbb \
  --capabilities CAPABILITY_NAMED_IAM
```

> **Note:** Use subnets with internet access (either public subnets with a route to an Internet Gateway, or private subnets with a NAT Gateway). The ECS task needs internet access to pull the Docker image from ECR.

At this point you have:
- A working pipeline in the tooling account (Source → Build) with images landing in ECR
- An idle ECS service in the production account waiting for a deployment

Now let's connect them.

---

## Step 1: Update the KMS Key Policy

The CloudFormation template already created a KMS key with cross-account decrypt permissions. If you deployed the template exactly as shown, this step is already done. You can check the created key in the Key Management Service console > cross-account-pipeline-key in the Tooling account.

If you're working with an existing pipeline that uses the default S3 encryption, you need to create a Customer Managed Key and update its policy. Here's what that key policy looks like:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EnableToolingAccountAccess",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::111111111111:root" },
      "Action": "kms:*",
      "Resource": "*"
    },
    {
      "Sid": "AllowProductionAccountDecrypt",
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
```

The first statement gives full KMS access to the tooling account — this lets CodePipeline and CodeBuild encrypt artifacts. The second statement lets the production account decrypt those artifacts when it assumes the cross-account role.

> **Important:** When referencing this KMS key in cross-account pipeline configurations, always use the **key ARN** — not an alias. KMS aliases only resolve within the account that created them.

Then update the pipeline's `artifactStore` to use this key:

```bash
# Get the KMS Key ARN from the stack outputs
KMS_KEY_ARN=$(aws cloudformation describe-stacks \
  --stack-name cross-account-pipeline-tooling \
  --query "Stacks[0].Outputs[?OutputKey=='KMSKeyArn'].OutputValue" \
  --output text)

echo "KMS Key ARN: $KMS_KEY_ARN"
```

If you deployed Template A, the pipeline already references this KMS key. If you're adapting an existing pipeline, update the `artifactStore` section:

```json
"artifactStore": {
  "type": "S3",
  "location": "cross-account-pipeline-artifacts-111111111111",
  "encryptionKey": {
    "id": "<KMS_KEY_ARN>",
    "type": "KMS"
  }
}
```

## Step 2: Update the S3 Artifact Bucket Policy

The production account's cross-account role needs to read artifacts from S3. Even though we've granted KMS decrypt permissions, S3 has its own access layer.

Template A already includes this bucket policy. Here's what it grants:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowProductionAccountRead",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::222222222222:root" },
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion"
      ],
      "Resource": "arn:aws:s3:::cross-account-pipeline-artifacts-111111111111/*"
    },
    {
      "Sid": "AllowProductionAccountList",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::222222222222:root" },
      "Action": [
        "s3:GetBucketVersioning",
        "s3:ListBucket"
      ],
      "Resource": "arn:aws:s3:::cross-account-pipeline-artifacts-111111111111"
    }
  ]
}
```

A common mistake is only granting object-level permissions (`s3:GetObject`) but forgetting the bucket-level ones (`s3:ListBucket`, `s3:GetBucketVersioning`). You need both.

## Step 3: Create the Cross-Account IAM Role (Production Account)

This is the key piece. We create an IAM role in the production account that:
- Trusts the CodePipeline service role from the tooling account
- Has permissions to deploy to ECS, read S3 artifacts, and decrypt with KMS

Run these commands **in the production account (Account B)**:

```bash
# Create the trust policy
cat > cross-account-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::111111111111:role/CrossAccountLab-CodePipelineRole"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

aws iam create-role \
  --role-name CrossAccountPipelineRole \
  --assume-role-policy-document file://cross-account-trust-policy.json
```

Notice we trust the **specific CodePipeline role ARN**, not the entire account root. This means only CodePipeline (using that exact role) can assume into the production account. This is more secure than trusting `arn:aws:iam::111111111111:root`, which would let anyone in the tooling account with `sts:AssumeRole` permission cross the boundary.

Now add the permissions this role needs:

```bash
cat > cross-account-deploy-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ECSDeployPermissions",
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeServices",
        "ecs:DescribeTaskDefinition",
        "ecs:DescribeTasks",
        "ecs:ListTasks",
        "ecs:RegisterTaskDefinition",
        "ecs:UpdateService"
      ],
      "Resource": "*"
    },
    {
      "Sid": "PassECSTaskExecutionRole",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::222222222222:role/CrossAccountLab-ECSTaskExecutionRole"
    },
    {
      "Sid": "ReadArtifactsFromS3",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion"
      ],
      "Resource": "arn:aws:s3:::cross-account-pipeline-artifacts-111111111111/*"
    },
    {
      "Sid": "DecryptArtifacts",
      "Effect": "Allow",
      "Action": [
        "kms:Decrypt",
        "kms:DescribeKey"
      ],
      "Resource": "<KMS_KEY_ARN>"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name CrossAccountPipelineRole \
  --policy-name CrossAccountDeployAccess \
  --policy-document file://cross-account-deploy-policy.json
```

Replace `<KMS_KEY_ARN>` with the actual KMS key ARN from your tooling account stack outputs.

The `iam:PassRole` permission is required because when CodePipeline registers a new task definition, it needs to pass the Task Execution Role to ECS. Without this, the deployment will fail with an "AccessDenied" error on `RegisterTaskDefinition`.

## Step 4: Grant ECR Cross-Account Pull Access

When ECS in the production account runs a task, it needs to pull the Docker image from ECR in the tooling account. We need to grant the production account permission to pull images.

Template A already includes an ECR repository policy that allows this. Here's what it looks like:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowProductionAccountPull",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::222222222222:root"
      },
      "Action": [
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:BatchCheckLayerAvailability"
      ]
    }
  ]
}
```

If you're adding this to an existing ECR repository, apply it with:

```bash
# Run this in the TOOLING account
aws ecr set-repository-policy \
  --repository-name cross-account-app \
  --policy-text '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "AllowProductionAccountPull",
        "Effect": "Allow",
        "Principal": {
          "AWS": "arn:aws:iam::222222222222:root"
        },
        "Action": [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:BatchCheckLayerAvailability"
        ]
      }
    ]
  }'
```

The production account's ECS Task Execution Role also needs `ecr:GetAuthorizationToken` — this is already included in the `AmazonECSTaskExecutionRolePolicy` managed policy that Template B attaches.

> **For larger organizations:** Instead of cross-account pull, consider using ECR replication. You configure a replication rule on the tooling account's registry to automatically copy images to the production account's own ECR. This removes the runtime dependency on cross-account network calls and gives each account full ownership of its images. See the [ECR replication docs](https://docs.aws.amazon.com/AmazonECR/latest/userguide/replication.html) for setup.

## Step 5: Add the Cross-Account Deploy Stage to the Pipeline

Now we wire it all together. Back in the **tooling account**, we add a Deploy stage to the pipeline that assumes the cross-account role and deploys to ECS in the production account.

Get the current pipeline definition:

```bash
aws codepipeline get-pipeline --name cross-account-app-pipeline > pipeline.json
```

Edit `pipeline.json` and add a third stage after the Build stage:

```json
{
  "name": "Deploy-Production",
  "actions": [
    {
      "name": "DeployToECS",
      "actionTypeId": {
        "category": "Deploy",
        "owner": "AWS",
        "provider": "ECS",
        "version": "1"
      },
      "inputArtifacts": [
        { "name": "BuildOutput" }
      ],
      "configuration": {
        "ClusterName": "cross-account-prod-cluster",
        "ServiceName": "cross-account-app-service",
        "FileName": "imagedefinitions.json"
      },
      "roleArn": "arn:aws:iam::222222222222:role/CrossAccountPipelineRole"
    }
  ]
}
```

The key here is the `roleArn` at the **action level**. This tells CodePipeline: "When executing this specific action, assume the `CrossAccountPipelineRole` in the production account." The pipeline's own `roleArn` (at the top level) stays the same — it's the pipeline's service role in the tooling account.

This is how CodePipeline handles cross-account actions. The pipeline role in the tooling account uses `sts:AssumeRole` to become the cross-account role, and then executes the ECS deploy action with the production account's permissions.

Also remove the `metadata` field from the JSON (CodePipeline adds it on export but rejects it on import), then update the pipeline:

```bash
aws codepipeline update-pipeline --cli-input-json file://pipeline.json
```

## Step 6: Grant the Pipeline Role Permission to Assume the Cross-Account Role

Template A already includes the `sts:AssumeRole` permission on the cross-account role. If you're adapting an existing pipeline, you need to explicitly allow the CodePipeline service role to assume into the production account:

```bash
# Run this in the TOOLING account
aws iam put-role-policy \
  --role-name CrossAccountLab-CodePipelineRole \
  --policy-name AssumeProductionRole \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": "sts:AssumeRole",
        "Resource": "arn:aws:iam::222222222222:role/CrossAccountPipelineRole"
      }
    ]
  }'
```

Without this, the pipeline will fail at the Deploy stage with "Unable to assume role."

## Testing the Deployment

Everything is connected. Let's trigger a deployment.

First, scale up the ECS service in the production account so it actually runs tasks:

```bash
# Run in the PRODUCTION account
aws ecs update-service \
  --cluster cross-account-prod-cluster \
  --service cross-account-app-service \
  --desired-count 1
```

Now push a code change in the tooling account to trigger the pipeline:

```bash
# Run in the TOOLING account, inside the cross-account-app repo
echo "// Deployed at $(date)" >> index.mjs
git add . && git commit -m "Trigger cross-account deployment"
git push origin main
```

Watch the pipeline progress:

```bash
aws codepipeline get-pipeline-state --name cross-account-app-pipeline \
  --query 'stageStates[*].{Stage:stageName,Status:latestExecution.status}' \
  --output table
```

You should see Source → Build → Deploy-Production all succeed. Once the deploy stage completes, ECS will roll out a new task with the updated image.

Verify the deployment in the production account:

```bash
# Get the task public IP (run in PRODUCTION account)
TASK_ARN=$(aws ecs list-tasks \
  --cluster cross-account-prod-cluster \
  --service-name cross-account-app-service \
  --query "taskArns[0]" --output text)

ENI_ID=$(aws ecs describe-tasks \
  --cluster cross-account-prod-cluster \
  --tasks $TASK_ARN \
  --query "tasks[0].attachments[0].details[?name=='networkInterfaceId'].value" \
  --output text)

PUBLIC_IP=$(aws ec2 describe-network-interfaces \
  --network-interface-ids $ENI_ID \
  --query "NetworkInterfaces[0].Association.PublicIp" \
  --output text)

echo "App running at: http://$PUBLIC_IP:3000"
```

Visit the URL and you should see the JSON response from your app — running in the production account, deployed from the tooling account's pipeline.

![Cross Account Deploy](cross-account-deploy.png)

## Security Considerations

The setup above works, but for production use, tighten things up:

- **Scope down ECS permissions.** Replace `"Resource": "*"` on ECS actions with the specific cluster and service ARNs.
- **Trust specific role ARNs, not account root.** We already do this by trusting `CrossAccountLab-CodePipelineRole` specifically rather than `arn:aws:iam::111111111111:root`.
- **Audit with CloudTrail.** Enable CloudTrail in both accounts. Every `AssumeRole` call is logged, giving you a clear audit trail of cross-account deployments.
- **Use SCPs if you have AWS Organizations.** Service Control Policies can restrict which accounts are allowed to be deployment targets.
- **Keep `iam:PassRole` narrow.** Only allow passing the specific ECS Task Execution Role — never use `*` for PassRole resources.

## Clean Up

To avoid charges, tear down both accounts' resources in order.

**Production Account (Account B):**

```bash
# Scale down the service first
aws ecs update-service \
  --cluster cross-account-prod-cluster \
  --service cross-account-app-service \
  --desired-count 0

# Wait for tasks to drain, then delete the stack
aws cloudformation delete-stack --stack-name cross-account-pipeline-production

# Delete the manually-created cross-account role
aws iam delete-role-policy \
  --role-name CrossAccountPipelineRole \
  --policy-name CrossAccountDeployAccess
aws iam delete-role --role-name CrossAccountPipelineRole

# Clean up local files
rm -f cross-account-trust-policy.json cross-account-deploy-policy.json
```

**Tooling Account (Account A):**

```bash
# Delete the pipeline first (it may block stack deletion)
aws codepipeline delete-pipeline --name cross-account-app-pipeline

# Empty and delete the artifact bucket (versioned — must remove all versions)
BUCKET_NAME=$(aws cloudformation describe-stacks \
  --stack-name cross-account-pipeline-tooling \
  --query "Stacks[0].Outputs[?OutputKey=='ArtifactBucketName'].OutputValue" \
  --output text)
aws s3api list-object-versions --bucket $BUCKET_NAME \
  --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' \
  --output json | aws s3api delete-objects --bucket $BUCKET_NAME --delete file:///dev/stdin
aws s3api list-object-versions --bucket $BUCKET_NAME \
  --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' \
  --output json | aws s3api delete-objects --bucket $BUCKET_NAME --delete file:///dev/stdin
aws s3 rb s3://$BUCKET_NAME

# Delete ECR images
aws ecr delete-repository --repository-name cross-account-app --force

# Delete the stack
aws cloudformation delete-stack --stack-name cross-account-pipeline-tooling

# Clean up local files
rm -f pipeline.json pipeline-updated.json
```

## Conclusion

Cross-account deployment with CodePipeline comes down to three things:

1. A **KMS Customer Managed Key** shared between accounts so artifacts can be encrypted and decrypted across the boundary.
2. An **S3 bucket policy** allowing the production account to read pipeline artifacts.
3. An **IAM role in the production account** that trusts the tooling account's pipeline role and has deploy permissions.

Once these pieces are in place, the pipeline's deploy action simply assumes the cross-account role and does its work as if it were local.

This pattern scales naturally. Need a staging account? Add another role and another deploy stage. Need three regions? Replicate the pattern per-region. Want to automate role creation across many accounts? Look into [CloudFormation StackSets](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/what-is-cfnstacksets.html).

The hardest part isn't the code — it's getting the IAM trust chain right. When something fails, check the trust policy first. It's almost always the trust policy.

Interested in deploying your application across multiple AWS accounts? [Let's talk](mailto:hector@agilityfeat.com)
