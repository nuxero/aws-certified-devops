# Outline: Lambda Deployments — SAM, CodeDeploy, and Safe Traffic Shifting

## Working Title

**Deploying Lambda Functions Safely: SAM, CodeDeploy, Canary Strategies, and Automatic Rollback**

---

## Target Audience

Developers and DevOps engineers deploying Lambda functions in production who need to understand gradual traffic shifting, pre-traffic validation, alarm-based rollback, and how SAM/CodeDeploy/CodePipeline work together. Also targeting DOP-C02 exam candidates — Lambda + CodeDeploy canary deployments are directly tested.

---

## Core Premise

Lambda functions are immutable once published — you can't "roll back" a version, only shift traffic away from it. This makes deployment safety entirely about *how you shift traffic*: all at once (risky), gradually with validation (safe), or with automatic rollback on alarm (production-grade). This post covers the full spectrum: the raw mechanics of Lambda versions and aliases, how CodeDeploy manages canary/linear traffic shifting, how SAM automates the entire workflow with `DeploymentPreference`, and when to use CodePipeline V2's native Lambda deploy action instead.

---

## Self-Contained Post Requirements

- All code inline (SAM templates, AppSpec, hook functions, CLI commands)
- Mermaid diagrams for alias routing and canary phases
- One SAM template provisions the full working example

---

## Post Structure

### 1. Introduction — Why Lambda Deployments Are Different

- No servers, no agents, no file copies — deployment = publishing a new version and shifting traffic to it
- The risk: without safeguards, traffic shifts are instantaneous and all-or-nothing. One broken version = 100% of traffic affected.
- The solution: gradual traffic shifting with validation and automatic rollback
- Three ways to do this on AWS: raw CodeDeploy, SAM `DeploymentPreference`, CodePipeline V2 Lambda action

### 2. Prerequisites

- AWS CLI v2 configured with credentials
- AWS SAM CLI installed
- An AWS account with permissions to create Lambda functions, IAM roles, and CodeDeploy resources
- Node.js or Python runtime available locally (for writing the Lambda function and hook code)

### 3. Background: Lambda Versions, Aliases, and Routing Weights

- **Versions**: immutable snapshots of function code + config. Once published, never changes.
- **Aliases**: named pointers to a version (e.g., `live` → version 5). Consumers invoke the alias.
- **Routing config**: an alias can split traffic between two versions using `AdditionalVersionWeights`
- This is the primitive that CodeDeploy uses — it adjusts `AdditionalVersionWeights` over time
- Mermaid diagram: Alias pointing 90% → v1, 10% → v2 during canary

### 4. Approach 1 — Raw CodeDeploy (Understanding the Mechanics)

#### 4.1 Setup

- Create a Lambda function manually (CLI), publish v1, create alias `live`
- Create CodeDeploy application (compute platform: Lambda)
- Create deployment group with `Canary10Percent5Minutes`
- Create a pre-traffic hook function (BeforeAllowTraffic)

#### 4.2 The AppSpec File for Lambda

- Structure: `Resources` (function, alias, current/target version) + `Hooks` (BeforeAllowTraffic, AfterAllowTraffic)
- Show complete AppSpec
- Explain: hooks reference *other Lambda functions* that validate and call `PutLifecycleEventHookExecutionStatus`

#### 4.3 The Pre-Traffic Hook Function

- Full code: invokes the new version, validates the response, reports success/failure to CodeDeploy
- If hook fails: deployment rolls back immediately, no traffic ever reaches v2
- Permissions needed: `lambda:InvokeFunction` + `codedeploy:PutLifecycleEventHookExecutionStatus`

#### 4.4 Deploy with Canary

- Publish v2 (3 CLI commands: update-function-code, wait, publish-version)
- Create the deployment
- Observe: alias shows `AdditionalVersionWeights: {"2": 0.1}` during canary
- Invoke 20 times → ~18 from v1, ~2 from v2
- After 5 minutes: alias points 100% to v2

#### 4.5 Automatic Rollback

- Attach a CloudWatch alarm (e.g., Lambda `Errors` metric for the alias)
- Deploy a broken v3
- Pre-traffic hook catches it → immediate rollback (no traffic shifted)
- OR: hook passes but alarm fires during canary → automatic rollback mid-shift

### 5. Approach 2 — SAM DeploymentPreference (The Real-World Workflow)

#### 5.1 What SAM Automates

- `AutoPublishAlias`: detects code changes → publishes new version → creates/updates alias
- `DeploymentPreference`: creates CodeDeploy application + deployment group + triggers deployment
- `Alarms`: attaches CloudWatch alarms to the deployment group
- `Hooks`: wires pre/post-traffic validation functions

#### 5.2 Complete SAM Template

- Full working `template.yaml` with:
  - Function with `AutoPublishAlias: live`
  - `DeploymentPreference: { Type: Canary10Percent5Minutes, Alarms: [...], Hooks: { PreTraffic: ... } }`
  - Pre-traffic hook function
  - CloudWatch alarm on Errors metric
- Show the CodeDeploy resources SAM creates (visible in console after deploy)

#### 5.3 Deploy and Observe

- `sam build && sam deploy`
- Change function code → `sam deploy` again
- SAM automatically: publishes new version, creates CodeDeploy deployment, shifts traffic gradually
- Trigger the alarm → observe automatic rollback
- The developer workflow: just `sam deploy`, everything else is automated

#### 5.4 Available Deployment Types

- `Canary10Percent5Minutes`, `Canary10Percent10Minutes`, `Canary10Percent15Minutes`, `Canary10Percent30Minutes`
- `Linear10PercentEvery1Minute`, `Linear10PercentEvery2Minutes`, `Linear10PercentEvery3Minutes`, `Linear10PercentEvery10Minutes`
- `AllAtOnce`
- Custom: create a custom CodeDeploy deployment config and reference it by name

### 6. Approach 3 — CodePipeline V2 Lambda Deploy Action (Brief)

- Newer option: CodePipeline V2 has a native Lambda deploy action
- Can deploy source artifacts to $LATEST, auto-publish version, shift traffic
- Supports canary/linear strategies without a separate CodeDeploy application
- When to use: if you're already on CodePipeline V2 and want fewer moving parts
- When to use SAM instead: if you manage infrastructure as code and want declarative deployments

### 7. Comparison: When to Use What

| Approach | Complexity | Automation Level | Best For |
|----------|-----------|-----------------|----------|
| Raw CodeDeploy | High (manual version publishing, AppSpec writing) | Low | Understanding mechanics, custom pipelines |
| SAM DeploymentPreference | Low (~10 lines of config) | High (auto-publishes, auto-deploys) | Most production workloads |
| CodePipeline V2 Lambda action | Medium | Medium | Existing CodePipeline workflows |

### 8. Clean Up

- Delete SAM stack (`sam delete`)
- Delete manually created CodeDeploy resources
- Remove any leftover Lambda versions

### 9. Conclusion

- Lambda deployments are about controlling traffic flow between immutable versions
- CodeDeploy provides the mechanics: canary/linear shifting, hooks, alarm rollback
- SAM wraps CodeDeploy into a declarative experience
- Safety pattern: pre-traffic hook (functional validation) + CloudWatch alarm (runtime validation) = two layers of protection

---

## Key Diagrams

1. Lambda version/alias/routing weight model
2. Canary traffic shift over time (10% → wait → 100%)
3. Linear traffic shift over time (10% → 20% → ... → 100%)
4. Pre-traffic hook validation flow (hook invokes new version → validates → reports to CodeDeploy)
5. SAM DeploymentPreference → CodeDeploy resource mapping

---

## Sources & References

- [Deploying serverless applications gradually — AWS Lambda docs](https://docs.aws.amazon.com/lambda/latest/dg/automating-updates-to-serverless-apps.html)
- [SAM DeploymentPreference property](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-property-function-deploymentpreference.html)
- [Implementing safe Lambda deployments with CodeDeploy — AWS Compute Blog](https://aws.amazon.com/blogs/compute/implementing-safe-aws-lambda-deployments-with-aws-codedeploy/)
- [CodePipeline Lambda deploy action reference](https://docs.aws.amazon.com/codepipeline/latest/userguide/action-reference-LambdaDeploy.html)
- [AppSpec hooks for Lambda deployment](https://docs.aws.amazon.com/codedeploy/latest/userguide/reference-appspec-file-structure-hooks.html#appspec-hooks-lambda)
- [Working with deployment configurations — Lambda](https://docs.aws.amazon.com/codedeploy/latest/userguide/deployment-configurations.html)
