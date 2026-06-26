# Outline: ECS Deployments — CodeDeploy Blue/Green, Native Strategies, and Choosing Between Them

## Working Title

**ECS Deployment Strategies: CodeDeploy Blue/Green vs. Native Canary and Linear**

---

## Target Audience

DevOps engineers running containerized services on ECS Fargate (or EC2) who need to understand their deployment options: CodeDeploy-managed blue/green with lifecycle hooks, ECS-native blue/green/canary/linear, and when to pick which. Also targeting DOP-C02 exam candidates — ECS blue/green with CodeDeploy (test listeners, `AfterAllowTestTraffic`) is directly tested.

---

## Core Premise

ECS has two deployment paths: CodeDeploy-managed (the original approach for blue/green) and ECS-native (added in 2025, now supports blue/green, canary, and linear). Both achieve safe deployments, but they differ in complexity, flexibility, and integration points. This post deploys the same application using both approaches, compares the mechanics, and provides a decision framework for choosing between them.

---

## Self-Contained Post Requirements

- All code inline (CloudFormation templates, AppSpec files, hook functions, CLI commands)
- Mermaid diagrams for blue/green task set switching and traffic flow
- Two CloudFormation templates: one for CodeDeploy approach, one for ECS-native approach
- Side-by-side comparison of the same deployment scenario using both methods

---

## Post Structure

### 1. Introduction — The ECS Deployment Landscape

- ECS rolling update: the default. Updates tasks in place. Simple but limited (no instant rollback, no pre-validation).
- CodeDeploy blue/green: the original advanced option. Full lifecycle hooks, test listeners, alarm-based rollback. More complex to set up.
- ECS-native blue/green/canary/linear: the newer option. Simpler configuration, tighter ECS integration, fewer moving parts. Covers most use cases.
- This post teaches both CodeDeploy and native approaches, then helps you choose.

### 2. Background: ECS Deployment Concepts

- **Task sets**: a group of tasks within a service. Blue/green = two task sets.
- **Target groups**: ALB routes traffic to targets. Two target groups enable blue/green switching.
- **Production listener**: routes real user traffic.
- **Test listener**: routes to the replacement task set on a separate port — allows pre-production validation.
- **Deployment controller**: `ECS` (rolling update or native), `CODE_DEPLOY` (CodeDeploy-managed), or `EXTERNAL`.
- Mermaid diagram: ALB → production listener (port 80) → blue target group, test listener (port 8080) → green target group

### 3. Approach 1 — CodeDeploy Blue/Green

#### 3.1 Prerequisites — CloudFormation Template

- Template provisions:
  - ECS cluster (Fargate)
  - ECS service with `DeploymentController: CODE_DEPLOY`
  - Task definition (nginx or Node.js, v1 image)
  - ALB with two target groups + production listener (80) + test listener (8080)
  - ECR repository with v1 image pre-pushed
  - CodeDeploy application (compute platform: ECS) + deployment group
  - AfterAllowTestTraffic hook Lambda function
  - CodeDeploy service role with `AWSCodeDeployRoleForECS`
- Outputs: ALB DNS, test listener URL, CodeDeploy app/group names, ECR URI

#### 3.2 The AppSpec File for ECS

- Structure: `Resources` (TargetService with TaskDefinition + LoadBalancerInfo) + `Hooks`
- Available hooks: `BeforeInstall`, `AfterInstall`, `AfterAllowTestTraffic`, `BeforeAllowTraffic`, `AfterAllowTraffic`
- Show complete AppSpec with `AfterAllowTestTraffic` hook
- The hook is the key differentiator — it runs after the test listener routes to green but before production traffic shifts

#### 3.3 The AfterAllowTestTraffic Hook Function

- Full code: hits the test listener URL, validates HTTP 200 + expected response body, reports to CodeDeploy
- If hook fails: deployment rolls back, production traffic stays on blue
- Permissions: `codedeploy:PutLifecycleEventHookExecutionStatus`

#### 3.4 Deploy v2 with CodeDeploy

- Build and push v2 image
- Register new task definition revision
- Write AppSpec pointing to new task definition
- Create deployment
- Observe the sequence:
  1. Green task set spins up
  2. Test listener routes to green (port 8080)
  3. `AfterAllowTestTraffic` hook runs → validates via test listener
  4. Hook passes → production traffic shifts from blue to green (port 80)
  5. Wait period → original (blue) task set terminates
- During deployment: `curl :8080` → v2, `curl :80` → v1 (until traffic shifts)

#### 3.5 Traffic Shifting Options with CodeDeploy

- `CodeDeployDefault.ECSAllAtOnce` — instant switch after validation
- `CodeDeployDefault.ECSCanary10Percent5Minutes` — 10% for 5 min, then all
- `CodeDeployDefault.ECSLinear10PercentEvery1Minute` — gradual over 10 min
- Custom deployment configs
- All options still use the test listener + hooks for pre-validation

#### 3.6 Automatic Rollback

- Attach CloudWatch alarm (e.g., ALB target 5xx rate, ECS service healthy task count)
- During canary/linear phase: alarm fires → CodeDeploy switches production back to blue
- The blue task set stays alive during the termination wait period — this is what enables instant rollback

### 4. Approach 2 — ECS Native Blue/Green

#### 4.1 How It Differs from CodeDeploy

- Deployment controller: `ECS` (not `CODE_DEPLOY`)
- Configuration: done entirely via ECS service deployment config (no separate CodeDeploy application/group/AppSpec)
- Lifecycle hooks: uses ECS service deployment lifecycle (not CodeDeploy hooks) — alarms attached directly to ECS
- No AppSpec file needed
- Test listener support: yes, built into the ECS service configuration
- Trade-off: simpler setup, but no Lambda-based lifecycle hooks (can't run arbitrary validation code at each stage)

#### 4.2 Prerequisites — CloudFormation Template (Native)

- Template provisions:
  - Same infrastructure (cluster, ALB, two target groups, two listeners)
  - ECS service with `DeploymentController: ECS` + deployment configuration:
    - `deploymentType: BLUE_GREEN`
    - `deploymentCircuitBreaker: { enable: true, rollback: true }`
  - CloudWatch alarm for automatic rollback
- Note: significantly less infrastructure (no CodeDeploy app, group, role, hook function)

#### 4.3 Deploy v2 with ECS Native

- Update the service with the new task definition
- ECS handles: create replacement task set → health check → shift traffic → terminate original
- Observe the same blue/green behavior, less configuration
- Rollback: ECS circuit breaker detects unhealthy tasks → rolls back automatically

#### 4.4 ECS Native Canary and Linear

- Configure gradual traffic shifting via ECS service deployment configuration
- Canary: initial percentage → bake time → full shift
- Linear: equal increments with bake time between each
- Alarm-based rollback: CloudWatch alarms attached at the ECS service level

### 5. Approach 3 — ECS Rolling Update (Brief)

- The simplest option: `DeploymentController: ECS` with `minimumHealthyPercent` and `maximumPercent`
- ECS drains old tasks and launches new ones in batches
- No blue/green, no instant rollback, no test listener
- When to use: development environments, services where brief mixed-version traffic is acceptable
- Not suitable for zero-downtime production deployments

### 6. Comparison: Choosing Between Approaches

| Aspect | CodeDeploy Blue/Green | ECS Native Blue/Green | ECS Rolling Update |
|--------|----------------------|----------------------|-------------------|
| Setup complexity | High (CodeDeploy app, group, role, AppSpec, hooks) | Medium (ECS service config) | Low (just min/max percent) |
| Lifecycle hooks | Yes — Lambda functions at 5 stages | No (alarm-based only) | No |
| Test listener | Yes | Yes | No |
| Custom validation code | Yes (AfterAllowTestTraffic) | No (health checks + alarms only) | No |
| Traffic strategies | AllAtOnce, Canary, Linear | AllAtOnce, Canary, Linear | Rolling (min healthy %) |
| Rollback speed | Instant (ALB switch) | Instant (ALB switch) | Slow (new tasks must start) |
| CodePipeline integration | CodeDeploy deploy action | ECS deploy action | ECS deploy action |
| When to use | Complex validation, existing CodeDeploy pipelines | Most new production deployments | Dev/test, simple services |

Decision framework:
- Need Lambda-based custom validation before production traffic? → CodeDeploy
- Already have CodeDeploy pipelines and want to keep consistency? → CodeDeploy
- New deployment, want simplicity with blue/green safety? → ECS Native
- Dev environment, minimal config? → Rolling Update

### 7. Clean Up

- Delete CloudFormation stacks (both approaches)
- Delete ECR images
- Check for orphaned task definitions and target groups

### 8. Conclusion

- ECS has three deployment options: rolling update, CodeDeploy blue/green, ECS-native blue/green/canary/linear
- CodeDeploy adds Lambda lifecycle hooks (especially `AfterAllowTestTraffic`) for complex validation scenarios
- ECS native covers most production use cases with significantly less configuration
- The test listener pattern (validate on port 8080 before shifting port 80) is the key safety pattern for both approaches
- The exam tests CodeDeploy for ECS — know the AppSpec structure, hook names, and how the test listener flow works

---

## Key Diagrams

1. ECS blue/green architecture (ALB → two target groups → two task sets)
2. Deployment timeline (green task set creation → test traffic → hook validation → production shift → blue termination)
3. Test listener flow (port 8080 → green, port 80 → blue until shift)
4. CodeDeploy vs. ECS native: configuration surface comparison
5. Traffic shifting over time (canary/linear visualization)

---

## Sources & References

- [Blue/Green deployment with CodeDeploy — ECS User Guide](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-type-bluegreen.html)
- [Tutorial: Deploy an ECS service with a validation test — CodeDeploy](https://docs.aws.amazon.com/codedeploy/latest/userguide/tutorial-ecs-deployment-with-hooks.html)
- [AppSpec hooks for ECS deployment](https://docs.aws.amazon.com/codedeploy/latest/userguide/reference-appspec-file-structure-hooks.html#appspec-hooks-ecs)
- [Choosing between ECS Blue/Green Native or CodeDeploy — AWS DevOps Blog](https://aws.amazon.com/blogs/devops/choosing-between-amazon-ecs-blue-green-native-or-aws-codedeploy-in-aws-cdk/)
- [Migrating from CodeDeploy to ECS for blue/green — AWS Containers Blog](https://aws.amazon.com/blogs/containers/migrating-from-aws-codedeploy-to-amazon-ecs-for-blue-green-deployments/)
- [Gradual deployments in ECS with linear and canary — AWS Containers Blog](https://aws.amazon.com/blogs/containers/gradual-deployments-in-amazon-ecs-with-linear-and-canary-strategies/)
- [AWSCodeDeployRoleForECS managed policy](https://docs.aws.amazon.com/codedeploy/latest/userguide/managed-policies.html)
