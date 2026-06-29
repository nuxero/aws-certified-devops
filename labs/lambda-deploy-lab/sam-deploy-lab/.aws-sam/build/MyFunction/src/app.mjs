export const handler = async (event) => {
  return {
    statusCode: 200,
    // Same version field the hook validates against
    body: JSON.stringify({ version: "2.0", message: "Hello from SAM v2" }),
  };
};