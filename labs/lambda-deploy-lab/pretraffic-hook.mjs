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
    console.log("Validating new version:", process.env.NEW_VERSION);

    const result = await lambda.send(new InvokeCommand({
      FunctionName: process.env.TARGET_FUNCTION,
      InvocationType: "RequestResponse",
      Qualifier: process.env.NEW_VERSION,
    }));

    const payload = JSON.parse(Buffer.from(result.Payload).toString());
    const body = JSON.parse(payload.body);

    // Validate — check that the response has the expected structure
    if (payload.statusCode === 200 && body.version) {
      console.log("Validation passed:", body);
      status = "Succeeded";
    } else {
      console.error("Validation failed — unexpected response:", payload);
    }
  } catch (err) {
    // Catches invocation errors (e.g., function doesn't exist, timeout)
    console.error("Validation failed — invocation error:", err);
  }

  // Report result to CodeDeploy — this determines whether traffic shifts proceed
  await codedeploy.send(new PutLifecycleEventHookExecutionStatusCommand({
    deploymentId,
    lifecycleEventHookExecutionId,
    status,
  }));

  return { statusCode: 200, body: status };
};
