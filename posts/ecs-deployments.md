# ECS Deployment Strategies: CodeDeploy Blue/Green vs. Native Canary and Linear

ECS offers three deployment strategies. 

* The **rolling update** is the default — ECS launches new tasks, waits for health checks, then drains old ones. Simple, but it provides no instant rollback and no test traffic validation. 
* **CodeDeploy blue/green** is the original advanced option — full lifecycle hooks, a test listener for pre-production validation, and alarm-based rollback. It works, but requires setting up a separate CodeDeploy application, deployment group, AppSpec file, and service role. 
* **ECS-native blue/green** provides the same capabilities — Lambda lifecycle hooks, test listeners, canary/linear traffic shifting — with significantly less configuration and tighter ECS integration.

This post deploys the same application using both CodeDeploy and ECS-native approaches, compares the mechanics, and provides a decision framework for choosing between them.

## Prerequisites

To follow along, you'll need:

- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) configured with credentials that have permissions for ECS, EC2, ELB, IAM, CodeDeploy, CloudWatch, and Lambda
- An AWS account — estimated cost is ~$1–2 USD (Fargate tasks running for a few hours, ALB)
- A VPC with at least two public subnets in different Availability Zones (the default VPC works)

## ECS Deployment Concepts

Before diving into strategies, a few concepts that both approaches share:

**Task definition** is a blueprint for your application. It specifies the container image, CPU/memory, port mappings, environment variables, and logging configuration. Each change to a task definition creates a new numbered *revision* (e.g., `my-app:1`, `my-app:2`). Deploying = pointing a service at a new revision.

**Service** maintains a desired number of running tasks from a task definition. It handles scheduling, health checks, and integration with load balancers. The service's deployment controller determines how updates roll out.

**Deployment controller** determines who manages deployments: `ECS` (rolling update or native blue/green/canary/linear), `CODE_DEPLOY` (CodeDeploy-managed), or `EXTERNAL`.

**Task sets** are groups of tasks within a service. Blue/green deployments maintain two task sets simultaneously — the blue (current) set serving production traffic, and the green (replacement) set being validated.

**Target groups** are how an ALB routes traffic to tasks. Two target groups enable blue/green switching — one for the current tasks, one for the replacement.

**Production listener** routes real user traffic (typically port 80/443).

**Test listener** routes to the replacement task set on a separate port (e.g., 8080). This allows you to validate the new version before any real users see it.

**Fargate** is the serverless compute engine for ECS. You define CPU and memory in the task definition; AWS manages the underlying infrastructure. All examples in this post use Fargate.

```mermaid
flowchart LR
    subgraph ALB["Application Load Balancer"]
        PROD["Production Listener\n:80"]
        TEST["Test Listener\n:8080"]
    end

    PROD --> TG_BLUE["Blue Target Group"]
    TEST --> TG_GREEN["Green Target Group"]

    TG_BLUE --> BLUE["Blue Task Set\n(current — v1)"]
    TG_GREEN --> GREEN["Green Task Set\n(replacement — v2)"]

    style BLUE fill:#36f,color:#fff
    style GREEN fill:#4c9,color:#fff
```

During deployment, the test listener routes to the green task set. After validation passes, the production listener switches from the blue target group to the green target group.

## Approach 1 — CodeDeploy Blue/Green

### Prerequisites — CloudFormation Template

This template provisions the full infrastructure: an ECS Fargate service running a simple web application that returns "Hello World v1", an ALB with two target groups and two listeners (production on port 80, test on port 8080), and all CodeDeploy resources including a lifecycle hook Lambda function.

**`ecs-codedeploy-prerequisites.yaml`**:

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: >
  ECS CodeDeploy blue/green lab. Creates Fargate service with ALB,
  two target groups, test listener, CodeDeploy application and deployment group.

Parameters:
  VpcId:
    Type: AWS::EC2::VPC::Id
  SubnetIds:
    Type: List<AWS::EC2::Subnet::Id>
    Description: At least two public subnets

Resources:
  # ECS Cluster
  Cluster:
    Type: AWS::ECS::Cluster
    Properties:
      ClusterName: ecs-deploy-lab

  # Task execution role — allows ECS to pull images and write logs
  TaskExecutionRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: ecs-deploy-lab-execution-role
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: ecs-tasks.amazonaws.com
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

  # Security groups
  ALBSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: ALB - allow HTTP on port 80 and 8080
      VpcId: !Ref VpcId
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 80
          ToPort: 80
          CidrIp: 0.0.0.0/0
        - IpProtocol: tcp
          FromPort: 8080
          ToPort: 8080
          CidrIp: 0.0.0.0/0

  TaskSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: ECS tasks - allow HTTP from ALB
      VpcId: !Ref VpcId
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 80
          ToPort: 80
          SourceSecurityGroupId: !Ref ALBSecurityGroup

  # Application Load Balancer
  ALB:
    Type: AWS::ElasticLoadBalancingV2::LoadBalancer
    Properties:
      Name: ecs-deploy-lab-alb
      Subnets: !Ref SubnetIds
      SecurityGroups: [!Ref ALBSecurityGroup]

  # Two target groups — blue (initial) and green (replacement during deployment)
  BlueTargetGroup:
    Type: AWS::ElasticLoadBalancingV2::TargetGroup
    Properties:
      Name: ecs-deploy-lab-blue
      Port: 80
      Protocol: HTTP
      VpcId: !Ref VpcId
      TargetType: ip
      HealthCheckPath: /
      HealthCheckIntervalSeconds: 5
      HealthyThresholdCount: 2
      UnhealthyThresholdCount: 2
      HealthCheckTimeoutSeconds: 3

  GreenTargetGroup:
    Type: AWS::ElasticLoadBalancingV2::TargetGroup
    Properties:
      Name: ecs-deploy-lab-green
      Port: 80
      Protocol: HTTP
      VpcId: !Ref VpcId
      TargetType: ip
      HealthCheckPath: /
      HealthCheckIntervalSeconds: 5
      HealthyThresholdCount: 2
      UnhealthyThresholdCount: 2
      HealthCheckTimeoutSeconds: 3

  # Production listener — port 80, routes to blue target group
  ProductionListener:
    Type: AWS::ElasticLoadBalancingV2::Listener
    Properties:
      LoadBalancerArn: !Ref ALB
      Port: 80
      Protocol: HTTP
      DefaultActions:
        - Type: forward
          TargetGroupArn: !Ref BlueTargetGroup

  # Test listener — port 8080, initially points to blue (CodeDeploy switches it to green during deployment)
  TestListener:
    Type: AWS::ElasticLoadBalancingV2::Listener
    Properties:
      LoadBalancerArn: !Ref ALB
      Port: 8080
      Protocol: HTTP
      DefaultActions:
        - Type: forward
          TargetGroupArn: !Ref BlueTargetGroup

  # Task definition — simple Node.js HTTP server returning "Hello World v1"
  TaskDefinition:
    Type: AWS::ECS::TaskDefinition
    Properties:
      Family: ecs-deploy-lab
      Cpu: '256'
      Memory: '512'
      NetworkMode: awsvpc
      RequiresCompatibilities: [FARGATE]
      ExecutionRoleArn: !GetAtt TaskExecutionRole.Arn
      ContainerDefinitions:
        - Name: app
          Image: public.ecr.aws/docker/library/node:20-alpine
          # Inline HTTP server — returns the version from APP_VERSION env var
          Command:
            - node
            - -e
            - |
              const http = require('http');
              const version = process.env.APP_VERSION || '1';
              http.createServer((req, res) => {
                res.writeHead(200, {'Content-Type': 'text/plain'});
                res.end(`Hello World v${version}\n`);
              }).listen(80);
          Environment:
            - Name: APP_VERSION
              Value: '1'
          PortMappings:
            - ContainerPort: 80
          Essential: true
          LogConfiguration:
            LogDriver: awslogs
            Options:
              awslogs-group: !Ref LogGroup
              awslogs-region: !Ref AWS::Region
              awslogs-stream-prefix: ecs

  LogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: /ecs/deploy-lab
      RetentionInDays: 7

  # ECS Service — deployment controller set to CODE_DEPLOY
  Service:
    Type: AWS::ECS::Service
    DependsOn: ProductionListener
    Properties:
      ServiceName: deploy-lab-service
      Cluster: !Ref Cluster
      TaskDefinition: !Ref TaskDefinition
      DesiredCount: 2
      LaunchType: FARGATE
      # CODE_DEPLOY deployment controller — CodeDeploy manages blue/green
      DeploymentController:
        Type: CODE_DEPLOY
      NetworkConfiguration:
        AwsvpcConfiguration:
          AssignPublicIp: ENABLED
          Subnets: !Ref SubnetIds
          SecurityGroups: [!Ref TaskSecurityGroup]
      LoadBalancers:
        - ContainerName: app
          ContainerPort: 80
          TargetGroupArn: !Ref BlueTargetGroup

  # CodeDeploy service role — allows CodeDeploy to manipulate ECS services and ALB
  CodeDeployServiceRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: ecs-deploy-lab-codedeploy-role
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: codedeploy.amazonaws.com
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/AWSCodeDeployRoleForECS

  # CodeDeploy application — compute platform ECS
  CodeDeployApplication:
    Type: AWS::CodeDeploy::Application
    Properties:
      ApplicationName: ecs-deploy-lab
      ComputePlatform: ECS

  # CodeDeploy deployment group — wires together service, target groups, listeners
  DeploymentGroup:
    Type: AWS::CodeDeploy::DeploymentGroup
    Properties:
      ApplicationName: !Ref CodeDeployApplication
      DeploymentGroupName: ecs-deploy-lab-dg
      ServiceRoleArn: !GetAtt CodeDeployServiceRole.Arn
      DeploymentConfigName: CodeDeployDefault.ECSAllAtOnce
      # Blue/green deployment style
      DeploymentStyle:
        DeploymentType: BLUE_GREEN
        DeploymentOption: WITH_TRAFFIC_CONTROL
      # Wire up ECS service + target groups + listeners
      ECSServices:
        - ClusterName: !Ref Cluster
          ServiceName: !GetAtt Service.Name
      LoadBalancerInfo:
        TargetGroupPairInfoList:
          - TargetGroups:
              - Name: ecs-deploy-lab-blue
              - Name: ecs-deploy-lab-green
            ProdTrafficRoute:
              ListenerArns:
                - !Ref ProductionListener
            TestTrafficRoute:
              ListenerArns:
                - !Ref TestListener
      # Keep blue task set alive for 5 minutes after traffic shifts (rollback window)
      BlueGreenDeploymentConfiguration:
        TerminateBlueInstancesOnDeploymentSuccess:
          Action: TERMINATE
          TerminationWaitTimeInMinutes: 5
        DeploymentReadyOption:
          ActionOnTimeout: CONTINUE_DEPLOYMENT
          WaitTimeInMinutes: 0

  # Lambda hook function role
  HookFunctionRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: ecs-deploy-lab-hook-role
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: lambda.amazonaws.com
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
      Policies:
        - PolicyName: CodeDeployHookPermissions
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action: codedeploy:PutLifecycleEventHookExecutionStatus
                Resource: '*'

  # AfterAllowTestTraffic hook — validates the green task set via test listener
  TestTrafficHook:
    Type: AWS::Lambda::Function
    Properties:
      FunctionName: CodeDeployHook_ecs-deploy-lab-test-traffic
      Runtime: nodejs20.x
      Handler: index.handler
      Role: !GetAtt HookFunctionRole.Arn
      Timeout: 30
      Environment:
        Variables:
          TEST_URL: !Sub 'http://${ALB.DNSName}:8080'
      Code:
        ZipFile: |
          const { CodeDeployClient, PutLifecycleEventHookExecutionStatusCommand } = require("@aws-sdk/client-codedeploy");
          const codedeploy = new CodeDeployClient();

          exports.handler = async (event) => {
            const deploymentId = event.DeploymentId;
            const lifecycleEventHookExecutionId = event.LifecycleEventHookExecutionId;
            let status = "Failed";

            try {
              // Wait for the ALB test listener to finish switching to the green target group.
              // CodeDeploy fires this hook immediately after initiating the switch, but the
              // ALB needs a few seconds to complete the routing change.
              await new Promise(resolve => setTimeout(resolve, 10000));

              // Hit the test listener to validate the green task set
              const response = await fetch(process.env.TEST_URL);
              const body = await response.text();
              if (response.ok) {
                console.log("Test traffic validation passed — HTTP", response.status);
                console.log("Response from green task set:", body.trim());
                status = "Succeeded";
              } else {
                console.error("Test traffic validation failed — HTTP", response.status, body);
              }
            } catch (err) {
              console.error("Test traffic validation error:", err);
            }

            // Report result to CodeDeploy
            await codedeploy.send(new PutLifecycleEventHookExecutionStatusCommand({
              deploymentId,
              lifecycleEventHookExecutionId,
              status,
            }));

            return { statusCode: 200, body: status };
          };

Outputs:
  ALBDns:
    Description: ALB DNS — use to verify deployments
    Value: !GetAtt ALB.DNSName
  TestListenerUrl:
    Description: Test listener URL (port 8080)
    Value: !Sub 'http://${ALB.DNSName}:8080'
  ClusterName:
    Value: !Ref Cluster
  ServiceName:
    Value: !GetAtt Service.Name
  TaskDefinitionArn:
    Value: !Ref TaskDefinition
  CodeDeployApp:
    Value: !Ref CodeDeployApplication
  DeploymentGroup:
    Value: !Ref DeploymentGroup
```

Deploy the stack and wait for the service to stabilize:

```bash
aws cloudformation deploy \
  --template-file ecs-codedeploy-prerequisites.yaml \
  --stack-name ecs-codedeploy-lab \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    VpcId=<YOUR_VPC_ID> \
    SubnetIds=<SUBNET_1>,<SUBNET_2>
```

Store outputs for later use:

```bash
ALB_DNS=$(aws cloudformation describe-stacks --stack-name ecs-codedeploy-lab \
  --query 'Stacks[0].Outputs[?OutputKey==`ALBDns`].OutputValue' --output text)

# Verify v1 is serving traffic
curl http://$ALB_DNS
# Expected: Hello World v1
```

### Deploy v2 with CodeDeploy

To trigger a blue/green deployment, register a new task definition revision and create a CodeDeploy deployment referencing it. The new task definition changes `APP_VERSION` from `1` to `2`. This makes the application respond with "Hello World v2":

> **Note:** In a real project, deploying a new version means building a Docker image, pushing it to Docker registry (i.e. ECR, DockerHub, etc), and updating the `image` field in the task definition. This lab uses an inline `node -e` command with an environment variable to simulate version changes without requiring a Docker build workflow — keeping the focus on deployment mechanics.

**`task-definition-v2.json`**:

```json
{
  "family": "ecs-deploy-lab",
  "cpu": "256",
  "memory": "512",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "executionRoleArn": "<EXECUTION_ROLE_ARN>",
  "containerDefinitions": [
    {
      "name": "app",
      "image": "public.ecr.aws/docker/library/node:20-alpine",
      "command": [
        "node", "-e",
        "const http = require('http'); const version = process.env.APP_VERSION || '1'; http.createServer((req, res) => { res.writeHead(200, {'Content-Type': 'text/plain'}); res.end(`Hello World v${version}\\n`); }).listen(80);"
      ],
      "environment": [
        { "name": "APP_VERSION", "value": "2" }
      ],
      "portMappings": [{ "containerPort": 80 }],
      "essential": true,
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/deploy-lab",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

Fill in the execution role ARN and register it:

```bash
# Inject the execution role ARN into the JSON file
EXEC_ROLE=$(aws iam get-role --role-name ecs-deploy-lab-execution-role \
  --query 'Role.Arn' --output text)

sed -i "s|<EXECUTION_ROLE_ARN>|$EXEC_ROLE|" task-definition-v2.json

# Register the new task definition revision
NEW_TASK_DEF=$(aws ecs register-task-definition \
  --cli-input-json file://task-definition-v2.json \
  --query 'taskDefinition.taskDefinitionArn' --output text)

echo "New task definition: $NEW_TASK_DEF"
```

### The AppSpec File for ECS

The ECS AppSpec declares which task definition to deploy and how to wire it to the load balancer. The `Hooks` section references Lambda functions to run at each lifecycle stage. Here's the structure:

```yaml
# AppSpec structure for ECS CodeDeploy deployments
version: 0.0
Resources:
  - TargetService:
      Type: AWS::ECS::Service
      Properties:
        # The new task definition ARN to deploy
        TaskDefinition: "arn:aws:ecs:us-east-1:123456789:task-definition/ecs-deploy-lab:2"
        LoadBalancerInfo:
          ContainerName: "app"       # Must match container name in task definition
          ContainerPort: 80          # Must match container port mapping
Hooks:
  # Runs after test listener routes to green — validate before production shift
  - AfterAllowTestTraffic: "CodeDeployHook_ecs-deploy-lab-test-traffic"
```

The available lifecycle hooks for ECS CodeDeploy deployments, in execution order:

1. **BeforeInstall** — before the replacement task set is created
2. **AfterInstall** — after the replacement task set is created and tasks are healthy
3. **AfterAllowTestTraffic** — after the test listener routes to the green task set (this is where you validate)
4. **BeforeAllowTraffic** — before production traffic shifts to green
5. **AfterAllowTraffic** — after production traffic is fully on green

`AfterAllowTestTraffic` is the most important hook — it's your chance to validate the new version using real infrastructure (ALB, networking, container config) without affecting production users.

Now create the deployment, passing the AppSpec inline with the `$NEW_TASK_DEF` variable from the previous step:

> **Note:** In a real project, you'd store the AppSpec in S3 and reference it with `--s3-location bucket=...,key=appspec.yaml,bundleType=YAML`. We're passing it inline here to keep the lab self-contained.

```bash
# Create the deployment with inline AppSpec referencing $NEW_TASK_DEF
DEPLOY_ID=$(aws deploy create-deployment \
  --application-name ecs-deploy-lab \
  --deployment-group-name ecs-deploy-lab-dg \
  --revision '{"revisionType": "AppSpecContent", "appSpecContent": {"content": "{\"version\": 0.0, \"Resources\": [{\"TargetService\": {\"Type\": \"AWS::ECS::Service\", \"Properties\": {\"TaskDefinition\": \"'"$NEW_TASK_DEF"'\", \"LoadBalancerInfo\": {\"ContainerName\": \"app\", \"ContainerPort\": 80}}}}], \"Hooks\": [{\"AfterAllowTestTraffic\": \"CodeDeployHook_ecs-deploy-lab-test-traffic\"}]}"}}' \
  --query 'deploymentId' --output text)

echo "Deployment: $DEPLOY_ID"
```

Watch the deployment progress through each lifecycle stage:

```bash
# Poll deployment status
while true; do
  STATUS=$(aws deploy get-deployment --deployment-id $DEPLOY_ID \
    --query 'deploymentInfo.status' --output text)
  echo "$(date +%H:%M:%S) $STATUS"
  if [ "$STATUS" != "InProgress" ] && [ "$STATUS" != "Created" ]; then break; fi
  sleep 10
done
```

Once the deployment succeeds, check the hook's CloudWatch Logs to confirm it validated the new version via the test listener:

```bash
# Fetch the most recent log stream from the hook function
aws logs tail /aws/lambda/CodeDeployHook_ecs-deploy-lab-test-traffic --since 10m
```

You should see output like:

```
INFO Test traffic validation passed — HTTP 200
INFO Response from green task set: Hello World v2
```

This log proves the test listener was routing to the green task set during `AfterAllowTestTraffic`. The hook invoked port 8080, received "Hello World v2" from the new tasks, and reported `Succeeded` — triggering the production traffic shift.

After the deployment completes, production traffic (port 80) now serves v2:

```bash
curl http://$ALB_DNS
# Expected: Hello World v2
```

The deployment sequence:
1. Green task set spins up with the new task definition
2. Tasks register in the green target group and pass ALB health checks
3. CodeDeploy switches test listener (port 8080) to the green target group
4. `AfterAllowTestTraffic` hook fires → Lambda hits port 8080, confirms "Hello World v2"
5. Hook reports `Succeeded` → production listener (port 80) shifts to green
6. 5-minute termination wait → blue task set terminates

> **Note:** In our testing, the ALB listener switch (step 3) takes a few seconds to propagate before traffic actually routes to the new target group. CodeDeploy marks the switch as complete and fires the hook immediately, but the ALB hasn't finished routing yet. This is a [known ALB behavior](https://repost.aws/questions/QU83vc4Oc-QPCu04XEAOzN7Q/application-load-balancer-504-errors-with-weighted-target-group) — changes take a few seconds to propagate. The hook includes a 10-second wait to account for this. In production hooks running full test suites, the setup time before the first HTTP request should naturally covers this delay.

### Traffic Shifting Options with CodeDeploy

The deployment configuration controls how production traffic shifts from blue to green *after* hooks pass:

- **`CodeDeployDefault.ECSAllAtOnce`** — instant switch. All traffic moves to green in one step.
- **`CodeDeployDefault.ECSCanary10Percent5Minutes`** — 10% to green for 5 minutes. If no alarms fire, remaining 90% shifts.
- **`CodeDeployDefault.ECSCanary10Percent15Minutes`** — same but with 15-minute observation window.
- **`CodeDeployDefault.ECSLinear10PercentEvery1Minute`** — 10% every minute over 10 minutes.
- **`CodeDeployDefault.ECSLinear10PercentEvery3Minutes`** — 10% every 3 minutes over 30 minutes.

All options still use the test listener and hooks for pre-validation. The traffic shifting strategy only affects what happens *after* hooks succeed.

To change the strategy, update the deployment group:

```bash
# Switch to canary — 10% for 5 minutes, then the rest
aws deploy update-deployment-group \
  --application-name ecs-deploy-lab \
  --current-deployment-group-name ecs-deploy-lab-dg \
  --deployment-config-name CodeDeployDefault.ECSCanary10Percent5Minutes
```

### Automatic Rollback

You can attach CloudWatch alarms to the deployment group (via `alarm-configuration`). If an alarm fires during the deployment — whether during the canary/linear traffic shifting phase or right after the full switch — CodeDeploy stops the deployment and switches the production listener back to the blue target group. This is instant because the blue task set remains alive during the termination wait period (5 minutes in our template). No new tasks need to launch; the ALB just flips back.

Two rollback triggers exist: `DEPLOYMENT_FAILURE` (hook reports failed, tasks won't start) and `DEPLOYMENT_STOP_ON_ALARM` (CloudWatch alarm fires during deployment). Both result in the same outcome — production traffic reverts to blue.

## Approach 2 — ECS Native Blue/Green

### How It Differs from CodeDeploy

ECS native blue/green provides the same deployment safety without a separate CodeDeploy application. The key differences:

- **Deployment controller**: `ECS` (not `CODE_DEPLOY`)
- **No AppSpec file** — deployment configuration is part of the ECS service definition
- **No CodeDeploy application/group/role** — significantly less infrastructure to manage
- **Native lifecycle hooks** — ECS invokes Lambda functions directly at 8 lifecycle stages (vs. CodeDeploy's 5)
- **Pause hooks** — deployment can pause and wait for `ContinueServiceDeployment` API call (useful for manual approvals or external CI/CD integration)
- **Same result** — test listener validation, canary/linear traffic shifting, alarm-based rollback

The ECS native lifecycle stages, in order:

1. `RECONCILE_SERVICE` — service configuration reconciled
2. `PRE_SCALE_UP` — before green task set scales up
3. `POST_SCALE_UP` — green task set is healthy
4. `TEST_TRAFFIC_SHIFT` — test listener shifts to green
5. `POST_TEST_TRAFFIC_SHIFT` — after test traffic is on green (validate here)
6. `PRE_PRODUCTION_TRAFFIC_SHIFT` — before production traffic moves (recurring for canary/linear)
7. `PRODUCTION_TRAFFIC_SHIFT` — production traffic shifts (recurring for canary/linear)
8. `POST_PRODUCTION_TRAFFIC_SHIFT` — after all production traffic is on green

### Deployment Configuration — CodeDeploy Concepts Mapped to ECS Native

With CodeDeploy, deployment behavior is spread across multiple resources: the deployment group defines target groups, listeners, and termination wait time; the deployment config defines the traffic shifting strategy; the AppSpec wires in the hooks.

With ECS native, all of this collapses into a single deployment configuration on the ECS service itself. You specify:

- **Deployment type**: blue/green (two task sets with ALB switching)
- **Production listener**: which ALB listener serves real traffic
- **Test listener**: which ALB listener routes to the replacement task set for validation
- **Target groups**: the two target groups to switch between
- **Termination wait time**: how long to keep the old task set alive after traffic shifts (rollback window)
- **Circuit breaker**: auto-rollback on health check failures (replaces CodeDeploy's alarm + auto-rollback config)

| CodeDeploy concept | ECS native equivalent |
|----|-----|
| Deployment group (target groups, listeners) | Blue/green configuration on the service |
| Deployment config (`ECSCanary10Percent5Minutes`) | Traffic shifting configuration (shown in canary/linear section below) |
| `TerminateBlueInstancesOnDeploymentSuccess` | Termination wait time |
| Alarm + auto-rollback config | Deployment circuit breaker + CloudWatch alarms |
| AppSpec hooks | ECS deployment lifecycle hooks (configured via API/CLI) |

No separate CodeDeploy application, deployment group, or service role required.

### Prerequisites — CloudFormation Template (Native)

This template provisions the infrastructure: cluster, ALB with two target groups and two listeners, and a basic ECS service using the default rolling update strategy. We'll upgrade it to blue/green via CLI in the next step.

**`ecs-native-prerequisites.yaml`**:

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: >
  ECS native blue/green lab. Creates Fargate service with ALB and
  two target groups. Service starts with rolling update — upgraded to blue/green via CLI.

Parameters:
  VpcId:
    Type: AWS::EC2::VPC::Id
  SubnetIds:
    Type: List<AWS::EC2::Subnet::Id>
    Description: At least two public subnets

Resources:
  Cluster:
    Type: AWS::ECS::Cluster
    Properties:
      ClusterName: ecs-native-deploy-lab

  TaskExecutionRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: ecs-native-deploy-lab-execution-role
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: ecs-tasks.amazonaws.com
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

  ALBSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: ALB - allow HTTP on port 80 and 8080
      VpcId: !Ref VpcId
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 80
          ToPort: 80
          CidrIp: 0.0.0.0/0
        - IpProtocol: tcp
          FromPort: 8080
          ToPort: 8080
          CidrIp: 0.0.0.0/0

  TaskSecurityGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: ECS tasks - allow HTTP from ALB
      VpcId: !Ref VpcId
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 80
          ToPort: 80
          SourceSecurityGroupId: !Ref ALBSecurityGroup

  ALB:
    Type: AWS::ElasticLoadBalancingV2::LoadBalancer
    Properties:
      Name: ecs-native-lab-alb
      Subnets: !Ref SubnetIds
      SecurityGroups: [!Ref ALBSecurityGroup]

  # Two target groups ready for blue/green — both exist from the start
  BlueTargetGroup:
    Type: AWS::ElasticLoadBalancingV2::TargetGroup
    Properties:
      Name: ecs-native-lab-blue
      Port: 80
      Protocol: HTTP
      VpcId: !Ref VpcId
      TargetType: ip
      HealthCheckPath: /
      HealthCheckIntervalSeconds: 5
      HealthyThresholdCount: 2
      UnhealthyThresholdCount: 2
      HealthCheckTimeoutSeconds: 3

  GreenTargetGroup:
    Type: AWS::ElasticLoadBalancingV2::TargetGroup
    Properties:
      Name: ecs-native-lab-green
      Port: 80
      Protocol: HTTP
      VpcId: !Ref VpcId
      TargetType: ip
      HealthCheckPath: /
      HealthCheckIntervalSeconds: 5
      HealthyThresholdCount: 2
      UnhealthyThresholdCount: 2
      HealthCheckTimeoutSeconds: 3

  # Production listener on port 80
  ProductionListener:
    Type: AWS::ElasticLoadBalancingV2::Listener
    Properties:
      LoadBalancerArn: !Ref ALB
      Port: 80
      Protocol: HTTP
      DefaultActions:
        - Type: forward
          TargetGroupArn: !Ref BlueTargetGroup

  # Test listener on port 8080 — used during blue/green for pre-production validation
  TestListener:
    Type: AWS::ElasticLoadBalancingV2::Listener
    Properties:
      LoadBalancerArn: !Ref ALB
      Port: 8080
      Protocol: HTTP
      DefaultActions:
        - Type: forward
          TargetGroupArn: !Ref BlueTargetGroup

  LogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: /ecs/native-deploy-lab
      RetentionInDays: 7

  TaskDefinition:
    Type: AWS::ECS::TaskDefinition
    Properties:
      Family: ecs-native-deploy-lab
      Cpu: '256'
      Memory: '512'
      NetworkMode: awsvpc
      RequiresCompatibilities: [FARGATE]
      ExecutionRoleArn: !GetAtt TaskExecutionRole.Arn
      ContainerDefinitions:
        - Name: app
          Image: public.ecr.aws/docker/library/node:20-alpine
          Command:
            - node
            - -e
            - |
              const http = require('http');
              const version = process.env.APP_VERSION || '1';
              http.createServer((req, res) => {
                res.writeHead(200, {'Content-Type': 'text/plain'});
                res.end(`Hello World v${version}\n`);
              }).listen(80);
          Environment:
            - Name: APP_VERSION
              Value: '1'
          PortMappings:
            - ContainerPort: 80
          Essential: true
          LogConfiguration:
            LogDriver: awslogs
            Options:
              awslogs-group: !Ref LogGroup
              awslogs-region: !Ref AWS::Region
              awslogs-stream-prefix: ecs

  # ECS infrastructure role — allows ECS to manage load balancer resources for blue/green
  ECSInfrastructureRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: ecs-native-deploy-lab-infra-role
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: ecs.amazonaws.com
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRolePolicyForLoadBalancers

  # Service starts with default rolling update — no blue/green config yet
  Service:
    Type: AWS::ECS::Service
    DependsOn: ProductionListener
    Properties:
      ServiceName: native-deploy-lab-service
      Cluster: !Ref Cluster
      TaskDefinition: !Ref TaskDefinition
      DesiredCount: 2
      LaunchType: FARGATE
      DeploymentController:
        Type: ECS
      NetworkConfiguration:
        AwsvpcConfiguration:
          AssignPublicIp: ENABLED
          Subnets: !Ref SubnetIds
          SecurityGroups: [!Ref TaskSecurityGroup]
      LoadBalancers:
        - ContainerName: app
          ContainerPort: 80
          TargetGroupArn: !Ref BlueTargetGroup

Outputs:
  ALBDns:
    Value: !GetAtt ALB.DNSName
  ClusterName:
    Value: !Ref Cluster
  ServiceName:
    Value: !GetAtt Service.Name
  ProductionListenerArn:
    Value: !Ref ProductionListener
  TestListenerArn:
    Value: !Ref TestListener
  BlueTargetGroupArn:
    Value: !Ref BlueTargetGroup
  GreenTargetGroupArn:
    Value: !Ref GreenTargetGroup
  ECSInfrastructureRoleArn:
    Value: !GetAtt ECSInfrastructureRole.Arn
```

Deploy the stack:

```bash
aws cloudformation deploy \
  --template-file ecs-native-prerequisites.yaml \
  --stack-name ecs-native-lab \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    VpcId=<YOUR_VPC_ID> \
    SubnetIds=<SUBNET_1>,<SUBNET_2>

# Store outputs
NATIVE_ALB=$(aws cloudformation describe-stacks --stack-name ecs-native-lab \
  --query 'Stacks[0].Outputs[?OutputKey==`ALBDns`].OutputValue' --output text)
PROD_LISTENER=$(aws cloudformation describe-stacks --stack-name ecs-native-lab \
  --query 'Stacks[0].Outputs[?OutputKey==`ProductionListenerArn`].OutputValue' --output text)
TEST_LISTENER=$(aws cloudformation describe-stacks --stack-name ecs-native-lab \
  --query 'Stacks[0].Outputs[?OutputKey==`TestListenerArn`].OutputValue' --output text)
BLUE_TG=$(aws cloudformation describe-stacks --stack-name ecs-native-lab \
  --query 'Stacks[0].Outputs[?OutputKey==`BlueTargetGroupArn`].OutputValue' --output text)
GREEN_TG=$(aws cloudformation describe-stacks --stack-name ecs-native-lab \
  --query 'Stacks[0].Outputs[?OutputKey==`GreenTargetGroupArn`].OutputValue' --output text)
INFRA_ROLE=$(aws cloudformation describe-stacks --stack-name ecs-native-lab \
  --query 'Stacks[0].Outputs[?OutputKey==`ECSInfrastructureRoleArn`].OutputValue' --output text)

# Verify v1 is serving traffic
curl http://$NATIVE_ALB
# Expected: Hello World v1
```

### Enabling Blue/Green on the Service

The service currently uses rolling update. Upgrade it to blue/green by updating the load balancer configuration (to wire in the alternate target group and listeners) and the deployment strategy. This requires two settings:

1. `--load-balancers` with `advancedConfiguration` — tells ECS which alternate target group, listeners, and IAM role to use for traffic shifting
2. `--deployment-configuration` with `strategy: BLUE_GREEN` — enables the blue/green deployment strategy with a bake time

```bash
# Upgrade the service from rolling update to blue/green
aws ecs update-service \
  --cluster ecs-native-deploy-lab \
  --service native-deploy-lab-service \
  --load-balancers '[{
    "containerName": "app",
    "containerPort": 80,
    "targetGroupArn": "'"$BLUE_TG"'",
    "advancedConfiguration": {
      "alternateTargetGroupArn": "'"$GREEN_TG"'",
      "productionListenerRule": "'"$PROD_LISTENER"'",
      "testListenerRule": "'"$TEST_LISTENER"'",
      "roleArn": "'"$INFRA_ROLE"'"
    }
  }]' \
  --deployment-configuration '{
    "strategy": "BLUE_GREEN",
    "bakeTimeInMinutes": 5
  }'
```

That single command replaces what CodeDeploy needs an entire deployment group, service role, and deployment style configuration to achieve. The service is now ready for blue/green deployments.

### Deploy v2 with ECS Native

With blue/green enabled, you trigger a deployment by updating the service's task definition. No AppSpec, no `create-deployment` — just `update-service`:

**`task-definition-v2.json`** (same app, different family name for the native lab):

```json
{
  "family": "ecs-native-deploy-lab",
  "cpu": "256",
  "memory": "512",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "executionRoleArn": "<EXECUTION_ROLE_ARN>",
  "containerDefinitions": [
    {
      "name": "app",
      "image": "public.ecr.aws/docker/library/node:20-alpine",
      "command": [
        "node", "-e",
        "const http = require('http'); const version = process.env.APP_VERSION || '1'; http.createServer((req, res) => { res.writeHead(200, {'Content-Type': 'text/plain'}); res.end(`Hello World v${version}\\n`); }).listen(80);"
      ],
      "environment": [
        { "name": "APP_VERSION", "value": "2" }
      ],
      "portMappings": [{ "containerPort": 80 }],
      "essential": true,
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/native-deploy-lab",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

Register the task definition and update the service to trigger the deployment:

```bash
# Inject the execution role ARN
EXEC_ROLE=$(aws iam get-role --role-name ecs-native-deploy-lab-execution-role \
  --query 'Role.Arn' --output text)

sed -i "s|<EXECUTION_ROLE_ARN>|$EXEC_ROLE|" task-definition-v2.json

# Register the new revision
NEW_TASK_DEF=$(aws ecs register-task-definition \
  --cli-input-json file://task-definition-v2.json \
  --query 'taskDefinition.taskDefinitionArn' --output text)

# Update the service — this triggers the blue/green deployment
aws ecs update-service \
  --cluster ecs-native-deploy-lab \
  --service native-deploy-lab-service \
  --task-definition "$NEW_TASK_DEF"
```

ECS handles the rest: creates the green task set, waits for health checks, routes test traffic, and shifts production traffic. Monitor the deployment:

```bash
# Watch the service deployment status
aws ecs describe-services \
  --cluster ecs-native-deploy-lab \
  --services native-deploy-lab-service \
  --query 'services[0].deployments[*].{Status:status,TaskDef:taskDefinition,DesiredCount:desiredCount,RunningCount:runningCount}'
```

During deployment, test both listeners:

```bash
# Test listener (8080) shows green task set
curl http://$NATIVE_ALB:8080
# Expected: Hello World v2

# Production listener (80) still shows blue until traffic shifts
curl http://$NATIVE_ALB:80
# Expected: Hello World v1
```

### ECS Native Canary and Linear

The `update-service` command that enabled blue/green used an all-at-once traffic shift (the default). To use gradual traffic shifting, add a `trafficShiftingConfiguration` to the blue/green configuration.

**Canary** — shifts an initial percentage of traffic, waits, then shifts the rest:

```json
"trafficShiftingConfiguration": {
  "type": "CANARY",
  "canaryConfiguration": {
    "initialTrafficPercentage": 10,
    "intervalInSeconds": 300,
    "numberOfIntervals": 1
  }
}
```

This shifts 10% of traffic for 5 minutes (300 seconds), then the remaining 90%.

**Linear** — shifts traffic in equal increments at regular intervals:

```json
"trafficShiftingConfiguration": {
  "type": "LINEAR",
  "linearConfiguration": {
    "trafficPercentageStep": 10,
    "intervalInSeconds": 60
  }
}
```

This shifts 10% every 60 seconds — full cutover in 10 minutes.

Both configurations go inside `blueGreenDeploymentConfiguration` in the `--deployment-configuration` argument. CloudWatch alarms can be attached at the ECS service level for automatic rollback during the observation windows — if an alarm fires mid-shift, ECS reverts traffic to the blue task set.

## Comparison: Choosing Between Approaches

| Aspect | CodeDeploy Blue/Green | ECS Native Blue/Green | ECS Rolling Update |
|--------|----------------------|----------------------|-------------------|
| Setup complexity | High (CodeDeploy app, group, role, AppSpec, hooks) | Medium (ECS service config) | Low (just min/max percent) |
| Lifecycle hooks | Yes — Lambda at 5 CodeDeploy stages | Yes — Lambda + pause hooks at 8 ECS stages | No |
| Test listener | Yes | Yes | No |
| Custom validation code | Yes (`AfterAllowTestTraffic`) | Yes (`POST_TEST_TRAFFIC_SHIFT` Lambda hook) | No |
| Traffic strategies | AllAtOnce, Canary, Linear | AllAtOnce, Canary, Linear | Rolling (min healthy %) |
| Rollback speed | Instant (ALB switch) | Instant (ALB switch) | Slow (must launch old tasks again) |
| CodePipeline integration | CodeDeploy deploy action | ECS deploy action | ECS deploy action |
| When to use | Existing CodeDeploy pipelines, need consistency | Most new production deployments | Dev/test, simple services |

Decision framework:
- Already have CodeDeploy pipelines and want to keep consistency? → CodeDeploy
- New deployment, want lifecycle hooks with less configuration? → ECS Native
- Dev environment, minimal config? → Rolling Update

## Clean Up

Check for orphaned resources before deleting stacks:

```bash
# Check for lingering task definitions (these persist even after stack deletion)
aws ecs list-task-definitions --family-prefix ecs-deploy-lab
aws ecs list-task-definitions --family-prefix ecs-native-deploy-lab

# Deregister all revisions (optional — they don't incur cost)
for arn in $(aws ecs list-task-definitions --family-prefix ecs-deploy-lab --query 'taskDefinitionArns[]' --output text); do
  aws ecs deregister-task-definition --task-definition $arn > /dev/null
done
```

Delete the CloudFormation stacks:

```bash
# Delete CodeDeploy approach stack
aws cloudformation delete-stack --stack-name ecs-codedeploy-lab
aws cloudformation wait stack-delete-complete --stack-name ecs-codedeploy-lab

# Delete ECS native approach stack
aws cloudformation delete-stack --stack-name ecs-native-lab
aws cloudformation wait stack-delete-complete --stack-name ecs-native-lab

# Delete the CloudWatch alarm
aws cloudwatch delete-alarms --alarm-names ecs-deploy-lab-5xx
```

## Conclusion

ECS provides three deployment strategies — rolling update for simplicity, CodeDeploy blue/green for full lifecycle hook control with established pipelines, and ECS-native blue/green/canary/linear for the same safety with less configuration overhead.

The test listener pattern is the key safety mechanism for both blue/green approaches: validate the new version on port 8080 using real infrastructure before any production user on port 80 is affected. CodeDeploy uses `AfterAllowTestTraffic` hooks; ECS native uses `POST_TEST_TRAFFIC_SHIFT` Lambda hooks. Same concept, different wiring.

For new deployments, ECS native is the simpler path — fewer resources to manage, native lifecycle hooks, and pause hooks for manual approval workflows. CodeDeploy remains relevant for teams with existing pipelines and deployment groups they don't want to migrate.
