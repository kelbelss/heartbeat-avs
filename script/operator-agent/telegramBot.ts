import 'dotenv/config';
import {
    createPublicClient,    // Client for reading blockchain data (readContract, getBlock)
    createWalletClient,    // Client for sending transactions (writeContract) requires private key
    http,                  // Transport layer for connecting to an Ethereum node via HTTP/HTTPS
    Abi,                   // TypeScript type for Contract Application Binary Interface (ABI)
    Address,               // TypeScript type for Ethereum addresses (string starting with 0x)
    Hex,                   // TypeScript type for Hexadecimal strings (used for private keys)
    GetBlockReturnType,    // Type returned by getBlock function
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { Telegraf, Context } from 'telegraf'; 
import OpenAI from 'openai';

// --- Import Contract ABI ---
// The ABI tells our script how to encode/decode data for contract interaction.
import heartbeatAVSAbiJson from '../operator-agent/heartbeatAVSAbi.json' assert { type: 'json' };

// --- Type Assertion for ABI ---
// We explicitly cast the imported JSON to the `Abi` type expected by Viem for type safety.
const heartbeatAVSAbi = heartbeatAVSAbiJson as Abi;

// -----------------------------------------------------------------------------
// CONFIG LOADING & VALIDATION
// -----------------------------------------------------------------------------
console.log("Loading config from .env file...");

// Read environment variables and provide defaults
const config = {
    rpcUrl: process.env.ANVIL_RPC_URL || 'http://127.0.0.1:8545',
    
    contractAddress: process.env.CONTRACT_ADDRESS as Address | undefined, 
    
    slasherPrivateKey: process.env.SLASHER_PRIVATE_KEY as Hex | undefined, 
   
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    
    openaiApiKey: process.env.OPENAI_API_KEY,

    // Comma-separated list of operator addresses the bot should monitor
    // Parses the string into an array of lowercase addresses.
    operatorsToMonitor: process.env.OPERATORS_TO_MONITOR
        ?.split(',') // Split the string by commas
        .map(addr => addr.trim().toLowerCase() as Address) // Trim whitespace, lowercase, and cast
        || [], // Default to empty array if variable is not set
    // How often (in seconds) the bot should run its check cycle
    monitorIntervalSeconds: parseInt(process.env.MONITOR_INTERVAL_SECONDS || '15', 10), // Default to 15 seconds
};

// --- Essential Config Validation ---
// The bot cannot function without these core pieces of information.
if (!config.contractAddress) throw new Error("❌ FATAL: Missing CONTRACT_ADDRESS in .env");
if (!config.slasherPrivateKey) throw new Error("❌ FATAL: Missing SLASHER_PRIVATE_KEY in .env");
if (!config.telegramBotToken) throw new Error("❌ FATAL: Missing TELEGRAM_BOT_TOKEN in .env");
if (!config.telegramChatId) throw new Error("❌ FATAL: Missing TELEGRAM_CHAT_ID in .env");
if (config.operatorsToMonitor.length === 0) console.warn("⚠️ WARNING: No OPERATORS_TO_MONITOR defined in .env. Bot will run but monitor no operators.");
if (!config.openaiApiKey) console.warn("⚠️ WARNING: OPENAI_API_KEY not set. AI features will be disabled.");

// Log the loaded configuration for verification (excluding sensitive keys).
console.log("✅ Configuration loaded successfully:");
console.log(`   - RPC URL: ${config.rpcUrl}`);
console.log(`   - Contract Address: ${config.contractAddress}`);
console.log(`   - Monitoring Interval: ${config.monitorIntervalSeconds}s`);
console.log(`   - Monitoring ${config.operatorsToMonitor.length} operators: ${config.operatorsToMonitor.join(', ') || 'None'}`);
console.log(`   - Telegram Bot Token: ${config.telegramBotToken ? 'Loaded' : 'MISSING!'}`);
console.log(`   - Telegram Chat ID: ${config.telegramChatId}`);
console.log(`   - OpenAI Key: ${config.openaiApiKey ? 'Loaded' : 'Disabled'}`);

// -----------------------------------------------------------------------------
// CLIENT INITIALISATION (Viem, OpenAI, Telegraf)
// -----------------------------------------------------------------------------
console.log("Initialising clients...");

// --- Initialise Viem Public Client ---
// Used for reading data from the blockchain (no private key needed).
const publicClient = createPublicClient({
    // Define the blockchain network we're connecting to.
    chain: {
        ...anvil, // Use properties from the predefined Anvil chain config
        // Override the default RPC URL with the one from our config.
        rpcUrls: { default: { http: [config.rpcUrl] }, public: { http: [config.rpcUrl] } },
    },
    // Specify the transport protocol (HTTP in this case).
    transport: http(),
});
console.log(`   ✅ Public Client Initialised`);

// --- Initialise Viem Wallet Client ---
// Used for sending transactions (requires a private key).
// Derive the account object from the slasher private key.
const slasherAccount = privateKeyToAccount(config.slasherPrivateKey);
const walletClient = createWalletClient({
    // The account that will sign transactions.
    account: slasherAccount,
    // Must be the same chain as the public client.
    chain: {
        ...anvil,
        rpcUrls: { default: { http: [config.rpcUrl] } },
     },
    // Specify the transport protocol.
    transport: http(),
});
console.log(`   ✅ Slasher Wallet Client Initialised (Address: ${slasherAccount.address})`);

// --- Initialise OpenAI Client ---
const openai = config.openaiApiKey ? new OpenAI({ apiKey: config.openaiApiKey }) : null;
if (openai) {
    console.log("   ✅ OpenAI Client Initialised");
} else {
    console.log("   ⚪ OpenAI Client Disabled (no API key)");
}

// --- Initialise Telegraf Bot ---
// Create a bot instance using the Telegram Bot Token.
console.log("Initialising Telegram Bot...");
const bot = new Telegraf(config.telegramBotToken);
console.log("   ✅ Telegram Bot Instance Created");


// -----------------------------------------------------------------------------
// GLOBAL STATE & CACHE
// -----------------------------------------------------------------------------
// Variables to store contract constants fetched once on startup.
let contractInterval: bigint | null = null; // Required time between pings (seconds)
let contractGracePeriod: bigint | null = null; // Additional buffer time (seconds)

// Cache to store the last known status of each monitored operator.
// This avoids redundant checks and helps manage state transitions (e.g., preventing alert spam).
const operatorStatus: Record<Address, { // Key: Operator Address
    lastPing: bigint;                   // Timestamp of the last ping read from contract
    lastCheckTimestamp: bigint;         // Blockchain timestamp when this status was determined
    status: 'healthy' | 'warning' | 'overdue' | 'never_pinged' | 'error'; // Current calculated status
    lastWarningSent?: number;           // JS Date.now() timestamp when the last warning alert was sent
    lastSeenMessage?: string;           // Optional: Store the last ping message text (could be useful)
}> = {}; // Initialise as an empty object

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------

/**
 * Utility function to format a duration in seconds into a human-readable string.
 * Example: 75 -> "1m 15s ago", 3665 -> "1h 1m ago"
 * @param seconds - The duration in seconds.
 * @returns A formatted string representation of the duration.
 */
function formatTimeAgo(seconds: number): string {
    if (isNaN(seconds) || seconds < 0) return "invalid time";
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
    // Could add days, etc. if needed
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ago`;
}

/**
 * Sends a message to the configured Telegram chat ID.
 * Includes basic error handling for the Telegram API call.
 * @param text - The message content to send. Supports Markdown.
 */
async function sendTelegramMessage(text: string) {
    // Log the attempt for debugging.
    console.log(`   ✉️ Sending Telegram message... (Length: ${text.length})`);
    try {
        // Use the Telegraf instance to send the message via the Telegram API.
        await bot.telegram.sendMessage(
            config.telegramChatId!, // validated at startup
            text,
            { parse_mode: 'Markdown' } // Use Markdown for formatting (bold, italics, code)
        );
        console.log(`   ✅ Telegram message sent successfully.`);
    } catch (error) {
        // Log errors encountered during sending (e.g., invalid chat ID, network issues)
        console.error(`   ❌ Error sending Telegram message:`, error);
        // Potentially add retry logic or specific error handling here if needed.
    }
}

/**
 * Generates a message using the OpenAI API based on a given prompt.
 * Returns a fallback message if AI is disabled or if the API call fails.
 * @param prompt - The detailed prompt for the AI to generate a message from.
 * @returns The AI-generated message string or a fallback/error message.
 */
async function generateAiMessage(prompt: string): Promise<string> {
    // If OpenAI client wasn't initialised (no API key), return a default message.
    if (!openai) return "AI message generation disabled.";

    console.log(`   🤖 Generating AI message for prompt: "${prompt.substring(0, 50)}..."`);
    try {
        // Call the OpenAI Chat Completions API.
        const chat = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo', 
            messages: [
                // Provide context or role-play instructions to the AI.
                { role: 'system', content: 'You are a helpful assistant generating concise Telegram messages for an EVM blockchain monitoring bot. Be informative but brief.' },
                // Provide the specific user request or prompt.
                { role: 'user', content: prompt },
            ],
            temperature: 0.5, // Lower temperature for more deterministic/factual responses
            max_tokens: 70,   // Limit the length of the generated response to control cost/verbosity
        });

        // Extract the message content from the API response.
        const messageContent = chat.choices[0]?.message?.content?.trim();
        if (messageContent) {
             console.log(`   🤖 AI message generated successfully.`);
             return messageContent;
        } else {
             console.warn(`   🤖 AI response was empty.`);
             return "(AI response empty)";
        }
    } catch (error) {
        // Log errors during the AI API call.
        console.error(`   ❌ Error generating AI message:`, error);
        // Re-throw the error so the calling function knows it failed and can add a fallback.
        throw error;
    }
}


// -----------------------------------------------------------------------------
// CORE MONITORING & ACTION FUNCTIONS
// -----------------------------------------------------------------------------

/**
 * Fetches essential constants (interval, gracePeriod) from the smart contract.
 * This is done once at startup to avoid repeated calls. Exits if it fails.
 */
async function fetchContractConstants() {
    console.log("Fetching contract constants (interval, gracePeriod)...");
    try {
        // Use publicClient.readContract to call view functions on the contract.
        contractInterval = await publicClient.readContract({
            address: config.contractAddress!,
            abi: heartbeatAVSAbi,
            functionName: 'interval', 
        }) as bigint; // Cast the result to bigint

        contractGracePeriod = await publicClient.readContract({
            address: config.contractAddress!,
            abi: heartbeatAVSAbi,
            functionName: 'gracePeriod', 
        }) as bigint; // Cast the result to bigint

        console.log(`   ✅ Contract Interval: ${contractInterval} seconds`);
        console.log(`   ✅ Contract Grace Period: ${contractGracePeriod} seconds`);

        // Validate fetched values (optional sanity check)
        if (contractInterval === null || contractGracePeriod === null || contractInterval <= 0n) {
             throw new Error("Fetched contract constants seem invalid.");
        }

    } catch (error) {
        // If we can't get these fundamental parameters, the bot cannot operate correctly.
        console.error("❌ FATAL: Failed to fetch contract constants. Bot cannot continue.", error);
        // Attempt to send a final alert before exiting.
        await sendTelegramMessage("🚨 Bot Error: Failed to fetch crucial contract constants (interval/gracePeriod). Shutting down.");
        process.exit(1); // Exit the process
    }
}

/**
 * Main monitoring loop function, called periodically by setInterval.
 * Fetches the current block and triggers checks for all monitored operators.
 */
async function checkOperators() {
    // Ensure contract constants have been fetched successfully before proceeding.
    if (!contractInterval || !contractGracePeriod) {
        console.warn("Contract constants not yet available. Skipping check cycle.");
        return;
    }
    // If no operators are configured, do nothing.
    if (config.operatorsToMonitor.length === 0) {
        // Avoid noisy logs if no operators are configured.
        // console.log("No operators configured to monitor. Skipping check cycle.");
        return;
    }

    console.log(`\n[${new Date().toISOString()}] === Starting Operator Check Cycle ===`);
    let block: GetBlockReturnType | null = null;
    try {
        // Get the latest block information to use a consistent timestamp for all checks in this cycle.
        // Using 'latest' block tag is usually sufficient.
        block = await publicClient.getBlock({ blockTag: 'latest' });
        const currentTimestamp = block.timestamp; // block.timestamp is already a BigInt
        console.log(`   - Current Block: ${block.number}, Timestamp: ${currentTimestamp}`);

        // Use Promise.all to run the checks for all operators concurrently.
        // This is more efficient than checking them one by one if there are many operators.
        await Promise.all(config.operatorsToMonitor.map(operator =>
            // Pass the operator address and the consistent timestamp to the check function.
            checkSingleOperator(operator, currentTimestamp)
        ));

        console.log(`[${new Date().toISOString()}] === Finished Operator Check Cycle ===`);

    } catch (error) {
        // Catch errors occurring during the block fetching or the Promise.all execution.
        console.error(`[${new Date().toISOString()}] ❌ Error during operator check cycle:`, error);
        // Send an alert indicating a problem with the bot's main loop.
        await sendTelegramMessage(`🚨 Bot Error: Failed during the operator check cycle. Please check bot logs.`);
    }
}

/**
 * Checks the status of a single operator against the contract state and cached status.
 * Determines if the operator is healthy, needs a warning, or is overdue for slashing.
 * Triggers appropriate actions (warning messages, slash transactions).
 * @param operator - The address of the operator to check.
 * @param currentTimestamp - The current blockchain timestamp (from getBlock).
 */
async function checkSingleOperator(operator: Address, currentTimestamp: bigint) {
    // Log prefix for easier reading of logs related to this operator.
    const logPrefix = `   -> Operator ${operator.slice(0, 8)}...:`;
    try {
        // 1. --- Read lastPing timestamp from the contract ---
        // Use readContract to get the value stored in the `lastPing` mapping for this operator.
        const lastPing = await publicClient.readContract({
            address: config.contractAddress!,
            abi: heartbeatAVSAbi,
            functionName: 'lastPing', 
            args: [operator],         // Pass the operator address 
        }) as bigint; // Cast result to bigint

        // 2. --- Initialise or retrieve cached status ---
        // If this is the first time we're checking this operator, initialise their status in the cache.
        if (!operatorStatus[operator]) {
            console.log(`${logPrefix} First time checking this operator. Initialising cache.`);
            operatorStatus[operator] = {
                lastPing: 0n,              // Initialise lastPing to 0
                lastCheckTimestamp: 0n,    // Initialise check timestamp to 0
                status: 'never_pinged',    // Initial status
                lastWarningSent: undefined // No warning sent yet
            };
            // Optionally send an info message for newly detected operators
             await sendTelegramMessage(`ℹ️ New Operator Detected: \`${operator}\`\nMonitoring started. Waiting for first ping.`);
        }

        // Get the previously recorded status for comparison later.
        const previousStatus = operatorStatus[operator].status;
        let currentStatus: typeof previousStatus = 'healthy'; // Assume healthy unless proven otherwise
        let timeSincePing = 0n;

        // 3. --- Determine Current Status ---
        if (lastPing === 0n) {
            // Operator is registered but has never sent a ping transaction.
            currentStatus = 'never_pinged';
            // Keep logging this state until they ping.
             console.log(`${logPrefix} Status: Never Pinged.`);
        } else {
            // Operator has pinged at least once. Calculate time since last ping.
            timeSincePing = currentTimestamp - lastPing; // BigInt subtraction

            // Define the deadlines based on contract constants.
            // Using non-null assertion (!) because fetchContractConstants checks they are not null.
            const warningDeadline = contractInterval!;
            const slashDeadline = contractInterval! + contractGracePeriod!;

            // Compare timeSincePing against deadlines.
            if (timeSincePing > slashDeadline) {
                // Time since last ping exceeds interval + grace period. Operator is slashable.
                currentStatus = 'overdue';
                console.error(`${logPrefix} Status: OVERDUE (Last ping ${timeSincePing}s ago > ${slashDeadline}s limit)`);
            } else if (timeSincePing > warningDeadline) {
                // Time since last ping exceeds interval, but still within grace period. Send a warning.
                currentStatus = 'warning';
                console.warn(`${logPrefix} Status: WARNING (Last ping ${timeSincePing}s ago > ${warningDeadline}s interval, within grace ${slashDeadline}s)`);
            } else {
                // Time since last ping is within the required interval. Operator is healthy.
                currentStatus = 'healthy';
                // Only log healthy status if it's a change from a previous non-healthy state, to reduce noise.
                if (previousStatus !== 'healthy' && previousStatus !== 'never_pinged') {
                     console.log(`${logPrefix} Status: Healthy (Last ping ${timeSincePing}s ago)`);
                } else if (previousStatus === 'never_pinged') {
                    // Log first successful ping
                    console.log(`${logPrefix} Status: Healthy (First ping received ${timeSincePing}s ago)`);
                     await sendTelegramMessage(`✅ First Ping Received: \`${operator}\` (Ping was ${timeSincePing}s ago)`);
                }
            }
        }

        // 4. --- Update Cache ---
        // Always update the cache with the latest information read from the contract and calculated status.
        operatorStatus[operator].lastPing = lastPing;
        operatorStatus[operator].status = currentStatus;
        operatorStatus[operator].lastCheckTimestamp = currentTimestamp; // Record when this check happened

        // 5. --- Trigger Actions Based on Status Changes or Conditions ---
        if (currentStatus !== previousStatus) {
            // The operator's calculated status has changed since the last check cycle.
            console.log(`${logPrefix} Status transition: ${previousStatus} -> ${currentStatus}`);

            // Handle specific transitions:
            if (currentStatus === 'warning') {
                // Status changed to 'warning'. Trigger the warning process.
                await triggerWarning(operator, lastPing, timeSincePing);
            } else if (currentStatus === 'overdue') {
                // Status changed to 'overdue'. Trigger the slash process.
                // umcomment this line to enable slashing
                // await triggerSlash(operator, lastPing, timeSincePing);
            } else if (currentStatus === 'healthy' && (previousStatus === 'warning' || previousStatus === 'overdue')) {
                // Status changed back to 'healthy' from a problematic state. Operator recovered!
                console.log(`${logPrefix} Operator recovered.`);
                await sendTelegramMessage(`✅ Operator Recovered: \`${operator}\`\nPing received ${timeSincePing}s ago.`);
                // Clear the timestamp of the last warning message sent for this operator upon recovery.
                operatorStatus[operator].lastWarningSent = undefined;
            }
            // Note: No specific action needed for 'never_pinged' -> 'healthy' transition here,
            // as the first ping log/message is handled within the status determination block above.

        } else if (currentStatus === 'warning') {
            // Operator status *remained* 'warning'. Check if we need to resend the warning periodically.
            const now = Date.now(); // Current system time (milliseconds)
            const lastWarningTime = operatorStatus[operator].lastWarningSent; // Time last warning was sent (ms)
            // Define how often to resend warnings (e.g., 5 minutes)
            const warningResendInterval = 5 * 1000; // 5 seconds?

            // Resend if no warning has ever been sent OR if the resend interval has passed.
            if (!lastWarningTime || (now - lastWarningTime > warningResendInterval)) {
                 console.log(`${logPrefix} Warning state persists. Resending warning message (Interval: ${warningResendInterval/60000}m).`);
                 // Call triggerWarning again to resend the notification.
                 await triggerWarning(operator, lastPing, timeSincePing);
            }
        }
        // No recurring actions needed if status remains 'healthy', 'overdue' (slash already attempted), or 'never_pinged'.

    } catch (error) {
        // Catch errors specific to checking this single operator (e.g., readContract fails).
        console.error(`${logPrefix} ❌ Error during check:`, error);
        // Update the cache to reflect the error state for this operator.
        operatorStatus[operator] = {
             // Keep existing data if possible, or use defaults
             ...(operatorStatus[operator] || { lastPing: 0n, lastCheckTimestamp: 0n, status: 'error' }),
             lastCheckTimestamp: currentTimestamp, // Mark when the error occurred
             status: 'error' // Set status to 'error'
         };
        // Send an alert about the failure to check this specific operator.
        await sendTelegramMessage(`🚨 Bot Error: Failed to check status for operator \`${operator}\`. Check bot logs.`);
    }
}

/**
 * Handles the process of sending a warning notification to Telegram.
 * Optionally enhances the message with AI. Updates the cache with warning sent time.
 * @param operator - Address of the operator receiving the warning.
 * @param lastPingTime - Timestamp of their last successful ping.
 * @param timeSincePing - Calculated time since their last successful ping.
 */
async function triggerWarning(operator: Address, lastPingTime: bigint, timeSincePing: bigint) {
    const logPrefix = `   WAR -> Operator ${operator.slice(0, 8)}...:`;
    console.warn(`${logPrefix} Triggering WARNING notification.`);

    // 1. --- Record Warning Sent Time ---
    // Update the cache immediately to prevent rapid-fire warnings if checks run quickly.
    // The checkSingleOperator function handles the logic for *when* to resend.
    operatorStatus[operator].lastWarningSent = Date.now();

    // 2. --- Generate Warning Message ---
    // Convert BigInt timeSincePing to Number for formatting (safe for reasonable durations).
    const timeAgo = formatTimeAgo(Number(timeSincePing));
    // Base warning message using Markdown for formatting.
    let message = `⚠️ *Operator Warning* ⚠️\n` +
                  `Operator: \`${operator}\`\n` +
                  `Last Ping: ${timeAgo} (Timestamp: ${lastPingTime})\n` +
                  `Required Interval: ${contractInterval}s\n` +
                  `Status: Currently in grace period (${contractGracePeriod}s).`;

    // 3. --- Optional AI Enhancement ---
    if (openai) { // Check if OpenAI client is initialised
        try {
            // Create a specific prompt for the AI to generate a concise warning.
            const aiPrompt = `Generate a very concise Telegram warning message (max 30 words). Operator ${operator} missed their ${contractInterval} second ping check. Their last ping was ${timeAgo}. They are now in the grace period before potential slashing. Keep it brief and urgent.`;
            // Call the AI generation function.
            const aiMessage = await generateAiMessage(aiPrompt);
            // Append the AI message to the base message.
            message += `\n\n🤖 _${aiMessage}_`; // Using italics for AI message
        } catch (aiError) {
            // If AI generation fails, log the error and add a fallback note.
            console.error(`${logPrefix} Error generating AI warning message:`, aiError);
            message += `\n\n_(AI message generation failed)_`;
        }
    }

    // 4. --- Send Telegram Message ---
    await sendTelegramMessage(message);
}

// /**
//  * Handles the process of initiating a slash action against an overdue operator.
//  * Sends pre-slash alert, executes the slash transaction, and sends post-tx confirmation/error.
//  * @param operator - Address of the operator to be slashed.
//  * @param lastPingTime - Timestamp of their last successful ping.
//  * @param timeSincePing - Calculated time since their last successful ping (exceeds deadline).
//  */
// async function triggerSlash(operator: Address, lastPingTime: bigint, timeSincePing: bigint) {
//     const logPrefix = `   SLASH -> Operator ${operator.slice(0, 8)}...:`;
//     console.error(`${logPrefix} Triggering SLASH action!`);

//     // Calculate the missed deadline for the alert message.
//     const deadline = contractInterval! + contractGracePeriod!;
//     const timeAgo = formatTimeAgo(Number(timeSincePing));

//     // 1. --- Send Pre-Slash Alert ---
//     // Notify Telegram *before* sending the transaction.
//     let preSlashMessage = `🚨 *Initiating Slash!* 🚨\n` +
//                           `Operator: \`${operator}\`\n` +
//                           `Last Ping: ${timeAgo} (Timestamp: ${lastPingTime})\n` +
//                           `Missed Deadline: ${deadline}s (${timeSincePing}s elapsed)\n` +
//                           `*Sending slash transaction now...*`;

//     // Optional AI enhancement for pre-slash alert.
//     if (openai) {
//          try {
//             const aiPrompt = `Generate an urgent and concise Telegram alert (max 35 words). Operator ${operator} is being SLASHED for missing their ping deadline (${deadline}s). Last ping was ${timeAgo}. Slashing transaction is being submitted immediately.`;
//             const aiMessage = await generateAiMessage(aiPrompt);
//             preSlashMessage += `\n\n🤖 _${aiMessage}_`;
//         } catch (aiError) {
//              console.error(`${logPrefix} Error generating AI pre-slash message:`, aiError);
//              preSlashMessage += `\n\n_(AI message generation failed)_`;
//          }
//     }
//     await sendTelegramMessage(preSlashMessage);

//     // 2. --- Execute Slash Transaction ---
//     try {
//         console.log(`${logPrefix} Sending slash transaction via Wallet Client...`);
//         // Use the walletClient (configured with slasher's private key) to call writeContract.
//         const txHash = await walletClient.writeContract({
//             address: config.contractAddress!, // Target contract
//             abi: heartbeatAVSAbi,             // Contract ABI
//             functionName: 'slash',            // Function to call
//             args: [operator],                 // Arguments for the function
//             // Optional: Can add gas estimations/limits here if needed, e.g.,
//             // gas: 100_000n, // Example fixed gas limit
//         });
//         console.log(`${logPrefix} Slash transaction successfully sent. Tx Hash: ${txHash}`);

//         // 3. --- Send Post-Transaction Confirmation Alert ---
//         // Notify Telegram that the transaction was submitted. Include the hash.
//         // TODO: Could potentially add a link to a block explorer using the txHash.
//         await sendTelegramMessage(`✅ Slash Transaction Sent: \`${operator}\`\nTransaction Hash: \`${txHash}\`\n\n_(Blockchain confirmation pending)_`);

//         // Optional: Wait for transaction receipt for definitive confirmation.
//         // This adds delay but confirms the slash was mined successfully (or failed).
//         /*
//         console.log(`${logPrefix} Waiting for transaction receipt...`);
//         try {
//            const receipt = await publicClient.waitForTransactionReceipt({
//                hash: txHash,
//                timeout: 120_000 // Optional timeout (e.g., 2 minutes in ms)
//            });
//            console.log(`${logPrefix} Slash transaction CONFIRMED in block ${receipt.blockNumber}. Status: ${receipt.status}`);
//            if (receipt.status === 'success') {
//                await sendTelegramMessage(`🎉 Slash Confirmed: \`${operator}\`\nStatus: Success\nBlock: ${receipt.blockNumber}\nTx: \`${txHash}\``);
//            } else {
//                await sendTelegramMessage(`⚠️ Slash Reverted: \`${operator}\`\nStatus: Reverted by EVM\nBlock: ${receipt.blockNumber}\nTx: \`${txHash}\``);
//            }
//         } catch (receiptError) {
//            console.error(`${logPrefix} Error or timeout waiting for slash tx receipt:`, receiptError);
//            await sendTelegramMessage(`⚠️ Slash Tx Status Unknown: \`${operator}\`\nTx: \`${txHash}\`\nError confirming: ${receiptError.message?.substring(0, 100)}...`);
//         }
//         */

//     } catch (error: any) {
//         // Catch errors during transaction submission (e.g., network error, revert from contract).
//         console.error(`${logPrefix} ❌ Error sending slash transaction:`, error);
//         // Try to extract a useful error message from the complex Viem error object.
//         let errorMessage = error.shortMessage || error.message || "Unknown error occurred.";
//         // Ensure message isn't overly long for Telegram.
//         errorMessage = errorMessage.substring(0, 200) + (errorMessage.length > 200 ? '...' : '');

//         // Send a failure alert to Telegram.
//         await sendTelegramMessage(`❌ Slash Transaction Failed: \`${operator}\`\nError: ${errorMessage}\n\nCheck bot logs and contract state (e.g., operator might have recovered or been slashed already).`);
//         // NOTE: We don't reset the operator's status in the cache here.
//         // If the slash failed because the operator recovered, the next check cycle will update status to 'healthy'.
//         // If it failed because another slasher was faster, the operator is likely already slashed,
//         // and subsequent attempts might also fail (which is okay).
//     }
// }


// -----------------------------------------------------------------------------
// TELEGRAM COMMAND HANDLERS
// -----------------------------------------------------------------------------

// --- Handler for the /start command ---
bot.command('start', (ctx: Context) => {
    // Add a check to ensure ctx.chat is defined
    if (ctx.chat) {
        // Log when the command is received and from which chat.
        console.log(`Received /start command from chat ID: ${ctx.chat.id}`);
        // Send a welcoming message back to the user who issued the command.
        // ctx.reply implicitly uses the chat context.
        ctx.reply('👋 Hello! Heartbeat AVS Monitor Bot is active.\nUse /status to check current operator liveness.');
    } else {
        // This case is unlikely for /start but good practice to handle
        console.warn("Received /start command without chat context.");
    }
});

// --- Handler for the /status command ---
// We define it as a separate async function for better organization.
async function handleStatusCommand(ctx: Context) {
    // Log the command reception, checking for ctx.chat first
    if (ctx.chat) {
        console.log(`Received /status command from chat ID: ${ctx.chat.id}`);
    } else {
        console.warn("Received /status command without chat context.");
        // If there's no chat context, we cannot reply. Return early.
        return;
    }

   // Ensure contract constants are loaded before proceeding.
   if (!contractInterval || !contractGracePeriod) {
       // Use ctx.reply safely here as Telegraf handles the context for replies.
       return ctx.reply("Bot is still initialising contract details. Please try again shortly.");
   }

   // ---- Missing Bit 1: Fetch Current Block Data ----
   // Fetch the latest block timestamp for the most up-to-date "Time Since Ping" calculation.
   let currentTimestamp = 0n;
   let currentBlockNumber = 0n;
   try {
       // Fetch the latest block information using the public client
       const block = await publicClient.getBlock({ blockTag: 'latest' });
       currentTimestamp = block.timestamp; // Get the timestamp (BigInt)
       currentBlockNumber = block.number;   // Get the block number (BigInt)
   } catch (e) {
        // Handle potential errors during block fetching
        console.error("Failed to get latest block for status command", e);
        // Inform the user if blockchain data fetching fails.
        // Proceeding might show slightly stale data based on the last successful check cycle.
        await ctx.reply("⚠️ Error fetching latest blockchain data. Status report might reflect the last successful check cycle.");
        // Use the last check timestamp from a cached operator if available as a fallback? Risky.
        // For simplicity, we'll proceed, but calculations like "Time Since Ping Now" might be off.
        // Setting currentTimestamp to 0 indicates we couldn't fetch it reliably for calculations below.
        currentTimestamp = 0n;
   }
   // ---- End Missing Bit 1 ----


   // ---- Missing Bit 2: Build Status Message ----
   // --- Build the Status Message ---
   let statusMessage = `*Heartbeat AVS Status Report*\n`;
   // Add context like current block number and timestamp if fetched successfully
   if (currentBlockNumber > 0n) {
       statusMessage += `_(As of Block: ${currentBlockNumber} | ${new Date().toLocaleString()})_\n\n`;
   } else {
        statusMessage += `_(${new Date().toLocaleString()})_\n\n`;
   }
   statusMessage += `*Contract:* \`${config.contractAddress}\`\n`;
   statusMessage += `*Required Interval:* ${contractInterval}s\n`;
   statusMessage += `*Grace Period:* ${contractGracePeriod}s\n`;
   statusMessage += `*Total Monitored Operators:* ${config.operatorsToMonitor.length}\n`;
   if (currentTimestamp > 0n) {
       statusMessage += `*Current Chain Timestamp:* ${currentTimestamp}\n`;
   } else {
       statusMessage += `*Current Chain Timestamp:* _Unavailable_\n`;
   }
   statusMessage += `------------------------------------\n\n`;

   // Check if any operators are being monitored
   if (config.operatorsToMonitor.length === 0) {
       statusMessage += "_No operators are currently configured for monitoring._";
   } else {
       // Iterate through each monitored operator and add their status details.
       for (const operator of config.operatorsToMonitor) {
           // Retrieve the cached status information for the operator.
           const state = operatorStatus[operator]; // Access the cache

           // Add operator address (shortened for readability).
           statusMessage += `*Operator:* \`${operator}\`\n`; // Using full address now for clarity

           if (!state) {
               // Bot hasn't checked this operator yet or an error occurred on first check.
               statusMessage += `  Status: ❓ Unknown (Not checked yet or initial error)\n`;
           } else if (state.status === 'error') {
                // Indicate if the last check for this specific operator resulted in an error
                statusMessage += `  Status: ❓ Error during last check\n`;
                // Add timestamp of the failed check if available
                if (state.lastCheckTimestamp > 0n) {
                   const timeSinceCheck = currentTimestamp > state.lastCheckTimestamp ? currentTimestamp - state.lastCheckTimestamp : 0n;
                   statusMessage += `  Last Check Attempt: ${formatTimeAgo(Number(timeSinceCheck))} (at ${state.lastCheckTimestamp})\n`;
                }
           }
           else {
               // Operator state exists and is not 'error'
               // Determine status icon based on cached status.
               let icon = '❓'; // Default icon
               if (state.status === 'healthy') icon = '✅';
               if (state.status === 'warning') icon = '⚠️';
               if (state.status === 'overdue') icon = '🚨';
               if (state.status === 'never_pinged') icon = 'ℹ️';

               // Add formatted status string (e.g., "✅ HEALTHY", "⚠️ WARNING").
               statusMessage += `  Status: ${icon} ${state.status.replace('_', ' ').toUpperCase()}\n`;

               // Add details about the last ping if available.
               if (state.lastPing > 0n) {
                   // Calculate time since last ping based on *current* block timestamp for accuracy.
                   // Only calculate if currentTimestamp was successfully fetched.
                   let timeSincePingNow = 0n;
                   if (currentTimestamp > 0n && currentTimestamp > state.lastPing) {
                        timeSincePingNow = currentTimestamp - state.lastPing;
                        statusMessage += `  Last Ping: ${formatTimeAgo(Number(timeSincePingNow))} (Timestamp: ${state.lastPing})\n`;
                   } else {
                       // Fallback if current timestamp is unavailable or ping is in the future (clock skew?)
                       statusMessage += `  Last Ping Timestamp: ${state.lastPing}\n`;
                   }

               } else if (state.status === 'never_pinged') {
                   // Explicitly state they haven't pinged yet.
                   statusMessage += `  Last Ping: Never\n`;
               }
                // (No else needed for healthy/warning/overdue with lastPing=0, should be covered by 'error' or 'never_pinged')


               // Add info about when the bot last successfully checked this operator's state.
               if (state.lastCheckTimestamp > 0n && currentTimestamp > 0n) {
                    const timeSinceCheck = currentTimestamp > state.lastCheckTimestamp ? currentTimestamp - state.lastCheckTimestamp : 0n;
                    statusMessage += `  Last Checked: ${formatTimeAgo(Number(timeSinceCheck))} (at ${state.lastCheckTimestamp})\n`;
               } else if (state.lastCheckTimestamp > 0n) {
                   statusMessage += `  Last Checked Timestamp: ${state.lastCheckTimestamp}\n`;
               }


               // Optionally add the last ping message if stored (can be verbose).
               // if (state.lastSeenMessage) statusMessage += `  Last Msg: "${state.lastSeenMessage}"\n`;
           }
            statusMessage += `\n`; // Add spacing between operators
       }
   }
   // Send the complete status message back to the Telegram chat where the command was issued.
    // Use the core bot.telegram.sendMessage method.
    if (ctx.chat) { // Keep the check for safety
        try {
            // Use 'as any' on the options object to bypass the strict type check
            // We are confident the underlying Telegram API supports 'disable_web_page_preview'
            await bot.telegram.sendMessage(ctx.chat.id, statusMessage, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            } as any); // <------ ADD 'as any' HERE
        } catch (sendError) {
            // Handle potential errors during the actual sending process
            console.error("Failed to send status message via Telegram API:", sendError);
            // Optionally, try sending a plain message back to the user if the formatted one failed
            try {
                await ctx.reply("Sorry, there was an error generating the formatted status report.");
            } catch (fallbackError) {
                console.error("Failed to send even the fallback error message:", fallbackError);
            }
        }
    } else {
         console.error("Cannot send status reply because chat context is missing.");
    }
}

// Register the async handler function for the '/status' command.
bot.command('status', handleStatusCommand);


// -----------------------------------------------------------------------------
// MAIN EXECUTION & LIFECYCLE MANAGEMENT
// -----------------------------------------------------------------------------

/**
 * Main asynchronous function to orchestrate the bot's startup sequence.
 */
async function main() {
    console.log("🚀 Starting Heartbeat AVS Monitor Bot...");

    // 1. Fetch essential contract details first. Bot exits if this fails.
    await fetchContractConstants();

    // 2. Send an initial notification to Telegram confirming the bot has started.
    await sendTelegramMessage(`✅ *Heartbeat AVS Monitor Bot Started*\nMonitoring ${config.operatorsToMonitor.length} operators on contract \`${config.contractAddress}\`.\nInterval: ${contractInterval}s, Grace: ${contractGracePeriod}s.`);

    // 3. Start the periodic check loop.
    // Calculate interval in milliseconds.
    const monitorIntervalMs = config.monitorIntervalSeconds * 1000;
    console.log(`🕒 Starting monitoring loop (Interval: ${config.monitorIntervalSeconds}s / ${monitorIntervalMs}ms)`);
    // Use setInterval to repeatedly call checkOperators.
    setInterval(checkOperators, monitorIntervalMs);

    // 4. Optional: Run one check cycle immediately on startup.
    console.log("🚀 Performing initial operator check...");
    await checkOperators();

    // 5. Launch the Telegram bot listener.
    // This starts polling Telegram for new messages and commands.
    console.log("👂 Launching Telegram bot listener...");
    bot.launch(); // This runs asynchronously in the background
    console.log("✅ Bot is now running and listening for commands.");

    // 6. Setup graceful shutdown handlers.
    // These listen for termination signals (like Ctrl+C or system shutdown)
    // to allow the bot to stop cleanly and potentially send a final message.
    process.once('SIGINT', () => {
        console.log("\n🚦 SIGINT received, initiating graceful shutdown...");
        bot.stop('SIGINT'); // Stop the Telegraf polling
        // Attempt to send a final message before exiting.
        sendTelegramMessage("🛑 Heartbeat AVS Monitor Bot shutting down (SIGINT received).").finally(() => {
            console.log("Bot shutdown complete.");
            process.exit(0); // Exit the process cleanly
        });
    });
    process.once('SIGTERM', () => {
        console.log("\n🚦 SIGTERM received, initiating graceful shutdown...");
        bot.stop('SIGTERM'); // Stop the Telegraf polling
        sendTelegramMessage("🛑 Heartbeat AVS Monitor Bot shutting down (SIGTERM received).").finally(() => {
            console.log("Bot shutdown complete.");
            process.exit(0); // Exit the process cleanly
        });
    });
}

// --- Start the Bot ---
// Execute the main function and catch any unhandled top-level errors.
main().catch(async (error) => {
    console.error("❌🆘 CRITICAL UNHANDLED ERROR in main execution:", error);
    // Try to send a critical error message to Telegram before crashing.
    await sendTelegramMessage(`🆘 BOT CRASHED: Unhandled critical error: ${error?.message || 'Unknown error'}. Requires immediate attention!`);
    process.exit(1); // Exit with an error code
});