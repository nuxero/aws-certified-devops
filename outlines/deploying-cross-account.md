# Outline: Deploying an Application Across Multiple AWS Accounts Using CodePipeline

## Working Title

**Deploying an Application Across Multiple AWS Accounts Using CodePipeline**

---

## Target Audience

AWS practitioners who already have a working single-account CI/CD pipeline and want to extend it to deploy into a separate AWS account (e.g., a production account managed by a different team).

---

## Core Premise

Most real-world organizations separate their AWS environments into multiple accounts (dev, staging, production) for security isolation and blast-radius reduction. This post teaches readers how to extend an existing single-account CodePipeline to deploy a containerized application into a different AWS account — covering the IAM trust relationships, KMS encryption sharing, and S3 artifact access that make it work.

---

## Post Structure

### 1. Introduction

- Why multi-account is the norm in production AWS environments (security boundaries, billing isolation, least privilege)
- What this post covers: taking an existing pipeline in Account A (Tooling) and deploying to Account B (Production)
- What the reader will have by the end: a cross-account ECS Fargate deployment triggered from their tooling account

### 2. Architecture Overview

- Mermaid code for a Diagram showing the two-account architecture:
  - **Tooling Account (Account A):** CodePipeline, CodeBuild, ECR, S3 artifact bucket, KMS key
  - **Production Account (Account B):** ECS Cluster + Service, cross-account IAM role
- Explain the three pillars that make cross-account work:
  1. A KMS key shared between accounts (encrypts/decrypts pipeline artifacts)
  2. An S3 bucket policy allowing the target account to read artifacts
  3. An IAM role in the target account that trusts the tooling account
- Brief mention of the artifact flow: CodeBuild pushes image to ECR → pipeline stores artifacts (encrypted with KMS) in S3 → production account assumes role, decrypts artifacts, deploys to ECS
- **Note on artifact limitations:** an artifact can only be consumed cross-account if it was produced in the pipeline account — you cannot pass artifacts between two non-pipeline accounts. ([source](https://docs.aws.amazon.com/codepipeline/latest/userguide/pipelines-create-cross-account.html))

### 3. Prerequisites — Two CloudFormation Templates

- Explanation: to focus entirely on cross-account setup, we provide two CloudFormation templates — one per account — that create the baseline infrastructure
- **Note:** reader needs two AWS accounts. If they only have one, they can follow along conceptually.

#### Template A — Tooling Account (Account A)

- Deploy this first in the tooling account
- What it provisions:
  - CodeCommit repository with sample application code (Node.js + Dockerfile, similar to existing blog post)
  - ECR repository
  - CodeBuild project (with buildspec that builds Docker image and generates imagedefinitions.json)
  - S3 artifact bucket (with versioning enabled)
  - KMS key for artifact encryption (ready for cross-account policy addition later)
  - CodePipeline (Source → Build) — no deploy stage yet, that's what the post adds
  - Required IAM roles (CodeBuild service role, CodePipeline service role)
- Outputs: Pipeline name, Artifact bucket name, ECR repository URI, KMS key ARN, CodePipeline role ARN

#### Template B — Production Account (Account B)

- Deploy this in the production account
- What it provisions:
  - ECS Cluster (Fargate)
  - ECS Service + Task Definition (desired count 0, placeholder image)
  - ECS Task Execution Role (with ECR pull and CloudWatch Logs permissions)
  - Security group for the ECS tasks (port 3000 inbound)
- Parameters: VPC ID, Subnet IDs (reader provides from their production account's networking)
- Outputs: ECS Cluster name, Service name, Task Execution Role ARN

#### Post-template verification

- Verify Template A: pipeline triggers on commit, build succeeds, image lands in ECR
- Verify Template B: ECS cluster exists, service is at 0 tasks (waiting for cross-account wiring)

### 4. Step 1 — Create a KMS Customer Managed Key for Cross-Account Artifact Encryption

- Why: CodePipeline encrypts artifacts in S3. The production account must decrypt them to read pipeline artifacts.
- **Critical:** The default `aws/s3` managed key **cannot** be used for cross-account — AWS docs explicitly state "You must use a KMS customer managed key for cross-account deployments. If the key isn't configured, CodePipeline encrypts the objects with default encryption, which can't be decrypted by the role in the destination account." ([source](https://aws.amazon.com/premiumsupport/knowledge-center/codepipeline-artifacts-s3/))
- Create the KMS key with a key policy granting:
  - Full access to the tooling account (for CodePipeline/CodeBuild to encrypt)
  - `kms:Decrypt` + `kms:DescribeKey` to the production account
- Update the pipeline's `artifactStore` to include `encryptionKey` with the KMS key ARN
- **Important:** For cross-account actions, you can only reference the KMS key by key ID or key ARN — **aliases do not work cross-account** ([source](https://docs.aws.amazon.com/codepipeline/latest/userguide/pipelines-create-cross-account.html))
- CLI commands + explanation of each policy statement

### 5. Step 2 — Update the S3 Artifact Bucket Policy

- Why: even with KMS decrypt permission, the production account needs S3-level read access to the artifact objects
- Add a bucket policy granting the production account:
  - `s3:GetObject`, `s3:GetObjectVersion` on bucket objects
  - `s3:GetBucketVersioning`, `s3:ListBucket` on the bucket itself
- CLI command + explanation
- Common pitfall: forgetting to allow both bucket-level AND object-level permissions

### 6. Step 3 — Create the Cross-Account IAM Role (in Production Account)

- Switch context: these commands run in Account B (Production)
- Create an IAM role (`CrossAccountPipelineRole`) with:
  - Trust policy allowing the **CodePipeline service role ARN from the Tooling Account** to assume it (more secure than trusting account root)
  - Permissions to:
    - Deploy to ECS (`ecs:UpdateService`, `ecs:DescribeServices`, `ecs:DescribeTaskDefinition`, `ecs:RegisterTaskDefinition`, `ecs:ListTasks`, `ecs:DescribeTasks`)
    - Pass the ECS Task Execution Role (`iam:PassRole` on the task execution role — required for RegisterTaskDefinition)
    - Read from S3 artifact bucket (`s3:GetObject`, `s3:GetObjectVersion` on the tooling account bucket)
    - Decrypt with the shared KMS key (`kms:Decrypt`, `kms:DescribeKey`)
- CLI commands for role creation + inline policies
- Explain the principle: the production account explicitly opts-in to being deployed to
- **Important:** the trust policy should reference the specific CodePipeline role ARN rather than account root for production use. Misconfigured trust policies are the most frequent source of cross-account pipeline failures ([source](https://kindatechnical.com/aws-codepipeline/cross-account-pipelines.html))

### 7. Step 4 — Grant ECR Cross-Account Pull Access

- The ECS task in the production account needs to pull the Docker image from ECR in the tooling account
- Two approaches:
  - **Option A (simpler):** Add a **repository policy** on ECR in the tooling account allowing the production account's ECS Task Execution Role to pull. Required actions: `ecr:GetDownloadUrlForLayer`, `ecr:BatchGetImage`, `ecr:BatchCheckLayerAvailability` ([source](https://repost.aws/knowledge-center/secondary-account-access-ecr))
  - **Option B (more isolated):** Use **ECR cross-account replication** — configure a replication rule on the tooling account's registry to replicate images to the production account's ECR. Note: cross-account replication only requires a registry policy on the destination account ([source](https://docs.aws.amazon.com/AmazonECR/latest/userguide/replication.html))
- Show Option A with CLI commands (repository policy)
- Also note: the production account's ECS Task Execution Role must have `ecr:GetAuthorizationToken` in its own account and the cross-account pull permissions granted by the repository policy
- Mention Option B as the production-grade approach for larger organizations (better isolation, no cross-account network dependency at runtime)

### 8. Step 5 — Update the Pipeline with a Cross-Account Deploy Stage

- Back in the Tooling Account
- Add a new pipeline stage that:
  - Uses the `roleArn` field **at the action level** to assume the cross-account role in Account B
  - Deploys to the ECS cluster/service in the production account
- Show the updated `pipeline.json` snippet for the cross-account deploy action
- Update the pipeline via CLI
- **Key distinction:** the action-level `roleArn` tells CodePipeline to assume that role when executing *this specific action*. The pipeline-level `roleArn` is the pipeline's own service role in the tooling account. Cross-account actions use the action-level roleArn to assume into the target account.
- **Artifact limitation:** an action can only consume an artifact if (a) the action is in the same account as the pipeline, OR (b) the artifact was created in the pipeline account. You cannot pass artifacts between two non-pipeline accounts. ([source](https://docs.aws.amazon.com/codepipeline/latest/userguide/pipelines-create-cross-account.html))

### 9. Step 6 — Update CodePipeline Service Role

- The CodePipeline service role in the tooling account needs `sts:AssumeRole` permission on the cross-account role
- Add an inline policy granting `sts:AssumeRole` on `arn:aws:iam::<PROD_ACCOUNT>:role/CrossAccountPipelineRole`
- CLI command

### 10. Testing the Cross-Account Deployment

- Push a code change to trigger the pipeline
- Observe the pipeline stages in the console
- Verify the ECS service in the production account updates with the new task definition
- Troubleshooting tips:
  - "Access Denied" on S3 → check bucket policy
  - "Access Denied" on KMS → check key policy includes the production account
  - "Unable to assume role" → check trust policy in production account
  - "Cannot pull image" → check ECR repository policy

### 11. Security Considerations

- Scope down the cross-account role to minimum permissions (don't use `*` resources in production)
- Use a specific IAM role ARN in the trust policy instead of the account root — this limits who in the tooling account can actually trigger cross-account deployments
- Add a condition key (`aws:SourceAccount` or `sts:ExternalId`) for extra protection if desired
- Enable CloudTrail in both accounts to audit cross-account `AssumeRole` calls
- Consider SCPs (Service Control Policies) if using AWS Organizations to restrict which accounts can be deployment targets
- Note: `iam:PassRole` in the cross-account role is necessary for ECS task definition registration but should be scoped to the specific ECS Task Execution Role ARN

### 12. Clean Up

- Delete resources in order: pipeline stage → cross-account role (prod account) → KMS key scheduling → bucket policy revert → ECR policy revert
- Delete both CloudFormation stacks: Template B in production first, then Template A in tooling
- Reminder to check both accounts

### 13. Conclusion

- Recap: the three pillars (KMS, S3 policy, IAM cross-account role) are what make it work
- This pattern scales to N accounts (staging, production, DR) by adding roles and stages
- Next steps: automate the cross-account role creation with CloudFormation StackSets, add manual approval gates per environment

---

## Key Diagrams Needed

1. **Two-account architecture diagram** — mermaid code showing artifact flow, role assumption, and trust boundaries
2. **IAM trust relationship diagram** — mermaid code visualizing who trusts whom and what permissions flow where

---

## CloudFormation Templates Scope

### Template A — Tooling Account

Outputs:
- Pipeline name
- Artifact bucket name
- ECR repository URI
- CodeBuild project name
- KMS key ARN
- CodePipeline service role ARN

Parameters:
- Notification email for approval stage (optional)

### Template B — Production Account

Outputs:
- ECS cluster name
- ECS service name
- Task Execution Role ARN
- Security Group ID

Parameters:
- VPC ID
- Subnet IDs (comma-separated list)
- Tooling Account ID (used to pre-scope trust if desired)

---

## Tone & Style Notes

- Match the existing blog post: direct, practical, explain *why* before showing *how*
- Use `bash` code blocks for all CLI commands
- Show JSON inline for policies and configurations
- Call out common exam/interview pitfalls as tips
- Keep it focused — the reader already has a working pipeline, we're only adding the cross-account layer
