# Outline: Advanced CloudFormation — Custom Resources with Lambda

## Working Title

**Advanced CloudFormation: Extending Stack Capabilities with Lambda-Backed Custom Resources**

---

## Target Audience

DevOps engineers who need CloudFormation to do things it doesn't natively support — looking up AMI IDs, creating resources in third-party systems, running validation logic during stack operations, or cleaning up resources on deletion. Also targeting DOP-C02 exam candidates — custom resources (Lambda-backed and SNS-backed) are a recurring exam topic when the question involves "CloudFormation doesn't support X" or "need to run custom logic during stack operations."

---

## Core Premise

CloudFormation supports hundreds of resource types, but sometimes you need it to do something custom: look up dynamic values, call external APIs, configure resources that aren't supported, or run cleanup logic on stack deletion. Lambda-backed custom resources solve this by letting you run arbitrary code during stack create, update, and delete operations. This post builds three practical custom resources from scratch, covering the request/response protocol, error handling, and real-world patterns.

---

## Self-Contained Post Requirements

- All code inline (Python Lambda functions, YAML templates, CLI commands, IAM policies)
- Each code snippet preceded by a paragraph explaining what the code does, with inline comments referencing the explanation
- Mermaid diagram showing the custom resource lifecycle (CloudFormation → Lambda → ResponseURL)
- Three complete custom resource examples with increasing complexity
- Error handling patterns and debugging guidance

---

## Post Structure

### 1. Introduction — When CloudFormation Isn't Enough

- CloudFormation supports 700+ resource types, but gaps exist
- Common scenarios: dynamic AMI lookup, DNS validation for ACM certificates, populating DynamoDB tables with seed data, cleaning up S3 bucket objects before deletion, calling external APIs
- Custom resources bridge the gap: CloudFormation invokes your Lambda, your Lambda does the work, reports back
- Two flavors: Lambda-backed (`ServiceToken` → Lambda ARN) and SNS-backed (`ServiceToken` → SNS Topic ARN) — this post focuses on Lambda-backed
- The `cfn-response` module vs. manual response — we'll use manual for clarity and control

### 2. How Custom Resources Work — The Protocol

#### 2.1 The Request Lifecycle

- Mermaid diagram: CloudFormation creates custom resource → invokes Lambda with event → Lambda does work → Lambda sends response to pre-signed S3 URL (ResponseURL) → CloudFormation reads response and continues
- Three request types: `Create`, `Update`, `Delete`
- If the Lambda doesn't respond (crash, timeout, network issue), CloudFormation waits up to 1 hour then fails the stack operation

#### 2.2 The Request Event Structure

- `RequestType`: Create | Update | Delete
- `ResponseURL`: pre-signed S3 URL where the response must be PUT
- `StackId`, `RequestId`, `LogicalResourceId`: identify the custom resource instance
- `ResourceProperties`: the properties you defined in the template (your custom inputs)
- `OldResourceProperties`: only on Update — the previous properties (enables diffing)
- `PhysicalResourceId`: on Update/Delete — the physical resource ID returned by previous Create/Update

#### 2.3 The Response Structure

- `Status`: SUCCESS or FAILED
- `Reason`: error message (shown in stack events)
- `PhysicalResourceId`: your chosen resource identifier — changing it on Update triggers a Delete of the old resource
- `Data`: key-value pairs accessible via `!GetAtt CustomResource.Key`
- `NoEcho`: set to true to mask Data values in console/API responses (for secrets)

#### 2.4 Critical Rules

- Always respond — even on failure. If you don't, the stack hangs for up to 1 hour.
- Use try/except around everything and respond with FAILED on exception
- `PhysicalResourceId` must be stable for the same logical resource — changing it causes replacement (Delete old + Create new)
- On Delete: clean up whatever you created. If there's nothing to clean up, still respond SUCCESS.

### 3. Example 1 — AMI Lookup (Dynamic Value at Deploy Time)

#### 3.1 The Use Case

- You want the latest Amazon Linux 2023 AMI ID without hardcoding it in the template
- Alternative: SSM Parameter Store public parameters (simpler for AMIs specifically) — but this example teaches the custom resource pattern
- The custom resource runs `ec2:DescribeImages`, sorts by creation date, returns the newest AMI ID

#### 3.2 The Lambda Function

- Full Python code: handler receives event, calls EC2 API, sorts results, builds response, PUTs to ResponseURL
- Error handling: wrap in try/except, always send response
- On Delete: nothing to clean up, respond SUCCESS immediately
- On Update: re-run the lookup (AMI might have changed)
- Permissions needed: `ec2:DescribeImages`

#### 3.3 The CloudFormation Template

- Define the Lambda function inline or reference a zip in S3
- Define the IAM role for the Lambda (assume role policy for lambda.amazonaws.com + describe images permission)
- Define the custom resource: `Type: Custom::AmiLookup` with `ServiceToken: !GetAtt LookupFunction.Arn`
- Use the result: `!GetAtt AmiLookup.AmiId` in an EC2 instance resource's `ImageId` property
- Full working template that deploys and returns the AMI ID as an output

#### 3.4 Deploy and Test

- Deploy the stack, observe the custom resource in stack events
- Check CloudWatch Logs for the Lambda execution
- Stack outputs show the dynamically looked-up AMI ID

### 4. Example 2 — S3 Bucket Emptier (Cleanup on Delete)

#### 4.1 The Use Case

- CloudFormation can't delete an S3 bucket that contains objects
- Stack deletion fails with "bucket not empty" — you have to manually empty it first
- Custom resource: on Delete, list and delete all objects (including versions), then respond SUCCESS
- On Create/Update: do nothing (the bucket is managed by a separate CloudFormation resource)

#### 4.2 The Lambda Function

- Full Python code: on Delete, paginate through `list_object_versions`, batch-delete all objects and delete markers
- Handle empty buckets gracefully
- On Create: respond with the bucket name as PhysicalResourceId
- Permissions needed: `s3:ListBucketVersions`, `s3:DeleteObject`, `s3:DeleteObjectVersion`
- Set Lambda timeout to 300s (large buckets take time)

#### 4.3 The CloudFormation Template

- S3 bucket with `DeletionPolicy: Delete` (CloudFormation will try to delete it)
- Custom resource with `DependsOn: MyBucket` — but this isn't enough for deletion ordering
- The trick: make the custom resource's `PhysicalResourceId` reference the bucket name — on stack deletion, CloudFormation deletes the custom resource first (triggers the emptier), then deletes the bucket
- Actually the correct pattern: the custom resource has no DependsOn, but its `ServiceToken` references the Lambda, and you pass the bucket name/ARN as a property

#### 4.4 Deletion Ordering Nuance

- CloudFormation deletes resources in reverse dependency order
- If the custom resource depends on the bucket (via `!Ref` in its properties), CloudFormation deletes the custom resource first → Lambda empties the bucket → then CloudFormation deletes the now-empty bucket
- This is a common pattern that appears on the exam

### 5. Example 3 — External API Call (Registering with a Third-Party Service)

#### 5.1 The Use Case

- Register a webhook URL with a third-party monitoring service during stack creation
- Deregister on stack deletion
- Update the registration if the URL changes
- This pattern applies to any external integration: Datadog, PagerDuty, Slack, custom APIs

#### 5.2 The Lambda Function

- Full Python code using `urllib.request` to call a hypothetical external API
- Create: POST to external API with configuration, store the returned registration ID as PhysicalResourceId
- Update: compare old vs. new properties — if URL changed, PUT to update the registration
- Delete: DELETE to external API using PhysicalResourceId
- Idempotency: handle cases where the external resource already exists or is already deleted
- Error handling: distinguish between retriable errors (network timeout) and permanent failures

#### 5.3 The CloudFormation Template

- Custom resource with `ServiceToken` and custom properties (WebhookUrl, AlertThreshold)
- Pass values from other stack resources (API Gateway URL, SNS topic ARN) as properties
- On stack update: if properties change, Lambda receives both old and new values

### 6. Error Handling and Debugging

#### 6.1 Common Failure Modes

- Lambda timeout → no response → stack hangs for 1 hour
- Exception before sending response → same as timeout
- Responding with `FAILED` but wrong `PhysicalResourceId` → orphaned resources
- Responding with `SUCCESS` on Delete but not actually cleaning up → resource leak

#### 6.2 Debugging Techniques

- CloudWatch Logs: every Lambda invocation is logged — check here first
- Stack events: show the custom resource status and reason
- Manual testing: invoke the Lambda with a synthetic event (provide a mock ResponseURL via RequestBin or a test S3 bucket)
- `cfn-response` module: simpler but less control — available for Python and Node.js inline code

#### 6.3 Best Practices

- Set Lambda timeout shorter than CloudFormation's custom resource timeout (default 1 hour, configurable via stack-level timeout)
- Use a dead-letter queue on the Lambda for async failures
- Log the full event at the start of the handler (for debugging)
- Make operations idempotent — Create might be called multiple times if a previous attempt failed after creating the resource but before responding
- Use `PhysicalResourceId` to track what you created — it's your key for Update and Delete operations

### 7. CloudFormation Resource Types Module (Alternative)

- `AWS::CloudFormation::CustomResource` vs. `Custom::MyTypeName` — functionally identical
- CloudFormation Registry: publish your own resource types (written in Java, Python, Go, TypeScript)
- Registry resource types vs. custom resources: registry types have schema validation, are reusable across accounts via StackSets, and appear as native resources in the template
- When to use custom resources vs. registry types: custom resources for one-off logic, registry types for reusable shareable resource types

### 8. Clean Up

- Delete the custom resource stacks
- Delete the Lambda functions and IAM roles
- Verify no orphaned resources remain

### 9. Conclusion

- Custom resources extend CloudFormation with arbitrary logic
- The protocol: receive event → do work → PUT response to ResponseURL — never forget to respond
- Three patterns: value lookup (Create/Update return data), cleanup helper (Delete does the work), external integration (full CRUD lifecycle)
- DOP-C02 exam tips: know that `ServiceToken` points to a Lambda ARN or SNS topic ARN, know that failure to respond causes a 1-hour hang, know that `!GetAtt` retrieves values from the `Data` dict in the response

---

## Key Diagrams

1. Custom resource lifecycle: CloudFormation → Lambda invocation → work → response to S3 URL → CloudFormation continues
2. Request/response flow for Create, Update, Delete operations
3. Deletion ordering: how dependency graph determines when the custom resource Delete fires relative to other resources
4. Decision tree: when to use custom resources vs. SSM parameters vs. CloudFormation Registry types

---

## Sources & References

- [Lambda-backed custom resources — AWS CloudFormation User Guide](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/template-custom-resources-lambda.html)
- [Create custom provisioning logic with custom resources](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/template-custom-resources.html)
- [Using AWS Lambda with CloudFormation](https://docs.aws.amazon.com/lambda/latest/dg/services-cloudformation.html)
- [Walkthrough: Create a delay mechanism with a Lambda-backed custom resource](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/walkthrough-lambda-backed-custom-resources.html)
- [Using Lambda-backed custom resources to reduce overhead in a multi-account environment — AWS Blog](https://aws.amazon.com/blogs/mt/using-lambda-backed-custom-resources-to-reduce-overhead-in-a-multi-account-environment/)
- [Custom resource request objects — AWS CloudFormation User Guide](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref-requesttypes.html)
- [Custom resource response objects — AWS CloudFormation User Guide](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref-responses.html)
