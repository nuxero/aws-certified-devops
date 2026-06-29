import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { CodeDeployClient, PutLifecycleEventHookExecutionStatusCommand } from "@aws-sdk/client-codedeploy";

const lambda = new LambdaClient();
const codedeploy = new CodeDeployClient();

export const handler = async (event) => {
  // CodeDeploy passes these identifiers for reporting back
  const deploymentId = event.DeploymentId;
  const lifecycleEventHookExecutionId = event.LifecycleEventHookExecutionId;
  let status = "Failed";

  try {
    // Use environment variables instead of hardcoded names (set in template.yaml)
    const functionName = process.env.TARGET_FUNCTION;
    const result = await lambda.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      Qualifier: process.env.TARGET_ALIAS,
    }));

    const payload = JSON.parse(Buffer.from(result.Payload).toString());
    const body = JSON.parse(payload.body);

    // Validate: check for expected response structure
    if (payload.statusCode === 200 && body.version) {
      console.log("Validation passed:", body);
      status = "Succeeded";
    } else {
      console.error("Validation failed:", payload);
    }
  } catch (err) {
    console.error("Hook invocation error:", err);
  }

  // Report pass/fail to CodeDeploy — determines whether traffic shift proceeds
  await codedeploy.send(new PutLifecycleEventHookExecutionStatusCommand({
    deploymentId,
    lifecycleEventHookExecutionId,
    status,
  }));

  return { statusCode: 200, body: status };
};