# AWS Certified DevOps Engineer – Professional (DOP-C02) Study Guide

## Exam Overview

| Detail | Value |
|---|---|
| Exam Code | DOP-C02 |
| Format | Multiple-choice and multiple-response |
| Questions | 75 |
| Duration | 180 minutes |
| Passing Score | 750 / 1000 |
| Cost | $300 USD |
| Validity | 3 years |
| Languages | English, Japanese, Korean, Simplified Chinese |

## Exam Domains & Weights

| # | Domain | Weight |
|---|---|---|
| 1 | SDLC Automation | 22% |
| 2 | Configuration Management and Infrastructure as Code | 17% |
| 3 | Resilient Cloud Solutions | 15% |
| 4 | Monitoring and Logging | 15% |
| 5 | Incident and Event Response | 14% |
| 6 | Security and Compliance | 17% |

## Study Sessions

This guide is split into 10 focused sessions. Each session maps to specific exam task statements.

| Session | File | Domain(s) | Topics |
|---|---|---|---|
| 1 | [01-cicd-pipelines.md](./01-cicd-pipelines.md) | 1 | CI/CD pipelines, CodePipeline, CodeBuild, CodeCommit |
| 2 | [02-testing-artifacts-deployments.md](./02-testing-artifacts-deployments.md) | 1 | Automated testing, artifact management, deployment strategies |
| 3 | [03-infrastructure-as-code.md](./03-infrastructure-as-code.md) | 2 | CloudFormation, CDK, SAM, IaC lifecycle |
| 4 | [04-multi-account-automation.md](./04-multi-account-automation.md) | 2 | Organizations, Control Tower, multi-account/multi-Region, Systems Manager |
| 5 | [05-resilient-cloud-solutions.md](./05-resilient-cloud-solutions.md) | 3 | High availability, scalability, DR, RTO/RPO |
| 6 | [06-monitoring-metrics-logs.md](./06-monitoring-metrics-logs.md) | 4 | CloudWatch, log aggregation, metric filters, dashboards |
| 7 | [07-observability-event-automation.md](./07-observability-event-automation.md) | 4 | X-Ray, EventBridge, auto scaling, health checks, Config rules |
| 8 | [08-incident-event-response.md](./08-incident-event-response.md) | 5 | Event sources, automated remediation, troubleshooting, RCA |
| 9 | [09-iam-security-at-scale.md](./09-iam-security-at-scale.md) | 6 | IAM at scale, federation, SCPs, permissions boundaries |
| 10 | [10-data-protection-auditing.md](./10-data-protection-auditing.md) | 6 | Encryption, WAF, Shield, GuardDuty, Inspector, security auditing |

## Recommended Study Timeline

| Week | Sessions | Focus |
|---|---|---|
| 1–2 | 1, 2 | SDLC Automation (CI/CD, testing, deployments) |
| 3–4 | 3, 4 | IaC and multi-account automation |
| 5 | 5 | Resilient cloud solutions |
| 6 | 6, 7 | Monitoring, logging, observability |
| 7 | 8 | Incident and event response |
| 8 | 9, 10 | Security and compliance |
| 9–10 | — | Practice exams and weak-area review |

## Key Tips

- The exam is scenario-heavy. Memorizing service names is not enough — you need to understand *when* and *why* to use each service.
- Hands-on experience is critical. Build real pipelines, write CloudFormation templates, set up CloudWatch alarms.
- Pay attention to "least privilege", "least operational overhead", and "most cost-effective" qualifiers in questions.
- Multi-account and multi-Region patterns appear across almost every domain.
- When in doubt, prefer AWS-native, fully managed solutions over third-party tools.

## Sources

- [Official AWS DOP-C02 Exam Guide](https://docs.aws.amazon.com/aws-certification/latest/examguides/devops-engineer-professional-02.html)
- [AWS Documentation](https://docs.aws.amazon.com/)
- Content was rephrased for compliance with licensing restrictions.
