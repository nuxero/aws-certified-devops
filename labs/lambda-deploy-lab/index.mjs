export const handler = async (event) => {
  // Simulate a latency regression (e.g., an accidental synchronous call in a hot path)
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return {
    statusCode: 200,
    body: JSON.stringify({ version: "3.0", message: "Hello from v3 (slow)" })
  };
};
