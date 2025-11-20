import {
    PromptLoader
} from '../promptLoader.js';
import { LLMService } from '@peebles-group/agentlib-js';
import dotenv from 'dotenv';
dotenv.config({ path: '../../../.env' });

const llm = new LLMService('openai', process.env.OPENAI_API_KEY);

const DB_FILE = './test-prompts.db';
const YAML_FILE = './test-prompts.yaml';
const JSON_FILE = './test-prompts.json';
const TXT_FILE = './test-prompts.txt';
const MD_FILE = './test-prompts.md';

const COMMON_VARIABLES = {
    user_name: 'Arsen',
    current_date: 'Monday'
};

const FILE_EXPECTED = "Hello, Arsen! Welcome to the system.";

const DB_EXPECTED = "Hello, Arsen! Welcome to the system. Today is Monday.";

const TEST_MAP = [
    {
        name: "YAML Test (.yaml)",
        path: YAML_FILE,
        signature: "greeting_simple",
        variables: COMMON_VARIABLES,
        expected: FILE_EXPECTED
    },
    {
        name: "JSON Test (.json)",
        path: JSON_FILE,
        signature: "greeting_simple",
        variables: COMMON_VARIABLES,
        expected: FILE_EXPECTED
    },
    {
        name: "Text Test (.txt)",
        path: TXT_FILE,
        signature: "greeting_simple",
        variables: COMMON_VARIABLES,
        expected: FILE_EXPECTED
    },
    {
        name: "Markdown Test (.md)",
        path: MD_FILE,
        signature: "greeting_simple",
        variables: COMMON_VARIABLES,
        expected: FILE_EXPECTED
    },
    {
        name: "SQLite Test (.db)",
        path: DB_FILE,
        signature: "greeting_simple",
        variables: COMMON_VARIABLES,
        expected: DB_EXPECTED
    },
];

async function runTest(testName, resourcePath, promptSignature, variables, expectedOutput) {
    let loader;
    console.log(`\n--- Running Test: ${testName} ---`);
    console.log(`   Resource Path: ${resourcePath}`);
    try {
        loader = await PromptLoader.create(resourcePath);
        const prompt = loader.getPrompt(promptSignature);

        if (!prompt) {
            console.error(`[FAIL]: Prompt signature "${promptSignature}" not found.`);
            const availableKeys = Array.from(loader.getAllPrompts().keys());
            console.log(`   [WARNING]: Available keys found in file: [${availableKeys.join(', ')}]`);
            return false;
        }

        const formatted = prompt.format(variables)
            .replace(/\s+/g, ' ')
            .trim();

        const cleanExpected = expectedOutput.replace(/\s+/g, ' ').trim();

        if (formatted === cleanExpected) {
            console.log(`[PASS]: Prompt loaded and formatted correctly.`);
            return true;
        } else {
            console.error(`[FAIL]: Output Mismatch.`);
            console.error(`   Expected: "${cleanExpected}"`);
            console.error(`   Received: "${formatted}"`);
            return false;
        }

    } catch (error) {
        console.error(`[FATAL FAIL]: Error during ${testName}: ${error.message}`);
        return false;
    }
}

async function main() {
    console.log("Starting PromptLoader Versatility Test (Custom Delimiter mode)");

    let allPassed = true;

    for (const testCase of TEST_MAP) {
        const passed = await runTest(
            testCase.name,
            testCase.path,
            testCase.signature,
            testCase.variables,
            testCase.expected
        );
        allPassed = allPassed && passed;
    }

    console.log("\n----------------------------------------------------");
    console.log(allPassed ? "[SUCCESS]: ALL TESTS PASSED SUCCESSFULLY!" : "[FAILURE]: ONE OR MORE TESTS FAILED. CHECK LOGS ABOVE.");
    console.log("----------------------------------------------------");

    // --- LLM Service Test ---
    console.log("\n--- Starting LLM Service Test ---");

    const LLM_TEST_SIGNATURE = 'analyzer_complex';
    const LLM_TEST_PATH = YAML_FILE;

    try {
        const loader = await PromptLoader.create(LLM_TEST_PATH);
        const prompt = loader.getPrompt(LLM_TEST_SIGNATURE);

        if (!prompt) {
            console.error(`[LLM TEST FAIL]: Prompt signature '${LLM_TEST_SIGNATURE}' not found in ${LLM_TEST_PATH}. Skipping LLM call.`);
            return;
        }

        const formattedPrompt = prompt.format(COMMON_VARIABLES);

        const input = [{ role: 'user', content: formattedPrompt }];

        console.log(`[INFO]: Sending prompt to LLM: "${formattedPrompt}"`);

        const response = await llm.chat(input, { model: 'gpt-4o-mini' });

        console.log(`\n[LLM RESPONSE]:`);
        console.log(response);

    } catch (error) {
        console.error(`[LLM TEST FAIL]: Failed to execute LLM call.`, error.message);
    }
}

main();