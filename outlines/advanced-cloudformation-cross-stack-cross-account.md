# Outline: Advanced CloudFormation — Cross-Stack and Cross-Account

## Working Title

**Advanced CloudFormation: Cross-Stack References, Nested Stacks, and StackSets for Multi-Account Deployment**

---

## Target Audience

DevOps engineers managing multi-stack or multi-account AWS environments who need to understand how stacks share data and how infrastructure gets deployed at scale. Also targeting DOP-C02 exam candidates — cross-stack references, nested stacks, stack policies, drift detection, and StackSets are directly tested in Domain 2 (Configuration Management and IaC) and Domain 3 (Resilient Cloud Solutions).

---

## Core Premise

A single CloudFormation stack can only take you so far. Real-world infrastructure spans multiple stacks (networking, compute, data, application), multiple accounts (dev, staging, prod, security), and multiple Regions. This post teaches three patterns for composing CloudFormation at scale: cross-stack references for sharing values between independent stacks, nested stacks for deploying related resources together, and StackSets for rolling infrastructure across accounts and Regions.

---

## Self-Contained Post Requirements

- All code inline (YAML templates, CLI commands, IAM policies)
- Each code snippet preceded by a paragraph explaining what the code does, with inline comments referencing the explanation
- Mermaid diagrams for cross-stack reference flow, nested stack hierarchy, and StackSet deployment model
- Templates that build on the VPC from Post #1 (references its exports)
- Stack policy and drift detection commands with expected outputs

---

## Post Structure

### 1. Introduction — Composing Infrastructure at Scale

- Single stacks hit limits: 500 resources, team ownership boundaries, different lifecycles
- Three composition patterns: cross-stack references (independent stacks sharing data), nested stacks (parent-child with same lifecycle), StackSets (deploy to many accounts/Regions)
- When to use each — not interchangeable, each solves a different problem
- This post assumes you have the VPC stack from Post #1 deployed (with its exports)

### 2. Cross-Stack References — Export and ImportValue

#### 2.1 How Exports Work

- Any output with an `Export` block becomes available Region-wide
- Export names must be unique within a Region (across all stacks in the account)
- Naming convention: `${AWS::StackName}-ResourceName` to avoid collisions
- Exports are read-only — you can't modify an export that's being imported by another stack

#### 2.2 Building a Security Group Stack That Imports the VPC

- Full template: creates security groups using `!ImportValue` to get the VPC ID from the VPC stack
- `Fn::ImportValue` with `Fn::Sub` for dynamic export name resolution
- Layered security groups: WebServerSG (public-facing, ports 80/443), AppServerSG (internal, port 8080 from WebServerSG only)
- The SG stack exports its own values — enabling further downstream stacks

#### 2.3 The Deletion Dependency

- Try to delete the VPC stack → fails with `DELETE_FAILED`
- CloudFormation prevents deleting a stack whose exports are consumed by other stacks
- This is a feature, not a bug — it prevents accidentally breaking dependent infrastructure
- Resolution: delete importing stacks first, or remove `!ImportValue` references
- `aws cloudformation list-imports` to find who's consuming an export

#### 2.4 Limitations and Alternatives

- Same-Region only (until `Fn::GetStackOutput` which enables cross-account/cross-Region)
- Can't use `!ImportValue` inside conditions or with `!If`
- Alternative: SSM Parameter Store for cross-Region/cross-account sharing
- Alternative: pass values as parameters via CI/CD pipeline

### 3. Nested Stacks — Same Lifecycle Composition

#### 3.1 When to Use Nested Stacks

- Reusable components (e.g., a VPC module used by multiple parent stacks)
- Overcoming the 500-resource limit per stack
- Same team owns parent and children — they deploy together
- Parent-child relationship: parent creates/updates/deletes children

#### 3.2 Creating a Nested Stack

- The parent template uses `AWS::CloudFormation::Stack` resource type
- `TemplateURL` must point to an S3 URL (not a local file)
- Passing parameters from parent to child via `Parameters` property
- Getting outputs from child via `!GetAtt NestedStack.Outputs.OutputName`

#### 3.3 Example: VPC + Security Groups as Nested Stacks

- Upload child templates to S3
- Parent template references children with `AWS::CloudFormation::Stack`
- Show parameter passing: parent's Environment parameter flows to children
- Show output retrieval: parent gets VPC ID from VPC child, passes it to SG child

#### 3.4 Nested vs. Cross-Stack — Decision Framework

| Aspect | Cross-Stack References | Nested Stacks |
|--------|----------------------|---------------|
| Lifecycle | Independent | Same (parent controls) |
| Ownership | Different teams | Same team |
| Deployment | Separate `create-stack` calls | Single parent deployment |
| Deletion order | Manual dependency awareness | Parent handles order |
| Template storage | Local or S3 | Must be in S3 |
| Resource limit | 500 per stack | 500 per stack, but multiple stacks |

### 4. Stack Policies — Protecting Critical Resources

#### 4.1 What Stack Policies Do

- Prevent accidental replacement or deletion of critical resources during updates
- Applied per-stack — control which update actions are allowed on which resources
- Once set, a stack policy can't be removed — only replaced with a new one
- Default behavior without a policy: all updates allowed on all resources

#### 4.2 Applying a Stack Policy

- `set-stack-policy` command with JSON body
- Policy structure: `Statement` array with `Effect`, `Action`, `Principal`, `Resource`
- Actions: `Update:Modify`, `Update:Replace`, `Update:Delete`, `Update:*`
- Resource patterns: `LogicalResourceId/VPC`, `LogicalResourceId/*` (wildcard)
- Example: allow all updates except replacement of the VPC resource

#### 4.3 Temporarily Overriding a Stack Policy

- `--stack-policy-during-update-body` flag on `update-stack`
- The override is temporary — applies only to that specific update operation
- Use case: planned migration that requires replacing a protected resource

### 5. Drift Detection — Finding Manual Changes

#### 5.1 What Drift Is

- Drift = difference between the template definition and the actual resource configuration
- Causes: manual console changes, CLI/SDK modifications, other IaC tools touching the same resources
- Drift detection reads current state and compares to expected state

#### 5.2 Running Drift Detection

- `detect-stack-drift` starts an async operation
- `describe-stack-drift-detection-status` polls for completion
- `describe-stack-resource-drifts` shows the diffs
- Drift statuses: `IN_SYNC`, `MODIFIED`, `DELETED`, `NOT_CHECKED`
- Show example: manually tag a resource, detect drift, see the property difference

#### 5.3 Limitations and Remediation

- Drift detection doesn't auto-fix — it only reports
- Not all resource types support drift detection
- To remediate: update the template to match reality, or fix the resource to match the template
- For automated enforcement: use AWS Config rules (not CloudFormation drift detection)
- Import existing resources into a stack to bring them under management

### 6. StackSets — Multi-Account, Multi-Region Deployment

#### 6.1 StackSets Concepts

- StackSet = a template + configuration that deploys stack instances across targets
- Stack instance = one stack in one account in one Region
- Operations: create, update, delete stack instances
- Deployment targets: specific account IDs (self-managed) or OUs (service-managed)

#### 6.2 Permission Models

- **Self-managed**: you create `AWSCloudFormationStackSetAdministrationRole` in the admin account and `AWSCloudFormationStackSetExecutionRole` in each target account. More setup, full control.
- **Service-managed (Organizations)**: AWS auto-creates roles via trusted access. Target by OU. Auto-deploys to new accounts. Less setup, preferred for Organizations.
- Show IAM role creation for self-managed model
- Show trusted access enablement for service-managed model

#### 6.3 Deploying a Security Baseline Across Regions

- Template: creates an S3 bucket for security audit logs with encryption, versioning, and public access block
- `create-stack-set` with the template
- `create-stack-instances` targeting two Regions in the same account
- Verify with `list-stack-instances`

#### 6.4 Deployment Controls

- `MaxConcurrentCount` / `MaxConcurrentPercentage` — how many targets deploy simultaneously
- `FailureToleranceCount` / `FailureTolerancePercentage` — how many failures before the operation stops
- Example scenario: deploy to 200 accounts, 10 at a time, stop if more than 5 fail
- Region ordering: StackSets deploys to Regions in the order you specify

#### 6.5 Auto-Deployment with Organizations

- Service-managed StackSets + `AutoDeployment: enabled` on an OU
- When a new account joins the OU, the StackSet automatically deploys to it
- When an account leaves the OU, the stack instance can be retained or deleted
- This is how organizations enforce guardrails: Config rules, CloudTrail, IAM boundaries

### 7. Clean Up

- Delete stack instances from StackSet (with `--no-retain-stacks`)
- Delete the StackSet
- Delete IAM roles for StackSets
- Delete cross-stack demo stacks in dependency order (SG stack first, then VPC stack)
- Delete S3 buckets created by StackSets

### 8. Conclusion

- Cross-stack references for independent stacks that share data within a Region
- Nested stacks for reusable components deployed together under one parent
- Stack policies and drift detection for governance and change control
- StackSets for deploying at scale across accounts and Regions
- DOP-C02 exam tips: know the deletion dependency of exports, know self-managed vs. service-managed StackSets, know that drift detection doesn't auto-remediate

---

## Key Diagrams

1. Cross-stack reference flow: VPC stack exports → SG stack imports → App stack imports
2. Nested stack hierarchy: parent → child stacks with parameter passing and output retrieval
3. StackSet deployment model: admin account → stack instances across accounts/Regions
4. Self-managed vs. service-managed permission flow

---

## Sources & References

- [Fn::ImportValue — AWS CloudFormation User Guide](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-importvalue.html)
- [Refer to resource outputs in another CloudFormation stack](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/walkthrough-crossstackref.html)
- [Get exported outputs from a deployed CloudFormation stack](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-stack-exports.html)
- [Managing stacks across accounts and Regions with StackSets](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/what-is-cfnstacksets.html)
- [StackSets concepts](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/stacksets-concepts.html)
- [StackSets deployment strategies — AWS DevOps Blog](https://aws.amazon.com/blogs/devops/stacksets-deployment-strategies-balancing-speed-safety-and-scale-to-optimize-deployments-for-different-organizational-needs/)
- [Simplify cross-account and cross-Region stack output references with Fn::GetStackOutput — AWS DevOps Blog](https://aws.amazon.com/blogs/devops/simplify-cross-account-and-cross-region-stack-output-references-with-aws-cloudformation-and-cdks-new-fngetstackoutput/)
- [Reference resources across stacks — AWS Knowledge Center](https://aws.amazon.com/premiumsupport/knowledge-center/cloudformation-reference-resource/)
