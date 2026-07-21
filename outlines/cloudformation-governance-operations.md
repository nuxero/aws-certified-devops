# Outline: CloudFormation Governance & Operations

## Working Title

**CloudFormation Governance & Operations: Drift Detection, Resource Imports, and Keeping Stacks Healthy**

---

## Target Audience

DevOps engineers running CloudFormation in production who need to handle the operational reality: manual changes creep in, resources exist outside stacks, stacks fail and need recovery, and critical resources need protection beyond stack policies. Also targeting DOP-C02 exam candidates — drift detection, resource imports, and termination protection are tested in Domain 2 (Configuration Management and IaC) and Domain 6 (Monitoring and Logging).

---

## Core Premise

Building stacks is the fun part. Keeping them healthy over months and years is the real job. People make manual changes in the console during incidents, resources get created outside CloudFormation by scripts or other tools, stacks end up in unrecoverable states, and someone inevitably deletes a production stack by accident. This post covers the operational toolbox: detecting when stacks drift from their templates, importing existing resources into CloudFormation management, recovering from failed operations, and protecting stacks from accidental destruction.

---

## Self-Contained Post Requirements

- All code inline (CLI commands with expected outputs, IAM policies, CloudFormation templates)
- Each code snippet preceded by a paragraph explaining what the code does
- Mermaid diagram showing drift detection workflow and resource import lifecycle
- Hands-on walkthrough: introduce drift, detect it, remediate it
- Hands-on walkthrough: import an existing resource into a stack
- Stack recovery commands with expected outputs
- Can be followed with any existing stack (uses the VPC from Post #1 for examples)

---

## Post Structure

### 1. Introduction — The Operational Reality

- Your stacks don't exist in a vacuum: people touch resources manually, automation runs outside CloudFormation, incidents require hotfixes
- Four operational concerns: drift (what changed?), unmanaged resources (what's not in a stack?), failed stacks (how do I recover?), accidental deletion (how do I prevent catastrophe?)
- This post is the "day 2 operations" guide — assumes you've already built stacks with CloudFormation

### 2. Drift Detection — Finding What Changed

#### 2.1 What Drift Is

- Definition: the difference between a resource's expected state (from the template) and its actual state in AWS
- Common causes: console edits during incidents, CLI/SDK scripts, other IaC tools, AWS service-initiated changes
- What drift detection does: reads current resource state, compares to last known state from CloudFormation, reports differences
- What it doesn't do: auto-fix, continuously monitor, detect newly created resources outside the stack

#### 2.2 Running Drift Detection

- `detect-stack-drift` starts an async operation (returns a detection ID)
- `describe-stack-drift-detection-status` polls for completion
- `describe-stack-resource-drifts` shows per-resource diffs
- Walkthrough: manually tag the VPC (simulate console edit), run detection, inspect the diff
- Four drift statuses: `IN_SYNC`, `MODIFIED`, `DELETED`, `NOT_CHECKED`
- Property-level diffs: expected vs. actual for each drifted property

#### 2.3 Detecting Drift on Specific Resources

- `detect-stack-resource-drift` for a single resource (faster than full-stack detection)
- Useful when you know exactly which resource was modified
- Same output format as full-stack detection

#### 2.4 Limitations

- Not all resource types support drift detection (check the supported list)
- Detection is point-in-time — no continuous monitoring
- Cannot detect resources added outside the stack (only checks managed resources)
- Some properties are write-only (like passwords) and can't be compared
- Nested stacks: drift detection covers the parent; you must run it separately on each child

#### 2.5 Remediation Strategies

- **Template matches reality**: update the template to include the manual change, then `update-stack`. Drift disappears because the template now reflects truth.
- **Reality matches template**: revert the manual change (delete the extra tag, restore the SG rule), then re-run drift detection to confirm `IN_SYNC`.
- **Continuous enforcement**: drift detection is reactive. For proactive enforcement, use AWS Config rules that trigger remediation automatically.

### 3. Resource Imports — Adopting Existing Resources

#### 3.1 Why Import Resources

- Resources created manually before you adopted IaC
- Resources created by automation/scripts that should now be CloudFormation-managed
- Resources left behind when a stack was deleted with `--retain-resources`
- Moving a resource from one stack to another (export from old stack with retain, import into new stack)

#### 3.2 How Resource Import Works

- You add the resource to your template (with its actual configuration)
- You create an import change set specifying the resource identifier
- CloudFormation associates the existing resource with the stack without modifying it
- The resource now appears in the stack and future updates are managed by CloudFormation

#### 3.3 Walkthrough: Importing an Existing S3 Bucket

- Create a bucket manually via CLI (simulating a pre-existing resource)
- Write a template that describes the bucket with its current configuration
- Create the import change set
- Execute the change set
- Verify the bucket is now managed by the stack
- Run drift detection to confirm `IN_SYNC`

#### 3.4 Walkthrough: Moving a Resource Between Stacks

- Remove a resource from Stack A using `retain` (resource persists, just leaves the stack)
- Import it into Stack B
- Use case: reorganizing stack boundaries without recreating resources

#### 3.5 Rules and Limitations

- Each resource type has a specific identifier for import (e.g., bucket name for S3, VPC ID for VPC)
- The template must describe the resource's current configuration accurately — if it differs, the import succeeds but the next update will try to "fix" the drift
- Only one resource can be imported per change set (you can batch, but each resource needs its own identifier mapping)
- Some resource types don't support import (check the supported list)
- Cannot import a resource that's already managed by another stack
- `DeletionPolicy` and `UpdateReplacePolicy` should be set before importing stateful resources

### 4. Termination Protection — Preventing Accidental Deletion

#### 4.1 What Termination Protection Does

- When enabled, `delete-stack` calls are rejected
- Must be explicitly disabled before a stack can be deleted
- Independent from stack policies (which protect against updates, not deletion)
- Applies to the stack as a whole, not individual resources

#### 4.2 Enabling and Disabling

- On stack creation: `--enable-termination-protection` flag
- On existing stacks: `update-termination-protection --enable-termination-protection`
- To delete a protected stack: first disable protection, then delete
- For nested stacks: protection on the parent doesn't protect children individually — but deleting the parent would fail, which transitively protects children

#### 4.3 Combining Protections

- Termination protection: prevents stack deletion
- Stack policies: prevent resource replacement/deletion during updates
- `DeletionPolicy: Retain`: resource survives even if the stack is deleted
- `UpdateReplacePolicy: Retain`: resource survives even if CloudFormation wants to replace it
- IAM policies: restrict who can call `DeleteStack` or `UpdateTerminationProtection`
- Defense in depth: use all of these together for production databases and stateful resources

### 5. Recovering from Failed Stack Operations

#### 5.1 Understanding Stack States

- `CREATE_FAILED` / `CREATE_COMPLETE` / `ROLLBACK_COMPLETE`
- `UPDATE_FAILED` / `UPDATE_ROLLBACK_COMPLETE` / `UPDATE_ROLLBACK_FAILED`
- `DELETE_FAILED`
- When you're stuck: `ROLLBACK_COMPLETE` (can only be deleted), `UPDATE_ROLLBACK_FAILED` (needs manual intervention)

#### 5.2 Continuing an Update Rollback

- `UPDATE_ROLLBACK_FAILED`: the rollback itself failed — the stack is stuck
- `continue-update-rollback` with `--resources-to-skip` to skip the problematic resource
- Use case: a resource was manually deleted during the failed update, so CloudFormation can't roll it back
- Walkthrough: trigger a failed update, get stuck in `UPDATE_ROLLBACK_FAILED`, skip the resource, recover

#### 5.3 Handling DELETE_FAILED

- Common causes: non-empty S3 buckets, resources with deletion protection, dependencies outside CloudFormation
- `delete-stack --retain-resources` to skip specific resources and continue deletion
- The retained resources still exist in AWS — now unmanaged. Import them into another stack or delete manually.

#### 5.4 Rollback Configuration

- `MonitoringTimeInMinutes`: how long CloudFormation monitors after an update before considering it successful
- `RollbackTriggers`: CloudWatch alarm ARNs that trigger automatic rollback if they go into ALARM state during or after an update
- Example: update an Auto Scaling Group, monitor its health alarm for 5 minutes, auto-rollback if the alarm fires

### 6. Operational Best Practices

- Enable termination protection on all production stacks
- Set `DeletionPolicy: Retain` on databases, encryption keys, and any stateful resource
- Run drift detection on a schedule (via EventBridge + Lambda) and alert on drift
- Use AWS Config rule `cloudformation-stack-drift-detection-check` for continuous monitoring
- Use change sets for all production updates — never direct `update-stack`
- Tag stacks with ownership, environment, and cost center for accountability
- Set up SNS notifications for stack events (`--notification-arns` on create/update)

### 7. Clean Up

- Remove termination protection from demo stacks
- Delete demo stacks
- Delete manually created resources used in import examples

### 8. Conclusion

- Drift detection reveals manual changes — but you must remediate (it doesn't auto-fix)
- Resource imports bring unmanaged resources under CloudFormation control without recreation
- Termination protection + stack policies + DeletionPolicy form defense in depth
- `continue-update-rollback` and `--retain-resources` are your recovery tools for stuck stacks
- DOP-C02 exam tips: know drift doesn't auto-remediate, know resource import requires matching configuration, know `continue-update-rollback --resources-to-skip`, know termination protection is separate from stack policies

---

## Key Diagrams

1. Drift detection workflow: manual change → detect → compare → report → remediate
2. Resource import lifecycle: existing resource → template + change set → managed by stack
3. Stack state machine: the possible states and transitions, highlighting recovery paths
4. Defense in depth: layers of protection (termination protection → stack policy → DeletionPolicy → IAM)

---

## Sources & References

- [Detect unmanaged configuration changes to stacks and resources (drift detection) — AWS CloudFormation User Guide](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-stack-drift.html)
- [Resource type support for drift detection — AWS CloudFormation User Guide](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resource-import-supported-resources.html)
- [Import existing resources into a CloudFormation stack — AWS CloudFormation User Guide](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resource-import.html)
- [Protect a CloudFormation stack from being deleted — AWS CloudFormation User Guide](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-protect-stacks.html)
- [DeletionPolicy attribute — AWS CloudFormation User Guide](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-attribute-deletionpolicy.html)
- [continue-update-rollback — AWS CLI Reference](https://docs.aws.amazon.com/cli/latest/reference/cloudformation/continue-update-rollback.html)
- [Monitor stack status with rollback triggers — AWS CloudFormation User Guide](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-rollback-triggers.html)
- [cloudformation-stack-drift-detection-check — AWS Config Managed Rules](https://docs.aws.amazon.com/config/latest/developerguide/cloudformation-stack-drift-detection-check.html)
