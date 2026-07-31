# ECS Deployment Strategies Lab

Companion repository for the [ECS Deployment Strategies: CodeDeploy Blue/Green vs. Native Blue/Green, Canary, and Linear](https://community.aws) post on AWS Builder Center.

Deploy the same ECS application using CodeDeploy blue/green and ECS-native blue/green, compare the mechanics side by side, and use a decision framework to choose the right strategy.

## What's Inside

```
├── ecs-codedeploy-prerequisites.yaml   # Full infra for CodeDeploy approach
├── ecs-native-prerequisites.yaml       # Full infra for ECS native approach
├── codedeploy/
│   └── task-definition-v2.json         # v2 task def for CodeDeploy deployment
└── native/
    └── task-definition-v2.json         # v2 task def for ECS native deployment
```

## Prerequisites

- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) configured with permissions for ECS, EC2, ELB, IAM, CodeDeploy, CloudWatch, and Lambda
- An AWS account — estimated cost is ~$1–2 USD (Fargate tasks running for a few hours, ALB)
- A VPC with at least two public subnets in different Availability Zones (the default VPC works)

## Quick Start

### Approach 1 — CodeDeploy Blue/Green

```bash
aws cloudformation deploy \
  --template-file ecs-codedeploy-prerequisites.yaml \
  --stack-name ecs-codedeploy-lab \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    VpcId=<YOUR_VPC_ID> \
    SubnetIds=<SUBNET_1>,<SUBNET_2>
```

### Approach 2 — ECS Native Blue/Green

```bash
aws cloudformation deploy \
  --template-file ecs-native-prerequisites.yaml \
  --stack-name ecs-native-lab \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    VpcId=<YOUR_VPC_ID> \
    SubnetIds=<SUBNET_1>,<SUBNET_2>
```

See the full walkthrough in the [blog post](https://community.aws).

## Clean Up

```bash
# Delete CodeDeploy approach stack
aws cloudformation delete-stack --stack-name ecs-codedeploy-lab
aws cloudformation wait stack-delete-complete --stack-name ecs-codedeploy-lab

# Delete ECS native approach stack
aws cloudformation delete-stack --stack-name ecs-native-lab
aws cloudformation wait stack-delete-complete --stack-name ecs-native-lab
```

## Cost

Estimated cost: ~$1–2 USD for running Fargate tasks and an ALB for a few hours. Delete stacks promptly to avoid ongoing charges.

## License

MIT-0
