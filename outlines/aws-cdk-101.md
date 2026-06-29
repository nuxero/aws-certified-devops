# Outline: AWS CDK 101

## Working Title

**AWS CDK 101: Infrastructure as Actual Code — From First App to Production Deploy**

---

## Target Audience

DevOps engineers and developers who know CloudFormation (or at least understand the concept of declaring infrastructure) and want to use a real programming language instead of YAML. Also targeting DOP-C02 exam candidates — CDK construct levels (L1/L2/L3), the synth-diff-deploy workflow, CDK Pipelines, and the relationship between CDK and CloudFormation are directly tested.

---

## Core Premise

CDK lets you define infrastructure with TypeScript, Python, Java, C#, or Go instead of YAML/JSON. But it's not just "CloudFormation with better syntax" — it gives you loops, conditionals, abstractions, type safety, IDE autocomplete, and unit testing for your infrastructure. This post takes you from zero to a deployed application, explaining every concept along the way: constructs at all three levels, the CDK app lifecycle, and the critical insight that CDK is a CloudFormation generator.

---

## Self-Contained Post Requirements

- All code inline (TypeScript CDK code, CLI commands, generated CloudFormation snippets)
- Each code snippet preceded by a paragraph explaining what the code does, with inline comments referencing the explanation
- Mermaid diagrams showing the CDK app structure (App → Stacks → Constructs) and the synth/deploy pipeline
- A complete CDK project that builds real infrastructure (Lambda + API Gateway + DynamoDB + S3)
- Side-by-side comparison of CDK TypeScript vs. equivalent CloudFormation YAML for key resources
- Show generated CloudFormation to reinforce the "CDK generates CloudFormation" mental model

---

## Post Structure

### 1. Introduction — Why CDK?

- CloudFormation YAML works but has pain points: verbose, no loops, no type checking, copy-paste reuse, hard to test
- CDK solves these by letting you use a programming language — but the output is still CloudFormation
- The key mental model: CDK is a CloudFormation code generator. `cdk synth` produces a CloudFormation template. `cdk deploy` = `synth` + `create-stack`/`update-stack`
- This means all CloudFormation concepts still apply: stacks, change sets, drift, rollback, stack policies
- CDK doesn't replace CloudFormation knowledge — it builds on top of it

### 2. Setup — Bootstrap and Initialize

- Prerequisites: Node.js 18+, AWS CLI configured, `npm install -g aws-cdk`
- `cdk bootstrap` — what it does: deploys a "CDKToolkit" stack with an S3 bucket for assets, ECR repo for Docker images, and IAM roles for deployment. One-time per account/Region.
- `cdk init app --language typescript` — project structure overview
- Key files: `bin/app.ts` (entry point, instantiates the App), `lib/*-stack.ts` (stack definitions), `cdk.json` (project config), `package.json`
- The App → Stack → Construct tree hierarchy

### 3. Constructs — The Building Blocks

#### 3.1 The Three Levels

- **L1 (CFN resources)**: direct 1:1 mapping to CloudFormation resources. Prefix: `Cfn*` (e.g., `CfnBucket`). No defaults, no helper methods. Use when L2 doesn't expose a property you need.
- **L2 (Curated constructs)**: opinionated abstractions with sensible defaults and grant methods. One CDK class maps to 1+ CloudFormation resources. (e.g., `s3.Bucket` = bucket + bucket policy + optional lifecycle rules)
- **L3 (Patterns)**: multi-resource architectures in one construct. (e.g., `LambdaRestApi` = API Gateway + Lambda integration + permissions + stage + deployment)
- Show the same S3 bucket at all three levels: L1 is verbose with all properties spelled out, L2 has smart defaults and `grantRead()`, L3 doesn't exist for a bare bucket but does for patterns like `StaticWebsite`

#### 3.2 The Construct Tree

- Every construct has a scope (parent) and an id (unique within scope)
- IDs become part of the CloudFormation logical ID — changing them causes resource replacement
- The tree: App → Stack → Construct → child constructs
- `this` in a stack constructor is the stack itself — constructs you create inside it become children

#### 3.3 How CDK Generates Logical IDs

- CDK hashes the construct path to produce a CloudFormation logical ID
- This means renaming a construct (changing its `id`) causes CloudFormation to see it as a new resource → replacement
- `overrideLogicalId()` to maintain backward compatibility during refactoring

### 4. Building the Application — Lambda + API Gateway + DynamoDB + S3

#### 4.1 DynamoDB Table (L2)

- `dynamodb.Table` with partition key, PAY_PER_REQUEST billing
- `removalPolicy: DESTROY` for lab cleanup (default is RETAIN for stateful resources)
- Show the generated CloudFormation snippet — one CDK line becomes ~15 lines of YAML

#### 4.2 S3 Bucket (L2)

- `s3.Bucket` with versioning, encryption, lifecycle rules
- `autoDeleteObjects: true` — CDK automatically creates a custom resource Lambda to empty the bucket on deletion (the same pattern from Post #3, but handled for you)
- `grantRead(fn)` — CDK writes the IAM policy for you

#### 4.3 Lambda Function (L2)

- `lambda.Function` with runtime, handler, code source (inline, fromAsset, fromBucket)
- Environment variables wiring: `TABLE_NAME: table.tableName`
- Show how CDK passes dynamic references (table name, bucket name) without hardcoding

#### 4.4 API Gateway (L3 Pattern)

- `apigateway.LambdaRestApi` — one line creates REST API + integration + permissions + stage
- Proxy mode vs. defined routes
- Show the generated CloudFormation: the L3 construct produces 8+ CloudFormation resources

#### 4.5 IAM — The Grant Pattern

- `table.grantReadWriteData(fn)` generates a scoped IAM policy automatically
- `bucket.grantRead(fn)` — only read permissions, least privilege by default
- Compare to writing IAM policies by hand in CloudFormation: 15+ lines of policy JSON vs. one CDK method call
- CDK's `grant*` methods are the killer feature for IAM correctness

### 5. The CDK Workflow — Synth, Diff, Deploy

#### 5.1 `cdk synth`

- Generates the CloudFormation template in `cdk.out/`
- Inspect the template: see what CDK actually produces
- This is where you validate — if the generated template looks wrong, the CDK code has a bug
- `cdk synth` doesn't touch AWS — it's pure local code execution

#### 5.2 `cdk diff`

- Compares the synthesized template against the currently deployed stack
- Shows additions, modifications, deletions — like a change set preview
- Highlights security-related changes (IAM policy modifications, security group rule changes)
- Run this before every deploy to avoid surprises

#### 5.3 `cdk deploy`

- Synthesizes + uploads assets to the bootstrap bucket + creates/executes a CloudFormation change set
- `--require-approval` flag: `never`, `broadening` (new IAM permissions), `any-change`
- `--hotswap` for development: bypasses CloudFormation for Lambda code changes (faster, not for production)
- Outputs are printed after deployment (API URL, bucket name, etc.)

### 6. CDK Context and Environment

#### 6.1 Stack Environment

- `env: { account: '123456789012', region: 'us-east-1' }` — makes the stack environment-aware
- Without `env`: environment-agnostic stack, resolved at deploy time
- With `env`: enables Availability Zone lookups, VPC lookups, and cross-stack references

#### 6.2 Context Values

- `cdk.json` context for static values
- `-c key=value` for CLI-provided values
- `this.node.tryGetContext('key')` to read in code
- Context is cached in `cdk.context.json` — commit this to source control for reproducible deployments

### 7. CDK vs. CloudFormation vs. SAM — When to Use What

| Aspect | CloudFormation (YAML) | SAM | CDK |
|--------|----------------------|-----|-----|
| Language | YAML/JSON | YAML (with transforms) | TypeScript, Python, Java, C#, Go |
| Abstraction level | Low (1:1 with AWS resources) | Medium (serverless shortcuts) | High (L2/L3 constructs) |
| IDE support | Limited (schema validation) | Limited | Full (autocomplete, type checking, refactoring) |
| Testing | cfn-lint, TaskCat | sam local invoke | Jest/pytest unit tests on constructs |
| Learning curve | Moderate (learn YAML + all resource properties) | Low (if you know CloudFormation) | Higher (learn CDK framework + programming language patterns) |
| Best for | Teams standardized on YAML, simple stacks | Serverless-focused teams | Complex infrastructure, teams with strong dev skills |
| Reuse | Copy-paste or nested stacks | Layers, nested apps | npm/pip packages, custom constructs |

### 8. Assets and Bundling

- `lambda.Code.fromAsset('./src')` — CDK zips the directory and uploads to the bootstrap S3 bucket
- Docker-based bundling: `NodejsFunction` runs `esbuild` in a Docker container to bundle TypeScript Lambda code
- S3 assets: `s3_assets.Asset` uploads a file/directory to S3, provides the bucket/key as properties
- The bootstrap bucket stores all assets — this is why `cdk bootstrap` is required

### 9. Making Changes — The Update Cycle

- Modify the CDK code (add a CloudWatch alarm to the Lambda)
- `cdk diff` — see exactly what will be added (no existing resources modified)
- `cdk deploy` — apply the change
- Show the iterative workflow: code → diff → deploy → verify → repeat
- Explain that CDK uses CloudFormation change sets under the hood — same safety guarantees

### 10. CDK Pipelines (Exam Topic Overview)

- CDK Pipelines: a self-mutating CI/CD pipeline defined in CDK
- The pipeline deploys your CDK app — and also updates itself when the pipeline code changes
- Structure: Source → Synth → Self-Mutate → Deploy stages
- Key concept: the pipeline is defined in CDK code alongside your infrastructure
- Cross-account deployment: pipeline in tooling account, deploys stacks to dev/staging/prod accounts
- This is a high-frequency DOP-C02 exam topic — know that CDK Pipelines self-mutates and can deploy across accounts

### 11. Clean Up

- `cdk destroy` — deletes the CloudFormation stack and all resources
- `--force` flag skips confirmation prompt
- Stateful resources with `removalPolicy: RETAIN` survive destruction — be aware
- The bootstrap stack (`CDKToolkit`) can be left in place for future CDK use

### 12. Conclusion

- CDK is a CloudFormation generator, not a replacement — understanding CloudFormation makes you better at CDK
- Three construct levels: L1 (raw), L2 (opinionated + grants), L3 (multi-resource patterns)
- The workflow: `synth` (generate template) → `diff` (preview changes) → `deploy` (apply via CloudFormation)
- Grant methods (`grantReadWriteData`, `grantRead`) produce least-privilege IAM automatically
- CDK Pipelines enables self-mutating cross-account deployment
- DOP-C02 exam tips: know construct levels, know that CDK synthesizes to CloudFormation, know CDK Pipelines is self-mutating, know that changing a construct ID causes resource replacement

---

## Key Diagrams

1. CDK app structure: App → Stack → L2/L3 Constructs → L1 (generated) → CloudFormation template
2. The synth/deploy pipeline: CDK code → `cdk synth` → CloudFormation template → `cdk deploy` → AWS resources
3. Construct levels comparison: L1 verbose vs. L2 concise vs. L3 one-liner
4. CDK Pipelines: Source → Synth → Self-Mutate → Deploy (dev) → Deploy (prod)

---

## Sources & References

- [AWS CDK v2 Developer Guide — Constructs](https://docs.aws.amazon.com/cdk/v2/guide/constructs.html)
- [Create or extend constructs — AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/best-practices-cdk-typescript-iac/constructs-best-practices.html)
- [AWS CDK v2 Developer Guide — Working with the CDK](https://docs.aws.amazon.com/cdk/v2/guide/work-with.html)
- [Getting started with the AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/getting-started.html)
- [CDK Pipelines: Continuous delivery for AWS CDK applications](https://docs.aws.amazon.com/cdk/v2/guide/cdk_pipeline.html)
- [AWS CDK API Reference](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-construct-library.html)
- [Streamlining multi-account infrastructure with StackSets and CDK — AWS DevOps Blog](https://aws.amazon.com/blogs/devops/streamlining-multi-account-infrastructure-with-aws-cloudformation-stacksets-and-aws-cdk/)
