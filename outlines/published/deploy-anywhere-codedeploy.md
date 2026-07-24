# Outline: CodeDeploy on EC2 — Mechanics, Lifecycle Hooks, and Deployment Strategies

## Working Title

**CodeDeploy on EC2: From First Deployment to Blue/Green**

---

## Target Audience

DevOps engineers who deploy applications to EC2 instances (or on-premises servers) and want to understand CodeDeploy end-to-end — from the agent and AppSpec mechanics to choosing between AllAtOnce, HalfAtATime, OneAtATime, and blue/green with Auto Scaling Groups.

---

## Core Premise

AWS CodeDeploy is a managed deployment service that automates releases to EC2 instances and on-premises servers. This post teaches the complete CodeDeploy-on-EC2 workflow: how the agent works, how AppSpec files and lifecycle hooks control the deployment, and how to choose between in-place strategies (AllAtOnce, HalfAtATime, OneAtATime, custom) and blue/green with ASG. By the end, the reader deploys the same application using multiple strategies and understands when to pick which.

---

## Self-Contained Post Requirements

- All code inline. CloudFormation template for prerequisites.
- All code preceded by an explanatory paragraph with inline comments.
- Mermaid diagrams for architecture and lifecycle hooks.
- One CloudFormation template creates all prerequisites (multiple instances via ASG for demonstrating rolling strategies + blue/green).

---

## Post Structure

### 1. Introduction — What CodeDeploy Is and Why It Exists

- The deployment problem: automation needed for velocity + stability
- The complexity: traffic shifting, validation, rollback, ordering, audit
- CodeDeploy's answer: managed deployment with strategies, hooks, and rollback
- Scope of this post: EC2/On-Premises platform, all deployment strategies
- Note: CodeDeploy also supports Lambda and ECS (covered in separate posts)
- On-premises servers use the same mechanics as EC2 (same AppSpec, hooks, agent) — only registration and blue/green differ

### 2. Architecture Overview

- Mermaid diagram: CodeDeploy service → Deployment Group → EC2 instances (via tags) + Agent
- The three-level model: Application → Deployment Group → Revision (AppSpec + bundle)
- Revision sources: S3 (zip/tar), GitHub, or Bitbucket (EC2/On-Premises only)
- The CodeDeploy agent: polls service over HTTPS, pulls revision, executes hooks

### 3. Prerequisites — CloudFormation Template

- Template provisions:
  - Auto Scaling Group with 3 instances (Amazon Linux 2023, t2.micro)
  - CodeDeploy agent installed via user data
  - nginx serving "Version 1.0"
  - ALB fronting the ASG (needed for blue/green)
  - S3 bucket for deployment bundles
  - CodeDeploy service role
  - IAM instance profile with S3 read access
- Outputs: ALB DNS, ASG name, S3 bucket, CodeDeploy role ARN
- Why 3 instances: needed to observe rolling behavior (HalfAtATime, OneAtATime)

### 4. The AppSpec File and Lifecycle Hooks

- AppSpec structure: `version`, `os`, `files`, `hooks`
- The `files` section: source → destination mapping
- Lifecycle hook order (in-place):
  `ApplicationStop → DownloadBundle → BeforeInstall → Install → AfterInstall → ApplicationStart → ValidateService`
- Key insight: ApplicationStop runs the *previous* revision's script
- DownloadBundle and Install are agent-managed (no user scripts)
- Show complete AppSpec + all lifecycle hook scripts
- Exit codes drive everything: non-zero = failure = deployment stops

### 5. In-Place Deployment: AllAtOnce

- Create CodeDeploy application + deployment group with `CodeDeployDefault.AllAtOnce`
- Bundle, upload, deploy
- Observe: all 3 instances deploy simultaneously
- Verify: all instances show v2
- Tradeoff: fastest, but all instances are briefly running new untested code. Downtime if the new version fails.
- Experiment: break ValidateService → observe all instances fail

### 6. In-Place Deployment: OneAtATime

- Update the deployment group config to `CodeDeployDefault.OneAtATime`
- Deploy v3
- Observe: instances deploy sequentially — one finishes before the next starts
- During deployment: some instances serve v2, others serve v3 (mixed fleet)
- If one instance fails: deployment stops, remaining instances stay on v2
- Tradeoff: safest in-place strategy, but slowest. Good for small fleets where you want maximum confidence.

### 7. In-Place Deployment: HalfAtATime

- Update to `CodeDeployDefault.HalfAtATime`
- Deploy v4
- Observe: deploys to ~50% of instances, waits for success, then deploys to the rest
- Tradeoff: balance between speed and safety. Fleet always has at least 50% healthy capacity.
- Custom configurations: create a custom deployment config with `minimumHealthyHosts` (e.g., 66%)

### 8. Blue/Green Deployment with Auto Scaling Group

- How it works: CodeDeploy provisions a *new* ASG (green) with the new revision, waits for healthy instances, then switches the ALB target group from blue to green
- Mermaid diagram: ALB → blue target group (original ASG) → switches to green target group (replacement ASG)
- Prerequisites: ALB must be associated with the deployment group
- Create a new deployment group configured for blue/green:
  - Traffic rerouting: reroute immediately when green is healthy
  - Original instances: terminate after 5 minutes
- Deploy v5 as blue/green
- Observe: new ASG spins up, instances become healthy, ALB switches, old ASG terminated
- Rollback: CodeDeploy switches ALB back to original ASG (instances are still running during wait period)
- Tradeoff: zero downtime, instant rollback, but 2x instances running during deployment (cost)
- Key limitation: blue/green on EC2 requires an ASG — not available for on-premises instances or individually tagged instances

### 9. Comparison: Choosing a Strategy

| Strategy | Downtime | Rollback Speed | Cost | Best For |
|----------|----------|----------------|------|----------|
| AllAtOnce | Possible | Slow (redeploy) | 1x | Dev/test, small fleets |
| OneAtATime | None (rolling) | Medium (stop deploy) | 1x | Production, small fleets, max safety |
| HalfAtATime | None (rolling) | Medium | 1x | Production, larger fleets, balanced |
| Blue/Green | None | Instant (ALB switch) | 2x during deploy | Production, zero-tolerance for downtime |

Decision framework:
- Need instant rollback? → Blue/Green
- Cost-sensitive but need zero downtime? → HalfAtATime or OneAtATime
- Dev environment, speed matters? → AllAtOnce
- On-premises? → In-place only (AllAtOnce, HalfAtATime, OneAtATime)

### 10. Automatic Rollback with CloudWatch Alarms

- Attach a CloudWatch alarm to the deployment group (e.g., ALB 5xx error rate)
- Deploy a broken version
- Observe: alarm fires → CodeDeploy automatically triggers rollback
- Key: rollback = new deployment of the previous revision (not a revert)
- Works with all strategies

### 11. Clean Up

- Delete CodeDeploy resources
- Delete CloudFormation stack
- Verify no orphaned ASGs or target groups

### 12. Conclusion

- CodeDeploy on EC2 gives you managed deployment with safety built in
- The AppSpec + lifecycle hooks pattern is the core — strategies control the rollout speed
- Blue/green provides instant rollback at the cost of double capacity
- CloudWatch alarms close the loop: automatic rollback on error
- Next posts: Lambda deployments (canary + SAM) and ECS deployments (blue/green + native)

---

## Key Diagrams

1. CodeDeploy architecture (service → deployment group → ASG instances)
2. Lifecycle hook order (in-place)
3. Rolling deployment visualization (HalfAtATime with 4 instances)
4. Blue/Green with ALB target group switch

---

## Sources & References

- [What is CodeDeploy? — AWS Documentation](https://docs.aws.amazon.com/codedeploy/latest/userguide/welcome.html)
- [AppSpec 'hooks' section](https://docs.aws.amazon.com/codedeploy/latest/userguide/reference-appspec-file-structure-hooks.html)
- [Working with deployment configurations](https://docs.aws.amazon.com/codedeploy/latest/userguide/deployment-configurations.html)
- [Blue/Green deployments with CodeDeploy](https://docs.aws.amazon.com/codedeploy/latest/userguide/deployments-create-blue-green.html)
- [Working with on-premises instances](https://docs.aws.amazon.com/codedeploy/latest/userguide/instances-on-premises.html)
- [AWS CodeDeploy Features](https://aws.amazon.com/codedeploy/features/)
