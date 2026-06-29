import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { CodeDeployClient, PutLifecycleEventHookExecutionStatusCommand } from "@aws-sdk/client-codedeploy";

const lambda = new LambdaClient();
const codedeploy = new CodeDeployClient();

export const handler = async (event) => {
  // CodeDeploy passes these identifiers — needed to report back the hook result
  const deploymentId = event.DeploymentId;
  const lifecycleEventHookExecutionId = event.LifecycleEventHookExecutionId;

  // Default to Failed — only set Succeeded if validation passes
  let status = "Failed";

  try {
    // Step 1: Invoke the new version through the alias
    // During BeforeAllowTraffic, the alias briefly points to the new version for validation
    const result = await lambda.send(new InvokeCommand({
      FunctionName: "deploy-lab-function",
      InvocationType: "RequestResponse",
      Qualifier: "live",
    }));

    const payload = JSON.parse(Buffer.from(result.Payload).toString());
    const body = JSON.parse(payload.body);

    // Step 2: Validate — check that the response has the expected structure
    if (payload.statusCode === 200 && body.version) {
      console.log("Validation passed:", body);
      status = "Succeeded";
    } else {
      console.error("Validation failed — unexpected response:", payload);
    }
  } catch (err) {
    console.error("Validation failed — invocation error:", err);
  }

  // Step 3: Report result to CodeDeploy — this determines whether traffic shifts proceed
  await codedeploy.send(new PutLifecycleEventHookExecutionStatusCommand({
    deploymentId,
    lifecycleEventHookExecutionId,
    status,
  }));

  return { statusCode: 200, body: status };
};
