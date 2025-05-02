import 'dotenv/config';
import { createWalletClient, http, Abi } from 'viem'; // Import Abi type
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains'; // Use specific chain if needed, or define custom
import heartbeatAVSAbiJson from './heartbeatAVSAbi.json' assert { type: 'json' };
import OpenAI from 'openai';

// --- Config ---
const contractAddress = process.env.CONTRACT_ADDRESS;
const rpcUrl = process.env.ANVIL_RPC_URL || 'http://127.0.0.1:8545'; // Default Anvil RPC
const privateKey = process.env.PRIVATE_KEY;
const openaiApiKey = process.env.OPENAI_API_KEY;
const pingIntervalSeconds = 30;

// --- Basic Validation ---
if (!contractAddress) {
  console.error("Error: CONTRACT_ADDRESS environment variable is not set.");
  process.exit(1);
}
if (!privateKey) {
  console.error("Error: PRIVATE_KEY environment variable is not set.");
  process.exit(1);
}
if (!openaiApiKey) {
    console.warn("Warning: OPENAI_API_KEY environment variable is not set. Using default status message.");
}

// --- Type Assertion for ABI ---
// Explicitly cast the imported JSON to the Abi type expected by Viem
const heartbeatAVSAbi = heartbeatAVSAbiJson as Abi;

// --- Initialize OpenAI ---
// Only initialize if API key is provided
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

// --- Initialize Viem Client ---
const account = privateKeyToAccount(`0x${privateKey}` as `0x${string}`);

const client = createWalletClient({
  account,
  // Using anvil chain definition from viem/chains for clarity
  // If connecting to a different network, import its definition or define a custom chain
  chain: {
    ...anvil, // Spread properties from anvil definition
    rpcUrls: { // Override RPC URL from .env if provided
        default: { http: [rpcUrl] },
        public: { http: [rpcUrl] },
     },
  },
  transport: http(rpcUrl), // Pass RPC URL to transport as well
});

console.log(`Operator Agent started for address: ${account.address}`);
console.log(`Pinging contract ${contractAddress} every ${pingIntervalSeconds} seconds via ${rpcUrl}`);

// --- AI Message Generation ---
async function generateStatusMessage(): Promise<string> {
  // If OpenAI client wasn't initialized, return default message
  if (!openai) {
      return 'All systems operational (default).';
  }

  try {
    const chat = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'You are a polite and concise status reporter for a blockchain operator. Keep messages short (max 20 words), indicating healthy operation.',
        },
        {
          role: 'user',
          content: 'Generate a brief, positive system status update.',
        },
      ],
      temperature: 0.7, // Add some variation
      max_tokens: 30,
    });

    // Use nullish coalescing for a cleaner fallback
    return chat.choices[0]?.message?.content?.trim() || 'All systems nominal (AI fallback).';
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error generating AI status message:`, error);
    // Fallback to a default message if AI fails
    return 'System status check performed (AI error).';
  }
}

// --- Ping Function ---
async function pingHeartbeat() {
  const functionName = 'pingHeartbeat'; // For logging context
  console.log(`[${new Date().toISOString()}] Attempting ${functionName}...`);

  try {
    // 1. Generate Status Message
    const statusMessage = await generateStatusMessage();
    console.log(`[${new Date().toISOString()}] Generated status: "${statusMessage}"`);

    // 2. Send Transaction
    console.log(`[${new Date().toISOString()}] Sending ping transaction...`);
    const txHash = await client.writeContract({
      address: contractAddress as `0x${string}`, 
      abi: heartbeatAVSAbi,
      functionName: 'ping',
      args: [statusMessage],
    });

    console.log(`[${new Date().toISOString()}] [Ping Success] Operator: ${account.address} Message: "${statusMessage}" Tx: ${txHash}`);

  } catch (error) {
    // Log detailed error information
    console.error(`[${new Date().toISOString()}] [${functionName} Failed] Error during ping operation:`, error);
  }
}

// --- Run Periodically ---
const intervalMilliseconds = pingIntervalSeconds * 1000;
console.log(`Starting ping interval (${pingIntervalSeconds} seconds)...`);
setInterval(pingHeartbeat, intervalMilliseconds);

// --- Initial Ping ---
// Call immediately on start, don't wait for the first interval
console.log(`Performing initial ping...`);
pingHeartbeat();