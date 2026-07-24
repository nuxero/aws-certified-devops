# Outline: CloudFormation from Scratch — Building a VPC

## Working Title

**CloudFormation from Scratch: Building a Production-Ready VPC Step by Step**

---

## Target Audience

DevOps engineers and cloud practitioners who want to learn CloudFormation by building real infrastructure rather than reading abstract documentation. Also targeting DOP-C02 exam candidates — template anatomy, intrinsic functions, parameters, mappings, conditions, and outputs are core exam topics (Domain 2: Configuration Management and IaC, 17%).

---

## Core Premise

The best way to learn CloudFormation is to build something real. This post walks through writing a VPC template from scratch — not copying a pre-made template, but understanding every section, every intrinsic function, every design decision. By the end, you'll have a production-quality VPC with public and private subnets, conditional NAT Gateway creation, and exported outputs ready for cross-stack consumption.

---

## Self-Contained Post Requirements

- All code inline (complete YAML template, CLI commands)
- Each code snippet preceded by a paragraph explaining what the code does, with inline comments referencing the explanation
- Mermaid diagram showing the VPC architecture (subnets, route tables, IGW, NAT)
- A single CloudFormation template built incrementally section by section
- Validation and deployment commands with expected output

---

## Post Structure

### 1. Introduction — Why Write Templates by Hand?

- CloudFormation remains the foundation of AWS IaC — SAM, CDK, and StackSets all generate CloudFormation under the hood
- Understanding template anatomy makes you better at debugging any IaC tool
- A VPC is the ideal first template: it uses nearly every template section and many intrinsic functions, yet produces tangible infrastructure you can SSH into
- What we'll build: 2 public subnets, 2 private subnets, IGW, optional NAT Gateway controlled by conditions

### 2. Template Anatomy — The Six Sections

- Overview of the template structure: `AWSTemplateFormatVersion`, `Description`, `Parameters`, `Mappings`, `Conditions`, `Resources`, `Outputs`
- Only `Resources` is required — everything else adds flexibility and reusability
- Briefly explain when to use each section (details in subsequent sections)
- Show the empty skeleton template as a starting point

### 3. Parameters — Making Templates Reusable

- Define `Environment` (AllowedValues: dev, staging, prod), `VpcCidr` (with AllowedPattern regex), `EnableNatGateway` (true/false)
- Parameter types: `String`, `Number`, `CommaDelimitedList`, `AWS::SSM::Parameter::Value<T>`, `AWS::EC2::*` types
- Constraints: `AllowedValues`, `AllowedPattern`, `MinLength`, `MaxLength`, `MinValue`, `MaxValue`, `Default`
- The `ConstraintDescription` attribute for human-friendly error messages
- When to use parameters vs. mappings vs. hardcoded values

### 4. Mappings — Static Lookup Tables

- Define subnet CIDR mappings (Public1, Public2, Private1, Private2)
- `!FindInMap [MapName, TopLevelKey, SecondLevelKey]` syntax
- Use cases: Region-specific AMI IDs, environment-specific instance sizes, CIDR allocations
- Mappings vs. parameters: mappings are fixed at template authoring time, parameters are set at deployment time
- Mappings vs. SSM Parameter Store references: trade-offs (static vs. dynamic, template portability)

### 5. Conditions — Conditional Resource Creation

- Define `IsProd` condition using `!Equals`
- Define `CreateNat` condition combining `!Or` with the parameter value and `IsProd`
- Condition functions: `!Equals`, `!And`, `!Or`, `!Not`, `!If`
- How `!If` works in resource properties vs. `Condition:` at the resource level
- The key insight: resources with `Condition: CreateNat` simply don't exist when the condition is false — they're not created, not deleted, not skipped — they're absent from the stack entirely

### 6. Resources — Building the VPC Layer by Layer

#### 6.1 VPC and Internet Gateway

- `AWS::EC2::VPC` with `!Ref VpcCidr`, DNS settings enabled
- `AWS::EC2::InternetGateway` and `AWS::EC2::VPCGatewayAttachment`
- `!Sub` for Name tags using the Environment parameter
- Pseudo-parameters: `AWS::StackName`, `AWS::Region`, `AWS::AccountId`

#### 6.2 Subnets

- Public subnets with `MapPublicIpOnLaunch: true`
- Private subnets without public IPs
- `!FindInMap` to pull CIDRs from the Mappings section
- `!Select [0, !GetAZs '']` to distribute across AZs
- `!GetAZs` returns AZs for the current Region — `!Select` picks one by index

#### 6.3 Route Tables and Routes

- Public route table: route `0.0.0.0/0` → Internet Gateway
- `DependsOn: AttachGateway` — why explicit dependencies matter here (the route needs the IGW attachment to exist first)
- Private route table: conditional route to NAT Gateway
- `AWS::EC2::SubnetRouteTableAssociation` to wire subnets to route tables

#### 6.4 NAT Gateway (Conditional)

- `AWS::EC2::EIP` with `Condition: CreateNat`
- `AWS::EC2::NatGateway` with `Condition: CreateNat`
- Private route with `Condition: CreateNat`
- `!GetAtt NatEIP.AllocationId` — difference between `!Ref` (returns resource ID) and `!GetAtt` (returns a specific attribute)
- Cost awareness: NAT Gateway costs ~$0.045/hr + data processing — this is why we condition it

#### 6.5 Architecture Diagram

- Mermaid diagram: VPC → 2 AZs → public/private subnets → IGW for public, NAT for private
- Show traffic flow: internet → IGW → public subnet, private subnet → NAT → IGW → internet

### 7. Outputs and Exports — Sharing Values

- Export the VPC ID, public subnet IDs, private subnet IDs
- `!Join` to combine multiple subnet IDs into a comma-separated string
- `Export: Name:` must be unique within the Region
- Naming convention: `${AWS::StackName}-OutputName`
- Conditional outputs: `NatGatewayId` only appears when the condition is true
- What exports enable: other stacks can `!ImportValue` these values (cross-stack references)

### 8. Intrinsic Functions Summary

- Quick reference table of all intrinsic functions used in the template:
  - `!Ref` — returns the resource ID or parameter value
  - `!GetAtt` — returns a specific attribute of a resource
  - `!Sub` — string interpolation
  - `!Join` — concatenate with a delimiter
  - `!Select` — pick an item from a list by index
  - `!FindInMap` — lookup from Mappings
  - `!GetAZs` — returns list of AZs for a Region
  - `!Equals`, `!Or`, `!And`, `!Not`, `!If` — condition functions
- When to use `!Sub` vs `!Join` (prefer `!Sub` for readability)

### 9. Validate and Deploy

- `aws cloudformation validate-template` — catches syntax errors only, not semantic errors
- `create-stack` with parameters for dev (no NAT)
- `wait stack-create-complete` and check outputs
- `list-stack-resources` to see what was created
- Deploy again with `Environment=prod` — observe NAT resources appear
- Delete the prod stack immediately to avoid charges

### 10. Change Sets — Previewing Updates

- Modify the template (add a tag to the VPC)
- `create-change-set` → `describe-change-set` → review `Replacement` field
- `Replacement: Never` means in-place update — safe
- `Replacement: True` means destroy and recreate — dangerous for stateful resources
- `execute-change-set` to apply
- Why you should always use change sets in production (vs. direct `update-stack`)

### 11. Conclusion and Next Steps

- Recap: you've written a complete CloudFormation template using every major section
- The VPC is ready for use as a foundation — other stacks can import its exports
- Next post: cross-stack references and StackSets for multi-account deployment
- DOP-C02 exam tip: know intrinsic functions cold, understand conditional resource creation, and remember that `Export` names must be unique per Region

---

## Key Diagrams

1. Template anatomy — visual showing the six sections and their relationships
2. VPC architecture — subnets in 2 AZs, IGW, NAT (conditional), route tables, traffic flow
3. Condition evaluation flow — how `IsProd` and `CreateNat` combine to determine NAT creation

---

## Sources & References

- [CloudFormation template sections — AWS CloudFormation User Guide](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/template-anatomy.html)
- [CloudFormation Parameters syntax](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/parameters-section-structure.html)
- [CloudFormation Mappings syntax](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/mappings-section-structure.html)
- [CloudFormation Conditions syntax](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/conditions-section-structure.html)
- [Intrinsic function reference — AWS CloudFormation User Guide](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference.html)
- [AWS::EC2::VPC resource reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-vpc.html)
- [Working with CloudFormation templates](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/gettingstarted.templatebasics.html)
