# Session 3: Infrastructure as Code — Hands-On (Domain 2 — Configuration Management and IaC, 17%)

> **Task Statement 2.1:** Define cloud infrastructure and reusable components to provision and manage systems throughout their lifecycle.
>
> In this session you'll write CloudFormation templates from scratch, use change sets, stack policies, drift detection, cross-stack references, and custom resources. Then you'll build and deploy a serverless app with SAM, define infrastructure with CDK, and deploy across accounts with StackSets.

---

## Prerequisites

- [ ] AWS CLI v2 configured
- [ ] Node.js 18+ and npm installed (for CDK and SAM)
- [ ] AWS SAM CLI installed ([install guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html))
- [ ] AWS CDK CLI installed (`npm install -g aws-cdk`)
- [ ] Docker installed (for SAM local testing)
- [ ] Python 3.9+ (for the custom resource Lambda)
- [ ] ~$1–2 USD budget

**Estimated time:** 4–5 hours

---

## Lab 1: CloudFormation Fundamentals — Build a VPC from Scratch

**What you'll learn:** Template anatomy, parameters, mappings, conditions, intrinsic functions, outputs, and exports.

### Step 1 — Write the template

Create a working directory:

```bash
mkdir -p iac-labs/cfn && cd iac-labs/cfn
```

Create `vpc-stack.yaml`:

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: >
  DOP-C02 Lab - VPC with public and private subnets.
  Demonstrates parameters, mappings, conditions, and intrinsic functions.

Parameters:
  Environment:
    Type: String
    AllowedValues: [dev, staging, prod]
    Default: dev
    Description: Environment name

  VpcCidr:
    Type: String
    Default: 10.0.0.0/16
    AllowedPattern: '(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/(\d{1,2})'
    Description: CIDR block for the VPC

  EnableNatGateway:
    Type: String
    AllowedValues: ['true', 'false']
    Default: 'false'
    Description: Whether to create a NAT Gateway (costs ~$0.045/hr)

Mappings:
  SubnetConfig:
    Public1:
      CIDR: 10.0.1.0/24
    Public2:
      CIDR: 10.0.2.0/24
    Private1:
      CIDR: 10.0.10.0/24
    Private2:
      CIDR: 10.0.20.0/24

Conditions:
  IsProd: !Equals [!Ref Environment, prod]
  CreateNat: !Or
    - !Equals [!Ref EnableNatGateway, 'true']
    - !Condition IsProd  # Always create NAT in prod

Resources:
  VPC:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: !Ref VpcCidr
      EnableDnsSupport: true
      EnableDnsHostnames: true
      Tags:
        - Key: Name
          Value: !Sub '${Environment}-vpc'

  InternetGateway:
    Type: AWS::EC2::InternetGateway
    Properties:
      Tags:
        - Key: Name
          Value: !Sub '${Environment}-igw'

  AttachGateway:
    Type: AWS::EC2::VPCGatewayAttachment
    Properties:
      VpcId: !Ref VPC
      InternetGatewayId: !Ref InternetGateway

```yaml
  PublicSubnet1:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      CidrBlock: !FindInMap [SubnetConfig, Public1, CIDR]
      AvailabilityZone: !Select [0, !GetAZs '']
      MapPublicIpOnLaunch: true
      Tags:
        - Key: Name
          Value: !Sub '${Environment}-public-1'

  PublicSubnet2:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      CidrBlock: !FindInMap [SubnetConfig, Public2, CIDR]
      AvailabilityZone: !Select [1, !GetAZs '']
      MapPublicIpOnLaunch: true
      Tags:
        - Key: Name
          Value: !Sub '${Environment}-public-2'

  PrivateSubnet1:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      CidrBlock: !FindInMap [SubnetConfig, Private1, CIDR]
      AvailabilityZone: !Select [0, !GetAZs '']
      Tags:
        - Key: Name
          Value: !Sub '${Environment}-private-1'

  PrivateSubnet2:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref VPC
      CidrBlock: !FindInMap [SubnetConfig, Private2, CIDR]
      AvailabilityZone: !Select [1, !GetAZs '']
      Tags:
        - Key: Name
          Value: !Sub '${Environment}-private-2'

  PublicRouteTable:
    Type: AWS::EC2::RouteTable
    Properties:
      VpcId: !Ref VPC
      Tags:
        - Key: Name
          Value: !Sub '${Environment}-public-rt'

  PublicRoute:
    Type: AWS::EC2::Route
    DependsOn: AttachGateway
    Properties:
      RouteTableId: !Ref PublicRouteTable
      DestinationCidrBlock: 0.0.0.0/0
      GatewayId: !Ref InternetGateway

  PublicSubnet1RouteAssoc:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      SubnetId: !Ref PublicSubnet1
      RouteTableId: !Ref PublicRouteTable

  PublicSubnet2RouteAssoc:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      SubnetId: !Ref PublicSubnet2
      RouteTableId: !Ref PublicRouteTable

  # NAT Gateway — only created if condition is true
  NatEIP:
    Type: AWS::EC2::EIP
    Condition: CreateNat
    Properties:
      Domain: vpc

  NatGateway:
    Type: AWS::EC2::NatGateway
    Condition: CreateNat
    Properties:
      AllocationId: !GetAtt NatEIP.AllocationId
      SubnetId: !Ref PublicSubnet1
      Tags:
        - Key: Name
          Value: !Sub '${Environment}-nat'

  PrivateRouteTable:
    Type: AWS::EC2::RouteTable
    Properties:
      VpcId: !Ref VPC
      Tags:
        - Key: Name
          Value: !Sub '${Environment}-private-rt'

  PrivateRoute:
    Type: AWS::EC2::Route
    Condition: CreateNat
    Properties:
      RouteTableId: !Ref PrivateRouteTable
      DestinationCidrBlock: 0.0.0.0/0
      NatGatewayId: !Ref NatGateway

  PrivateSubnet1RouteAssoc:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      SubnetId: !Ref PrivateSubnet1
      RouteTableId: !Ref PrivateRouteTable

  PrivateSubnet2RouteAssoc:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      SubnetId: !Ref PrivateSubnet2
      RouteTableId: !Ref PrivateRouteTable

Outputs:
  VpcId:
    Description: VPC ID
    Value: !Ref VPC
    Export:
      Name: !Sub '${AWS::StackName}-VpcId'

  PublicSubnets:
    Description: Public subnet IDs
    Value: !Join [',', [!Ref PublicSubnet1, !Ref PublicSubnet2]]
    Export:
      Name: !Sub '${AWS::StackName}-PublicSubnets'

  PrivateSubnets:
    Description: Private subnet IDs
    Value: !Join [',', [!Ref PrivateSubnet1, !Ref PrivateSubnet2]]
    Export:
      Name: !Sub '${AWS::StackName}-PrivateSubnets'

  NatGatewayId:
    Condition: CreateNat
    Description: NAT Gateway ID
    Value: !Ref NatGateway
```

**What to notice in this template:**
- `!FindInMap` looks up CIDR blocks from the Mappings section
- `!Select [0, !GetAZs '']` picks the first AZ in the current Region
- `!Sub` does string interpolation with parameter and pseudo-parameter values
- `Condition: CreateNat` means those resources only exist when the condition is true
- `!Or` combines conditions — NAT is created if explicitly enabled OR if environment is prod
- `Export` in Outputs makes values available to other stacks via `!ImportValue`

### Step 2 — Validate and deploy

```bash
# Validate the template syntax
aws cloudformation validate-template --template-body file://vpc-stack.yaml

# Deploy as dev (no NAT gateway — saves money)
aws cloudformation create-stack \
  --stack-name iac-lab-vpc \
  --template-body file://vpc-stack.yaml \
  --parameters \
    ParameterKey=Environment,ParameterValue=dev \
    ParameterKey=EnableNatGateway,ParameterValue=false

# Watch the creation
aws cloudformation wait stack-create-complete --stack-name iac-lab-vpc
echo "Stack created!"

# Check the outputs
aws cloudformation describe-stacks --stack-name iac-lab-vpc \
  --query 'Stacks[0].Outputs[*].{Key:OutputKey,Value:OutputValue}'
```

### Step 3 — Explore what was created

```bash
# List all resources in the stack
aws cloudformation list-stack-resources --stack-name iac-lab-vpc \
  --query 'StackResourceSummaries[*].{Type:ResourceType,LogicalId:LogicalResourceId,Status:ResourceStatus}'
```

Notice that `NatEIP`, `NatGateway`, and `PrivateRoute` are NOT in the list — the condition evaluated to false.

**Experiment:** Deploy again with `Environment=prod` and observe that the NAT resources are created:

```bash
aws cloudformation create-stack \
  --stack-name iac-lab-vpc-prod \
  --template-body file://vpc-stack.yaml \
  --parameters \
    ParameterKey=Environment,ParameterValue=prod \
    ParameterKey=EnableNatGateway,ParameterValue=false

# Even though EnableNatGateway=false, the IsProd condition triggers NAT creation
aws cloudformation wait stack-create-complete --stack-name iac-lab-vpc-prod

aws cloudformation list-stack-resources --stack-name iac-lab-vpc-prod \
  --query 'StackResourceSummaries[?ResourceType==`AWS::EC2::NatGateway`]'
```

> **Important:** Delete the prod stack right away to avoid NAT Gateway charges (~$0.045/hr):
> ```bash
> aws cloudformation delete-stack --stack-name iac-lab-vpc-prod
> ```

**Exam takeaway:** Conditions control whether resources are created. The `!Or`, `!And`, `!Not`, `!Equals` functions build condition logic. Conditional resources don't appear in the stack if the condition is false.

### 🧹 Checkpoint

You've written a real CloudFormation template using Parameters, Mappings, Conditions, intrinsic functions, and Exports. Keep the `iac-lab-vpc` stack running — we'll use it in the next labs.

---

## Lab 2: Change Sets, Stack Policies, and Drift Detection

**What you'll learn:** How to safely update stacks, protect critical resources, and detect configuration drift.

### Step 1 — Create a change set

Let's add a tag to the VPC. Modify `vpc-stack.yaml` — add a tag to the VPC resource:

```yaml
  VPC:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: !Ref VpcCidr
      EnableDnsSupport: true
      EnableDnsHostnames: true
      Tags:
        - Key: Name
          Value: !Sub '${Environment}-vpc'
        - Key: ManagedBy
          Value: CloudFormation
```

Now create a change set instead of updating directly:

```bash
aws cloudformation create-change-set \
  --stack-name iac-lab-vpc \
  --change-set-name add-managed-tag \
  --template-body file://vpc-stack.yaml \
  --parameters ParameterKey=Environment,UsePreviousValue=true \
               ParameterKey=EnableNatGateway,UsePreviousValue=true

# Wait for it to be created
aws cloudformation wait change-set-create-complete \
  --stack-name iac-lab-vpc \
  --change-set-name add-managed-tag

# Review what will change
aws cloudformation describe-change-set \
  --stack-name iac-lab-vpc \
  --change-set-name add-managed-tag \
  --query 'Changes[*].{Action:ResourceChange.Action,Resource:ResourceChange.LogicalResourceId,Replacement:ResourceChange.Replacement}'
```

You'll see something like:
```json
[{ "Action": "Modify", "Resource": "VPC", "Replacement": "Never" }]
```

This tells you: the VPC will be modified in place, no replacement. Safe to proceed.

```bash
# Execute the change set
aws cloudformation execute-change-set \
  --stack-name iac-lab-vpc \
  --change-set-name add-managed-tag

aws cloudformation wait stack-update-complete --stack-name iac-lab-vpc
echo "Update complete!"
```

**Experiment:** Try a change that would cause a replacement. Change the VPC CIDR block in the template (e.g., to `10.1.0.0/16`), create a change set, and observe that it shows `Replacement: True` for the VPC. **Don't execute it** — just see how the change set warns you.

```bash
# Create a dangerous change set (don't execute!)
aws cloudformation create-change-set \
  --stack-name iac-lab-vpc \
  --change-set-name dangerous-cidr-change \
  --template-body file://vpc-stack.yaml \
  --parameters ParameterKey=Environment,UsePreviousValue=true \
               ParameterKey=EnableNatGateway,UsePreviousValue=true \
               ParameterKey=VpcCidr,ParameterValue=10.1.0.0/16

aws cloudformation wait change-set-create-complete \
  --stack-name iac-lab-vpc --change-set-name dangerous-cidr-change 2>/dev/null

aws cloudformation describe-change-set \
  --stack-name iac-lab-vpc --change-set-name dangerous-cidr-change \
  --query 'Changes[*].{Action:ResourceChange.Action,Resource:ResourceChange.LogicalResourceId,Replacement:ResourceChange.Replacement}'

# Delete it — don't execute!
aws cloudformation delete-change-set \
  --stack-name iac-lab-vpc --change-set-name dangerous-cidr-change
```

**Exam takeaway:** Always use change sets before updating production stacks. The `Replacement` field tells you if a resource will be destroyed and recreated. This is critical for databases and stateful resources.

### Step 2 — Apply a stack policy

Protect the VPC from being replaced:

```bash
aws cloudformation set-stack-policy \
  --stack-name iac-lab-vpc \
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

Now if you tried to execute that dangerous CIDR change, CloudFormation would refuse it because the stack policy denies replacement of the VPC.

Verify the policy:

```bash
aws cloudformation get-stack-policy --stack-name iac-lab-vpc
```

**Key facts for the exam:**
- Stack policies can't be deleted once set — only modified
- They protect against accidental replacements and deletions
- You can temporarily override a stack policy during an update with `--stack-policy-during-update-body`

### Step 3 — Detect drift

Let's manually change something outside of CloudFormation and then detect the drift.

```bash
# Get the VPC ID
VPC_ID=$(aws cloudformation describe-stack-resource \
  --stack-name iac-lab-vpc --logical-resource-id VPC \
  --query 'StackResourceDetail.PhysicalResourceId' --output text)

# Make a manual change — add a tag directly via the EC2 API
aws ec2 create-tags --resources $VPC_ID \
  --tags Key=ManualChange,Value=ThisCausesDrift
```

Now detect the drift:

```bash
# Start drift detection
DRIFT_ID=$(aws cloudformation detect-stack-drift \
  --stack-name iac-lab-vpc \
  --query 'StackDriftDetectionId' --output text)

echo "Drift detection ID: $DRIFT_ID"

# Wait for it to complete
while true; do
  STATUS=$(aws cloudformation describe-stack-drift-detection-status \
    --stack-drift-detection-id $DRIFT_ID \
    --query 'DetectionStatus' --output text)
  echo "Status: $STATUS"
  if [ "$STATUS" != "DETECTION_IN_PROGRESS" ]; then break; fi
  sleep 5
done

# Check which resources drifted
aws cloudformation describe-stack-resource-drifts \
  --stack-name iac-lab-vpc \
  --stack-resource-drift-status-filters MODIFIED \
  --query 'StackResourceDrifts[*].{Resource:LogicalResourceId,Status:StackResourceDriftStatus,Diffs:PropertyDifferences[*].{Property:PropertyPath,Expected:ExpectedValue,Actual:ActualValue}}'
```

You'll see the VPC is `MODIFIED` — the `Tags` property differs from the template.

**Clean up the drift:**

```bash
aws ec2 delete-tags --resources $VPC_ID --tags Key=ManualChange
```

**Exam takeaway:** Drift detection finds differences but doesn't fix them. For automated compliance enforcement, use AWS Config rules (covered in Session 4). The exam often presents a scenario where resources have drifted and asks how to detect and remediate.

### 🧹 Checkpoint

You now understand:
- Change sets for safe updates (preview before applying)
- Stack policies to protect critical resources from replacement
- Drift detection to find manual changes

---

## Lab 3: Cross-Stack References

**What you'll learn:** How independent stacks share values using Exports and `!ImportValue`.

### Step 1 — Create a security group stack that imports the VPC

The VPC stack from Lab 1 already exports `iac-lab-vpc-VpcId`. Let's create a stack that imports it.

Create `sg-stack.yaml`:

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: Security groups that reference the VPC from another stack.

Parameters:
  VpcStackName:
    Type: String
    Default: iac-lab-vpc
    Description: Name of the VPC stack to import from

Resources:
  WebServerSG:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: Allow HTTP and HTTPS
      VpcId: !ImportValue
        Fn::Sub: '${VpcStackName}-VpcId'
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 80
          ToPort: 80
          CidrIp: 0.0.0.0/0
        - IpProtocol: tcp
          FromPort: 443
          ToPort: 443
          CidrIp: 0.0.0.0/0
      Tags:
        - Key: Name
          Value: web-server-sg

  AppServerSG:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: Allow traffic from web servers only
      VpcId: !ImportValue
        Fn::Sub: '${VpcStackName}-VpcId'
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 8080
          ToPort: 8080
          SourceSecurityGroupId: !Ref WebServerSG
      Tags:
        - Key: Name
          Value: app-server-sg

Outputs:
  WebServerSGId:
    Value: !Ref WebServerSG
    Export:
      Name: !Sub '${AWS::StackName}-WebServerSG'
  AppServerSGId:
    Value: !Ref AppServerSG
    Export:
      Name: !Sub '${AWS::StackName}-AppServerSG'
```

Deploy it:

```bash
aws cloudformation create-stack \
  --stack-name iac-lab-sg \
  --template-body file://sg-stack.yaml

aws cloudformation wait stack-create-complete --stack-name iac-lab-sg
echo "SG stack created!"
```

### Step 2 — Try to delete the VPC stack

```bash
aws cloudformation delete-stack --stack-name iac-lab-vpc
```

Watch what happens:

```bash
aws cloudformation describe-stacks --stack-name iac-lab-vpc \
  --query 'Stacks[0].StackStatus'
```

It will fail with `DELETE_FAILED` because the SG stack imports values from it. You can't delete a stack whose exports are being used.

```bash
# Check the error
aws cloudformation describe-stack-events --stack-name iac-lab-vpc \
  --query 'StackEvents[?ResourceStatus==`DELETE_FAILED`].ResourceStatusReason' --output text
```

**Exam takeaway:** Cross-stack references create dependencies. You must delete the importing stack first, or remove the `!ImportValue` references. The exam tests this with scenarios where a stack deletion fails.

**When to use cross-stack references vs. nested stacks:**

| Pattern | Use When |
|---|---|
| Cross-stack (`Export`/`ImportValue`) | Independent stacks with different lifecycles (e.g., VPC managed by networking team, app managed by dev team) |
| Nested stacks | Parent-child relationship, deployed together, same lifecycle |

### 🧹 Checkpoint

You've seen cross-stack references in action and understand the deletion dependency they create.

---

## Lab 4: Custom Resources with Lambda

**What you'll learn:** Extend CloudFormation with custom logic using Lambda-backed custom resources.

### Step 1 — Create the Lambda function

We'll build a custom resource that looks up the latest Amazon Linux 2023 AMI ID — a common real-world use case.

Create `custom-resource-lambda/index.py`:

```python
import json
import urllib.request
import boto3

def handler(event, context):
    """CloudFormation custom resource handler that looks up the latest AMI."""
    print(f"Event: {json.dumps(event)}")

    response_data = {}
    status = "SUCCESS"

    try:
        if event["RequestType"] in ["Create", "Update"]:
            ec2 = boto3.client("ec2")
            result = ec2.describe_images(
                Owners=["amazon"],
                Filters=[
                    {"Name": "name", "Values": ["al2023-ami-2023*-x86_64"]},
                    {"Name": "state", "Values": ["available"]},
                ],
            )
            images = sorted(
                result["Images"],
                key=lambda x: x["CreationDate"],
                reverse=True,
            )
            if images:
                response_data["AmiId"] = images[0]["ImageId"]
                response_data["AmiName"] = images[0]["Name"]
                print(f"Found AMI: {response_data['AmiId']}")
            else:
                raise Exception("No AMI found")

        # Delete — nothing to clean up

    except Exception as e:
        print(f"Error: {e}")
        status = "FAILED"
        response_data["Error"] = str(e)

    # Send response back to CloudFormation
    response_body = json.dumps({
        "Status": status,
        "Reason": f"See CloudWatch Log Stream: {context.log_stream_name}",
        "PhysicalResourceId": event.get("PhysicalResourceId", context.log_stream_name),
        "StackId": event["StackId"],
        "RequestId": event["RequestId"],
        "LogicalResourceId": event["LogicalResourceId"],
        "Data": response_data,
    })

    req = urllib.request.Request(
        event["ResponseURL"],
        data=response_body.encode("utf-8"),
        headers={"Content-Type": ""},
        method="PUT",
    )
    urllib.request.urlopen(req)
    print("Response sent to CloudFormation")
```

Package and deploy the Lambda:

```bash
mkdir -p custom-resource-lambda
# (save the file above as custom-resource-lambda/index.py)

cd custom-resource-lambda
zip -r ../ami-lookup.zip index.py
cd ..

# Create the Lambda execution role
cat > custom-resource-role.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Principal": { "Service": "lambda.amazonaws.com" }, "Action": "sts:AssumeRole" }
  ]
}
EOF

aws iam create-role --role-name CFNCustomResourceRole \
  --assume-role-policy-document file://custom-resource-role.json

aws iam attach-role-policy --role-name CFNCustomResourceRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# Add EC2 describe permission
aws iam put-role-policy --role-name CFNCustomResourceRole \
  --policy-name DescribeImages \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{ "Effect": "Allow", "Action": "ec2:DescribeImages", "Resource": "*" }]
  }'

sleep 10  # Wait for role propagation

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

aws lambda create-function \
  --function-name cfn-ami-lookup \
  --runtime python3.12 \
  --handler index.handler \
  --role arn:aws:iam::${ACCOUNT_ID}:role/CFNCustomResourceRole \
  --zip-file fileb://ami-lookup.zip \
  --timeout 30
```

### Step 2 — Use the custom resource in a CloudFormation template

Create `custom-resource-stack.yaml`:

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: Demonstrates a Lambda-backed custom resource

Parameters:
  LambdaArn:
    Type: String
    Description: ARN of the AMI lookup Lambda function

Resources:
  AmiLookup:
    Type: Custom::AmiLookup
    Properties:
      ServiceToken: !Ref LambdaArn
      # You can pass any properties — they arrive in the Lambda event

Outputs:
  LatestAmiId:
    Description: The latest Amazon Linux 2023 AMI ID
    Value: !GetAtt AmiLookup.AmiId

  LatestAmiName:
    Description: The AMI name
    Value: !GetAtt AmiLookup.AmiName
```

Deploy it:

```bash
LAMBDA_ARN=$(aws lambda get-function --function-name cfn-ami-lookup \
  --query 'Configuration.FunctionArn' --output text)

aws cloudformation create-stack \
  --stack-name iac-lab-custom-resource \
  --template-body file://custom-resource-stack.yaml \
  --parameters ParameterKey=LambdaArn,ParameterValue=$LAMBDA_ARN

aws cloudformation wait stack-create-complete --stack-name iac-lab-custom-resource

# See the AMI ID that was looked up
aws cloudformation describe-stacks --stack-name iac-lab-custom-resource \
  --query 'Stacks[0].Outputs'
```

You'll see the latest AMI ID and name — dynamically looked up at stack creation time.

**Key points for the exam:**
- `ServiceToken` must point to a Lambda ARN or SNS topic ARN
- The Lambda receives `RequestType` (Create, Update, Delete) and must respond to the `ResponseURL`
- If the Lambda fails to respond, CloudFormation waits for the timeout (up to 1 hour) then fails
- `!GetAtt CustomResource.AttributeName` retrieves values from the `Data` dict in the response
- Custom resources are used for anything CloudFormation doesn't natively support

### 🧹 Checkpoint

You've built a Lambda-backed custom resource and used it in a CloudFormation template. This pattern appears on the exam when the question involves "CloudFormation doesn't support resource X" or "need to run custom logic during stack operations."

---

## Lab 5: Build and Deploy a Serverless App with SAM

**What you'll learn:** SAM template syntax, local testing, deployment, and how SAM relates to CloudFormation.

### Step 1 — Initialize a SAM project

```bash
cd ~/iac-labs

sam init \
  --runtime python3.12 \
  --name sam-lab-app \
  --app-template hello-world \
  --no-tracing \
  --no-application-insights \
  --no-structured-logging

cd sam-lab-app
```

### Step 2 — Examine the generated template

```bash
cat template.yaml
```

You'll see something like:

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Description: SAM lab app

Globals:
  Function:
    Timeout: 3

Resources:
  HelloWorldFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: hello_world/
      Handler: app.lambda_handler
      Runtime: python3.12
      Architectures:
        - x86_64
      Events:
        HelloWorld:
          Type: Api
          Properties:
            Path: /hello
            Method: get

Outputs:
  HelloWorldApi:
    Description: API Gateway endpoint URL
    Value: !Sub "https://${ServerlessRestApi}.execute-api.${AWS::Region}.amazonaws.com/Prod/hello/"
```

**Key things to notice:**
- `Transform: AWS::Serverless-2016-10-31` — this is what makes it a SAM template
- `AWS::Serverless::Function` — SAM resource type (expands to Lambda + IAM Role + API Gateway)
- `Events` section — automatically creates the API Gateway integration
- `Globals` — shared configuration across all functions
- You can mix standard CloudFormation resources with SAM resources in the same template

### Step 3 — Test locally

```bash
# Build the application
sam build

# Invoke the function locally (requires Docker)
sam local invoke HelloWorldFunction

# Start a local API Gateway
sam local start-api
# In another terminal: curl http://127.0.0.1:3000/hello
```

Press Ctrl+C to stop the local API.

### Step 4 — Deploy to AWS

```bash
sam deploy --guided
```

Follow the prompts:
- Stack name: `sam-lab-app`
- Region: your default region
- Confirm changes before deploy: `y`
- Allow SAM CLI IAM role creation: `y`
- HelloWorldFunction may not have authorization defined — OK: `y`
- Save arguments to `samconfig.toml`: `y`

SAM will show you a change set (just like CloudFormation) and ask you to confirm. After deployment, it shows the API Gateway URL.

```bash
# Test the deployed API
curl https://<API_ID>.execute-api.<REGION>.amazonaws.com/Prod/hello/
```

### Step 5 — See what SAM actually created

```bash
# List the CloudFormation resources SAM created
aws cloudformation list-stack-resources --stack-name sam-lab-app \
  --query 'StackResourceSummaries[*].{Type:ResourceType,LogicalId:LogicalResourceId}'
```

You'll see that `AWS::Serverless::Function` expanded into:
- `AWS::Lambda::Function`
- `AWS::IAM::Role`
- `AWS::ApiGateway::RestApi`
- `AWS::ApiGateway::Stage`
- `AWS::ApiGateway::Deployment`
- `AWS::Lambda::Permission`
- And more...

**This is the key insight:** SAM is syntactic sugar over CloudFormation. One SAM resource becomes many CloudFormation resources.

### Step 6 — Add a DynamoDB table and environment variable

Update `template.yaml` to add a table and wire it to the function:

```yaml
Resources:
  HelloWorldFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: hello_world/
      Handler: app.lambda_handler
      Runtime: python3.12
      Architectures:
        - x86_64
      Environment:
        Variables:
          TABLE_NAME: !Ref ItemsTable
      Policies:
        - DynamoDBCrudPolicy:
            TableName: !Ref ItemsTable
      Events:
        HelloWorld:
          Type: Api
          Properties:
            Path: /hello
            Method: get

  ItemsTable:
    Type: AWS::Serverless::SimpleTable
    Properties:
      PrimaryKey:
        Name: id
        Type: String
```

Notice `DynamoDBCrudPolicy` — SAM provides policy templates so you don't have to write IAM policies by hand.

```bash
sam build && sam deploy
```

**Exam takeaway:** SAM simplifies serverless deployments. Know the `Transform` header, key resource types (`Function`, `Api`, `HttpApi`, `SimpleTable`), and that SAM policy templates provide least-privilege IAM without manual policy writing.

### 🧹 Checkpoint

You've built, tested locally, and deployed a SAM application. You understand how SAM expands to CloudFormation resources.

---

## Lab 6: Infrastructure with AWS CDK

**What you'll learn:** CDK constructs (L1, L2, L3), synth, diff, deploy, and how CDK relates to CloudFormation.

### Step 1 — Bootstrap and initialize

```bash
cd ~/iac-labs

# Bootstrap CDK in your account/Region (one-time setup)
cdk bootstrap

# Create a new CDK project
mkdir cdk-lab && cd cdk-lab
cdk init app --language typescript
```

### Step 2 — Define infrastructure

Open `lib/cdk-lab-stack.ts` and replace its contents:

```typescript
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class CdkLabStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // L2 Construct — S3 bucket with sensible defaults
    const bucket = new s3.Bucket(this, 'DataBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,       // For lab cleanup
      autoDeleteObjects: true,                          // For lab cleanup
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(90),
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
      ],
    });

    // L2 Construct — DynamoDB table
    const table = new dynamodb.Table(this, 'ItemsTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // L2 Construct — Lambda function
    const fn = new lambda.Function(this, 'ApiHandler', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          return {
            statusCode: 200,
            body: JSON.stringify({
              message: 'Hello from CDK!',
              table: process.env.TABLE_NAME,
              bucket: process.env.BUCKET_NAME,
            }),
          };
        };
      `),
      environment: {
        TABLE_NAME: table.tableName,
        BUCKET_NAME: bucket.bucketName,
      },
    });

    // CDK handles IAM automatically — grant permissions declaratively
    table.grantReadWriteData(fn);
    bucket.grantRead(fn);

    // L3 Construct (Pattern) — API Gateway + Lambda integration
    const api = new apigateway.LambdaRestApi(this, 'ApiEndpoint', {
      handler: fn,
      proxy: true,
    });

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
```

**What to notice:**
- `s3.Bucket` is an L2 construct — it has sensible defaults (encryption, versioning) and high-level methods (`grantRead`)
- `table.grantReadWriteData(fn)` — CDK generates the IAM policy automatically. No manual policy writing.
- `LambdaRestApi` is an L3 construct (pattern) — it creates API Gateway + Lambda integration + permissions in one line
- `removalPolicy: DESTROY` is for lab cleanup — in production you'd use `RETAIN`

### Step 3 — Synth, diff, deploy

```bash
# Synthesize — generates the CloudFormation template
cdk synth

# Look at the generated template
cat cdk.out/CdkLabStack.template.json | python3 -m json.tool | head -100
```

Notice how much CloudFormation CDK generated from ~50 lines of TypeScript. The IAM policies, Lambda permissions, API Gateway resources — all auto-generated.

```bash
# Diff — see what will be created (like a change set)
cdk diff

# Deploy
cdk deploy --require-approval never
```

After deployment, test the API:

```bash
# Get the API URL from the outputs
API_URL=$(aws cloudformation describe-stacks --stack-name CdkLabStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)

curl $API_URL
```

### Step 4 — Make a change and see the diff

Add a CloudWatch alarm to the Lambda function. Append to the constructor in `lib/cdk-lab-stack.ts`, before the closing `}`:

```typescript
    // Add a CloudWatch alarm on Lambda errors
    const alarm = new cdk.aws_cloudwatch.Alarm(this, 'ErrorAlarm', {
      metric: fn.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'Lambda function error alarm',
    });
```

Add the import at the top if needed, then:

```bash
cdk diff
```

You'll see exactly what resources will be added — a CloudWatch Alarm and nothing else. No existing resources are modified.

```bash
cdk deploy --require-approval never
```

### Step 5 — Compare L1 vs L2

To understand construct levels, look at how you'd create the same bucket as an L1 construct:

```typescript
// L1 — raw CloudFormation mapping (verbose, no defaults)
const cfnBucket = new s3.CfnBucket(this, 'L1Bucket', {
  versioningConfiguration: { status: 'Enabled' },
  bucketEncryption: {
    serverSideEncryptionConfiguration: [{
      serverSideEncryptionByDefault: { sseAlgorithm: 'AES256' }
    }]
  }
});

// L2 — opinionated, with helper methods (what you should use)
const l2Bucket = new s3.Bucket(this, 'L2Bucket', {
  versioned: true,
  encryption: s3.BucketEncryption.S3_MANAGED,
});
```

L2 constructs are what you'll use 95% of the time. L1 constructs (`Cfn*` prefix) are for when you need to set a property that the L2 construct doesn't expose.

**Exam takeaway:** CDK synthesizes to CloudFormation. `cdk synth` = template generation, `cdk diff` = change set preview, `cdk deploy` = stack create/update. Know the three construct levels. CDK Pipelines (self-mutating pipeline) is a common exam topic — it's a pipeline defined in CDK that updates itself when the pipeline code changes.

### 🧹 Checkpoint

You've built infrastructure with CDK, seen how it generates CloudFormation, used L2 and L3 constructs, and observed the synth/diff/deploy workflow.

---

## Lab 7: StackSets — Deploy Across Accounts (Conceptual + Single-Account Demo)

**What you'll learn:** How StackSets work, self-managed vs. service-managed permissions, and deployment controls.

> **Note:** Full StackSets with Organizations requires multiple accounts. This lab demonstrates the concepts with a single-account, multi-Region deployment.

### Step 1 — Create a simple template for StackSets

Create `stackset-template.yaml`:

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: Baseline security configuration deployed via StackSets

Resources:
  SecurityAuditBucket:
    Type: AWS::S3::Bucket
    DeletionPolicy: Retain
    Properties:
      BucketName: !Sub 'security-audit-${AWS::AccountId}-${AWS::Region}'
      VersioningConfiguration:
        Status: Enabled
      BucketEncryption:
        ServerSideEncryptionConfiguration:
          - ServerSideEncryptionByDefault:
              SSEAlgorithm: AES256
      PublicAccessBlockConfiguration:
        BlockPublicAcls: true
        BlockPublicPolicy: true
        IgnorePublicAcls: true
        RestrictPublicBuckets: true

Outputs:
  BucketArn:
    Value: !GetAtt SecurityAuditBucket.Arn
    Description: ARN of the security audit bucket
```

### Step 2 — Create the StackSet (self-managed, single account)

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# For self-managed StackSets, you need admin and execution roles.
# In a single-account scenario, the default roles work.
# Create the AWSCloudFormationStackSetAdministrationRole:
cat > stackset-admin-role.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "cloudformation.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

aws iam create-role \
  --role-name AWSCloudFormationStackSetAdministrationRole \
  --assume-role-policy-document file://stackset-admin-role.json

aws iam put-role-policy \
  --role-name AWSCloudFormationStackSetAdministrationRole \
  --policy-name AssumeExecutionRole \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Action\": \"sts:AssumeRole\",
      \"Resource\": \"arn:aws:iam::*:role/AWSCloudFormationStackSetExecutionRole\"
    }]
  }"

# Create the execution role (in each target account — here, same account)
cat > stackset-exec-role.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::${ACCOUNT_ID}:role/AWSCloudFormationStackSetAdministrationRole" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

aws iam create-role \
  --role-name AWSCloudFormationStackSetExecutionRole \
  --assume-role-policy-document file://stackset-exec-role.json

aws iam attach-role-policy \
  --role-name AWSCloudFormationStackSetExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess

sleep 10  # Wait for role propagation

# Create the StackSet
aws cloudformation create-stack-set \
  --stack-set-name security-baseline \
  --template-body file://stackset-template.yaml \
  --permission-model SELF_MANAGED
```

### Step 3 — Deploy to two Regions

```bash
aws cloudformation create-stack-instances \
  --stack-set-name security-baseline \
  --accounts $ACCOUNT_ID \
  --regions us-east-1 eu-west-1 \
  --operation-preferences MaxConcurrentCount=2,FailureToleranceCount=0

# Check the operation status
aws cloudformation list-stack-set-operations \
  --stack-set-name security-baseline \
  --query 'Summaries[0].{Status:Status,Action:Action}'
```

Wait for it to complete, then verify:

```bash
# List stack instances
aws cloudformation list-stack-instances \
  --stack-set-name security-baseline \
  --query 'Summaries[*].{Account:Account,Region:Region,Status:Status}'
```

You should see two instances — one in us-east-1 and one in eu-west-1.

```bash
# Verify the bucket was created in eu-west-1
aws s3api head-bucket --bucket security-audit-${ACCOUNT_ID}-eu-west-1 --region eu-west-1
echo "Bucket exists in eu-west-1!"
```

### Step 4 — Understand the deployment controls

The `--operation-preferences` flag controls how StackSets rolls out:

| Parameter | What It Does |
|---|---|
| `MaxConcurrentCount` | Deploy to N accounts/Regions at a time |
| `MaxConcurrentPercentage` | Deploy to N% of targets at a time |
| `FailureToleranceCount` | Allow N failures before stopping |
| `FailureTolerancePercentage` | Allow N% failures before stopping |

**Exam scenario:** "Deploy a Config rule to 200 accounts. If more than 5 accounts fail, stop the rollout."
→ `FailureToleranceCount=5`, `MaxConcurrentCount=10` (deploy 10 at a time, stop if 6+ fail).

### Self-managed vs. Service-managed StackSets

| Aspect | Self-Managed | Service-Managed (Organizations) |
|---|---|---|
| Role setup | Manual (create admin + execution roles) | Automatic (trusted access) |
| Target | Specific account IDs | OUs (organizational units) |
| Auto-deploy to new accounts | No | Yes |
| Drift detection | Manual | Automatic (optional) |
| Best for | Non-Organizations setups | Organizations with auto-deployment needs |

**Exam takeaway:** Service-managed StackSets with Organizations is the preferred pattern. It automatically deploys to new accounts added to an OU. This is how you deploy guardrails (Config rules, CloudTrail, security baselines) at scale.

### 🧹 Checkpoint

You've deployed a StackSet across two Regions and understand the deployment controls and permission models.

---

## Cleanup

```bash
# Delete StackSet instances first
aws cloudformation delete-stack-instances \
  --stack-set-name security-baseline \
  --accounts $ACCOUNT_ID \
  --regions us-east-1 eu-west-1 \
  --no-retain-stacks

# Wait for deletion
sleep 30
aws cloudformation list-stack-set-operations --stack-set-name security-baseline \
  --query 'Summaries[0].Status'

# Delete the StackSet
aws cloudformation delete-stack-set --stack-set-name security-baseline

# Delete StackSet IAM roles
aws iam delete-role-policy --role-name AWSCloudFormationStackSetAdministrationRole --policy-name AssumeExecutionRole
aws iam delete-role --role-name AWSCloudFormationStackSetAdministrationRole
aws iam detach-role-policy --role-name AWSCloudFormationStackSetExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
aws iam delete-role --role-name AWSCloudFormationStackSetExecutionRole

# Delete the S3 buckets created by StackSets (they have DeletionPolicy: Retain)
aws s3 rb s3://security-audit-${ACCOUNT_ID}-us-east-1 --force 2>/dev/null
aws s3 rb s3://security-audit-${ACCOUNT_ID}-eu-west-1 --force 2>/dev/null

# Delete CDK stack
cd ~/iac-labs/cdk-lab
cdk destroy --force

# Delete SAM stack
cd ~/iac-labs/sam-lab-app
sam delete --no-prompts

# Delete custom resource stack and Lambda
aws cloudformation delete-stack --stack-name iac-lab-custom-resource
aws cloudformation wait stack-delete-complete --stack-name iac-lab-custom-resource
aws lambda delete-function --function-name cfn-ami-lookup
aws iam delete-role-policy --role-name CFNCustomResourceRole --policy-name DescribeImages
aws iam detach-role-policy --role-name CFNCustomResourceRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name CFNCustomResourceRole

# Delete SG stack (must delete before VPC stack)
aws cloudformation delete-stack --stack-name iac-lab-sg
aws cloudformation wait stack-delete-complete --stack-name iac-lab-sg

# Delete VPC stack
aws cloudformation delete-stack --stack-name iac-lab-vpc
aws cloudformation wait stack-delete-complete --stack-name iac-lab-vpc

# Clean up local files
rm -f custom-resource-role.json stackset-admin-role.json stackset-exec-role.json
rm -f ami-lookup.zip
rm -rf custom-resource-lambda
cd ~ && rm -rf iac-labs
```

---

## Session 3 — Key Exam Takeaways

| Topic | What the Exam Tests |
|---|---|
| **Template anatomy** | Parameters (types, constraints), Mappings (`!FindInMap`), Conditions (`!If`, `!Equals`), Outputs (Export/ImportValue) |
| **Intrinsic functions** | `!Ref`, `!GetAtt`, `!Sub`, `!Join`, `!Select`, `!FindInMap`, `!ImportValue` — know them all |
| **Change sets** | Preview updates before applying. `Replacement` field warns about resource recreation. |
| **Stack policies** | Deny `Update:Replace` on critical resources. Can't be removed, only modified. |
| **Drift detection** | Detects manual changes. Doesn't auto-fix. Use Config rules for automated compliance. |
| **Cross-stack refs** | `Export`/`!ImportValue` for independent stacks. Creates deletion dependency. |
| **Nested stacks** | Parent-child, same lifecycle. Use for reusable components and overcoming 500-resource limit. |
| **Custom resources** | Lambda-backed. `ServiceToken` → Lambda ARN. Must respond to `ResponseURL`. |
| **SAM** | `Transform: AWS::Serverless-2016-10-31`. Expands to CloudFormation. Policy templates for IAM. |
| **CDK** | L1 (Cfn*) / L2 (defaults) / L3 (patterns). `synth` → `diff` → `deploy`. Generates CloudFormation. |
| **StackSets** | Self-managed (manual roles) vs. service-managed (Organizations). Auto-deploy to new accounts in OU. |
| **Service Catalog** | Portfolios → Products (CFN templates). Launch constraints for governance. Cross-account sharing. |

---

**Next:** [Session 4 — Multi-Account Automation](./04-multi-account-automation.md)
