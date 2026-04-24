# AWS Certified DevOps Engineer – Professional (DOP-C02) Hands-On Study Guide

A practical, lab-driven study guide for the DOP-C02 certification exam. Every session has you building real infrastructure on AWS — not just reading about it.

## What's Inside

10 hands-on sessions covering all 6 exam domains, plus an overview with the study plan and exam details.

| Session | Domain | What You Build |
|---|---|---|
| [00 — Overview](./00-overview.md) | — | Exam structure, domain weights, 10-week study timeline |
| [01 — CI/CD Pipelines](./01-cicd-pipelines.md) | SDLC Automation (22%) | CodeCommit repo with approval rules, CodeBuild project with buildspec, CodePipeline with EventBridge triggers and manual approvals, secrets injection from Parameter Store and Secrets Manager, cross-account pipeline architecture |
| [02 — Testing, Artifacts & Deployments](./02-testing-artifacts-deployments.md) | SDLC Automation (22%) | Multi-level test pipeline (unit/integration), ECR repo with scan-on-push and lifecycle policies, CodeArtifact npm proxy, CodeDeploy in-place deployment to EC2 with lifecycle hooks, Lambda canary deployment with pre-traffic validation hook |
| [03 — Infrastructure as Code](./03-infrastructure-as-code.md) | Config Management & IaC (17%) | CloudFormation VPC template (parameters, mappings, conditions), change sets, stack policies, drift detection, cross-stack references, Lambda-backed custom resource, SAM serverless app with local testing, CDK app with L2/L3 constructs, StackSets across Regions |
| [04 — Multi-Account Automation](./04-multi-account-automation.md) | Config Management & IaC (17%) | SCPs for Region restriction and security guardrails, full Systems Manager tour (Run Command, Session Manager, State Manager, Inventory, Patch Manager, Automation runbooks), Config rule with auto-remediation via SSM, AppConfig feature flags with gradual rollout, Step Functions incident response workflow |
| [05 — Resilient Cloud Solutions](./05-resilient-cloud-solutions.md) | Resilient Cloud (15%) | Multi-AZ ASG behind ALB with health checks and lifecycle hooks, target tracking scaling policy, AWS Backup with cross-Region copy and restore test, Route 53 health checks (endpoint + CloudWatch alarm), Fault Injection Service chaos experiment, DR strategy decision exercises |
| [06 — Monitoring, Metrics & Logs](./06-monitoring-metrics-logs.md) | Monitoring & Logging (15%) | CloudWatch agent for memory/disk metrics, custom metrics via PutMetricData, metric filters from log patterns, log subscriptions via Firehose to S3, CloudWatch Logs Insights queries, VPC Flow Logs with Athena queries |
| [07 — Observability & Event Automation](./07-observability-event-automation.md) | Monitoring & Logging (15%) | X-Ray tracing on Lambda with DynamoDB subsegments, EventBridge rules for EC2/security group/console login events, static/anomaly detection/composite CloudWatch alarms, Synthetics canary |
| [08 — Incident & Event Response](./08-incident-event-response.md) | Incident Response (14%) | EventBridge + Lambda auto-remediation for open security groups, troubleshooting exercises (CodeDeploy, CloudFormation, ECS, ASG failures), OpsCenter for centralized incident management |
| [09 — IAM & Security at Scale](./09-iam-security-at-scale.md) | Security & Compliance (17%) | Permissions boundaries for delegated admin, cross-account access (role assumption vs. resource policies), Secrets Manager rotation, IAM Access Analyzer, ABAC policy-writing exercises |
| [10 — Data Protection & Auditing](./10-data-protection-auditing.md) | Security & Compliance (17%) | KMS key management with rotation and cross-account access, WAF Web ACL (IP blocking, rate limiting, managed rules), GuardDuty with automated response, CloudTrail with log integrity validation, security service identification exercise |

## Prerequisites

- An AWS account (free tier covers most labs; budget ~$10–15 total for the full guide)
- AWS CLI v2 installed and configured
- Git, Node.js 18+, Python 3.9+, Docker
- AWS SAM CLI and AWS CDK CLI (`npm install -g aws-cdk`)

## How to Use This Guide

1. Start with [00-overview.md](./00-overview.md) for the exam structure and study plan
2. Work through sessions 1–10 in order — later sessions build on concepts from earlier ones
3. Each session has:
   - Prerequisites checklist
   - Estimated time (3–5 hours per session)
   - Step-by-step labs with real AWS CLI commands
   - Experiments to deepen understanding
   - Exam takeaway tables summarizing what's tested
   - Full cleanup instructions to avoid surprise charges
4. After completing all sessions, take practice exams and revisit weak areas

## Recommended Timeline

| Week | Sessions | Focus |
|---|---|---|
| 1–2 | 1, 2 | CI/CD, testing, deployment strategies |
| 3–4 | 3, 4 | IaC, multi-account automation, Systems Manager |
| 5 | 5 | Resilience, DR, auto scaling |
| 6 | 6, 7 | Monitoring, observability, event-driven automation |
| 7 | 8 | Incident response, troubleshooting |
| 8 | 9, 10 | Security, encryption, auditing |
| 9–10 | — | Practice exams and weak-area review |

## Cost Warning

Each session includes a cleanup section. Run it when you're done to avoid ongoing charges. The most expensive resources are NAT Gateways (~$0.045/hr), ALBs (~$0.023/hr), and EC2 instances. Most labs cost under $2 if you clean up promptly.

## Sources

- [Official AWS DOP-C02 Exam Guide](https://docs.aws.amazon.com/aws-certification/latest/examguides/devops-engineer-professional-02.html)
- [AWS Documentation](https://docs.aws.amazon.com/)
- Content was rephrased for compliance with licensing restrictions.
