# Amazon ECR Deep Dive Lab

Companion lab files for the blog post [Amazon ECR Beyond the Basics: Scanning, Lifecycle Policies, and Multi-Region Replication](https://hectorzelaya.dev/posts/ecr-deep-dive).

## What's Included

| File | Purpose |
|------|---------|
| `prerequisites.yaml` | CloudFormation template — creates ECR repository, CodeBuild project, S3 bucket, IAM role |
| `Dockerfile` | Multi-stage Node.js build using `node:18` (intentionally old for scanning demos) |
| `app.js` | Minimal HTTP server with a `/health` endpoint |
| `package.json` | Application dependencies |
| `buildspec.yml` | CodeBuild spec — builds, pushes, scans, and gates on CRITICAL vulnerabilities |

## Prerequisites

- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) configured with permissions for CloudFormation, ECR, CodeBuild, S3, and IAM
- [Docker](https://docs.docker.com/get-docker/) (optional — CodeBuild handles builds if you prefer)

## Quick Start

```bash
# 1. Deploy the infrastructure
aws cloudformation deploy \
  --template-file prerequisites.yaml \
  --stack-name ecr-deep-dive-lab \
  --capabilities CAPABILITY_NAMED_IAM

# 2. Package and upload build context
npm install
zip build-context.zip Dockerfile app.js package.json package-lock.json buildspec.yml

BUCKET=$(aws cloudformation describe-stacks \
  --stack-name ecr-deep-dive-lab \
  --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' \
  --output text)

aws s3 cp build-context.zip s3://$BUCKET/build-context.zip

# 3. Trigger a build
aws codebuild start-build --project-name ecr-deep-dive-build
```

## Clean Up

```bash
# Empty the S3 bucket
BUCKET=$(aws cloudformation describe-stacks \
  --stack-name ecr-deep-dive-lab \
  --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' \
  --output text)

aws s3 rm s3://$BUCKET --recursive

# Force-delete the ECR repository (removes all images)
aws ecr delete-repository --repository-name ecr-deep-dive-app --force

# Delete the stack
aws cloudformation delete-stack --stack-name ecr-deep-dive-lab
aws cloudformation wait stack-delete-complete --stack-name ecr-deep-dive-lab
```

## License

MIT
