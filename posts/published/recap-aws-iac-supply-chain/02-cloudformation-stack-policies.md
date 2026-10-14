# Protecting CloudFormation Resources with Stack Policies

Every CloudFormation update carries a quiet risk: a single property change can force CloudFormation to destroy and recreate a resource. Change a VPC's CIDR, an RDS instance's storage encryption, or an EC2 instance's subnet, and the update won't modify the resource in place — it will replace it. For a stateless resource that's harmless. For a production database, a VPC, or a KMS key, it's an outage or data loss.

By default, anyone with `cloudformation:UpdateStack` permission can trigger that replacement. Stack policies are the guardrail that stops it. A stack policy is a JSON document attached to a stack that declares which update actions are allowed on which resources — a resource-level lock that survives across every update until you deliberately lift it.

This post assumes you have the VPC stack from the [CloudFormation from Scratch](https://builder.aws.com/content/3GamoTD5mMBFcWf2ORBQcEmKV4c/cloudformation-from-scratch-building-a-production-ready-vpc-step-by-step) post deployed with the stack name `dev-vpc`. We'll attach a policy that protects the VPC from accidental replacement.

## What Stack Policies Do

Stack policies prevent accidental replacement or deletion of critical resources during stack updates. Without a policy, `update-stack` can replace any resource — including your production VPC, database, or encryption key — if the update requires it.

A stack policy specifies which update actions are allowed on which resources. A few behaviors are worth internalizing before writing one:

- Once set, a stack policy **cannot be removed** — only replaced with a new one.
- Without a policy, the default is: all update actions allowed on all resources.
- With a policy, the default flips: **all updates are denied** unless explicitly allowed.
- Policies are evaluated during `update-stack` and `execute-change-set` operations. They do **not** apply to `create-stack` or `delete-stack`, and they don't restrict changes made outside CloudFormation (a direct console or API edit to a resource bypasses them entirely).

That second-to-last point is the one that trips people up: the moment you attach any policy, everything not explicitly allowed is denied. A policy that only lists a Deny will silently block every other update too.

## Applying a Stack Policy

Set a stack policy on the VPC stack that allows all modifications but prevents replacement of the VPC resource itself. This protects against CIDR changes that would trigger VPC recreation:

```bash
aws cloudformation set-stack-policy \
  --stack-name dev-vpc \
  --stack-policy-body '{
    "Statement": [
      {
        "Effect": "Allow",
        "Action": "Update:*",
        "Principal": "*",
        "Resource": "*"
      },
      {
        "Effect": "Deny",
        "Action": "Update:Replace",
        "Principal": "*",
        "Resource": "LogicalResourceId/VPC"
      }
    ]
  }'
```

The policy structure:

- **`Effect`** — `Allow` or `Deny`.
- **`Action`** — which update action to control: `Update:Modify` (in-place changes), `Update:Replace` (destroy and recreate), `Update:Delete` (remove the resource), or `Update:*` (all).
- **`Principal`** — always `"*"`. Stack policies don't support IAM principal filtering; use IAM policies for that.
- **`Resource`** — which logical resources: `LogicalResourceId/VPC` for a specific resource, or `LogicalResourceId/*` for all resources.

The statements are evaluated together. If both Allow and Deny apply to the same action on the same resource, **Deny wins** — the same evaluation logic as IAM. So this policy reads: allow all update actions on all resources, except deny replacement of the VPC.

Verify the policy is in place:

```bash
aws cloudformation get-stack-policy --stack-name dev-vpc
```

```json
{
    "StackPolicyBody": "{\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"Update:*\",\"Principal\":\"*\",\"Resource\":\"*\"},{\"Effect\":\"Deny\",\"Action\":\"Update:Replace\",\"Principal\":\"*\",\"Resource\":\"LogicalResourceId/VPC\"}]}"
}
```

Now try to change the VPC CIDR — a property whose update requires replacement.

```bash
aws cloudformation update-stack \
  --stack-name dev-vpc \
  --template-body file://vpc.yaml \
  --parameters ParameterKey=Environment,ParameterValue=dev \
               ParameterKey=VpcCidr,ParameterValue=10.1.0.0/16
```

```json
{
    "StackId": "arn:aws:cloudformation:us-east-1:123456789012:stack/dev-vpc/83f30a60-...",
    "OperationId": "47b79e20-..."
}
```

That looks like success, but it isn't — CloudFormation is about to hit the stack policy and roll back in the background. To actually observe the failure, block on the operation with `wait`, which exits non-zero when the update fails:

```bash
aws cloudformation wait stack-update-complete --stack-name dev-vpc
```

```
Waiter StackUpdateComplete failed: Waiter encountered a terminal failure
state: For expression "Stacks[].StackStatus" we matched expected path:
"UPDATE_ROLLBACK_COMPLETE" at least once
```

The waiter tells you the update failed, but not *why*. For the actual stack-policy denial, query the stack events:

```bash
aws cloudformation describe-stack-events --stack-name dev-vpc \
  --query "StackEvents[?ResourceStatus=='UPDATE_FAILED'].[LogicalResourceId,ResourceStatusReason]" \
  --output text
```

```
VPC    Action denied by stack policy: Statement [#1] does not allow [Update:Replace] for resource [LogicalResourceId/VPC];
```

There's the guardrail working as intended. CloudFormation blocked the replacement and rolled the stack back to `UPDATE_ROLLBACK_COMPLETE`, leaving the original VPC untouched.

If you'd rather watch this unfold visually, run the update from the CloudFormation console instead. The stack's **Events** tab streams each resource status in near real time — you'll see `VPC` transition to `UPDATE_FAILED` with the denial reason inline, followed by the rollback, without polling anything by hand.

## Temporarily Overriding a Stack Policy

Sometimes you legitimately need to replace a protected resource — a planned migration, a CIDR block change, or a resource rename. Stack policies support a temporary override that applies only to a single update operation:

```bash
aws cloudformation update-stack \
  --stack-name dev-vpc \
  --template-body file://vpc.yaml \
  --parameters ParameterKey=Environment,ParameterValue=dev \
               ParameterKey=VpcCidr,ParameterValue=10.1.0.0/16 \
  --stack-policy-during-update-body '{
    "Statement": [
      {
        "Effect": "Allow",
        "Action": "Update:*",
        "Principal": "*",
        "Resource": "*"
      }
    ]
  }'
```

The `--stack-policy-during-update-body` temporarily permits all actions for this specific update. Once the update completes (or fails), the original restrictive policy is back in effect. The override is never persisted.

One caveat: the temporary override only works with `update-stack`. If you apply changes by executing a change set, CloudFormation enforces the existing stack policy and gives you no way to override it for that operation — you'd need to reset the policy first with `set-stack-policy`.

This separation of concerns is deliberate: the stack policy protects against accidents, but doesn't prevent intentional changes by someone who explicitly overrides it. For true prevention, combine stack policies with IAM policies that deny `cloudformation:SetStackPolicy` and `cloudformation:UpdateStack` (with the override parameter) for non-admin roles.

## Stack Policies vs. Other Protection Mechanisms

Stack policies are one of several overlapping guardrails, and they solve a specific slice of the problem. It helps to know where each one applies:

| Mechanism | Protects against | Scope | Applies to |
|-----------|------------------|-------|------------|
| Stack policy | Update/replace/delete of resources during a stack update | Individual resources within a stack | `update-stack`, `execute-change-set` |
| `DeletionPolicy` | Losing a resource when it's removed from the template or the stack is deleted | Per-resource attribute | Resource removal, stack deletion |
| `UpdateReplacePolicy` | Losing data when a resource is replaced during an update | Per-resource attribute | Resource replacement on update |
| Termination protection | Deleting the whole stack | Entire stack | `delete-stack` |
| IAM policies | Who can call which CloudFormation and resource APIs at all | Principal-level | All API calls |

The key distinction: stack policies guard the *update* path and are stack-scoped, `DeletionPolicy` and `UpdateReplacePolicy` are template attributes that guard removal and replacement, termination protection guards the whole stack from deletion, and IAM controls who can do any of it. Layered together, they give you defense in depth. Stack policies alone won't stop a stack deletion or an out-of-band console edit.

## Clean Up

A stack policy can't be deleted, so to remove protection you replace it with an allow-all policy. There's nothing else to tear down if you're keeping the VPC stack:

```bash
# Reset to allow-all (effectively removing protection)
aws cloudformation set-stack-policy \
  --stack-name dev-vpc \
  --stack-policy-body '{
    "Statement": [
      {
        "Effect": "Allow",
        "Action": "Update:*",
        "Principal": "*",
        "Resource": "*"
      }
    ]
  }'
```

If you're done with the VPC stack entirely, delete it:

```bash
aws cloudformation delete-stack --stack-name dev-vpc
aws cloudformation wait stack-delete-complete --stack-name dev-vpc
```

## Conclusion

Stack policies are a narrow but important guardrail: they stop CloudFormation updates from replacing or deleting the resources you can't afford to lose. Attach a policy that allows everything except replacement of your critical resources, and an accidental CIDR change or property edit fails loudly instead of silently recreating your VPC.

Two behaviors define how you work with them. First, attaching any policy flips the default to deny-all, so you always need an explicit Allow for the updates you *do* want. Second, the policy can't be removed — you replace it, and you override it for a single update with `--stack-policy-during-update-body` when you genuinely need to make a protected change.

Stack policies don't stand alone. Pair them with `DeletionPolicy` and `UpdateReplacePolicy` to protect data, termination protection to guard the whole stack, and IAM to control who can change any of it.

Are you looking in to making the most of cloudformation for your use case? [Let's talk!](mailto:hector@agilityfeat.com)