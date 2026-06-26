export const handler = async (event) => {
  return {
    statusCode: 200,
    body: JSON.stringify({ version: "2.0", message: "Hello from v2" })
  };
};