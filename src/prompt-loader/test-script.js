import { promises as fs } from 'fs';
import sqlite3 from 'sqlite3';
import { PromptLoader, FilePath, SQLitePath } from './promptLoader.js';

// --- Test Configuration ---

const MOCK_YAML_FILE = 'test-prompts.yaml';
const MOCK_MD_FILE = 'test-prompts.md';
const MOCK_DB_FILE = 'test-prompts.db';

// const MOCK_YAML_CONTENT = `
// greeting:
//   prompt: "Hello from YAML, {name}!"
//   output: "..."
// farewell: "Goodbye from YAML, {name}."
// `;

// const MOCK_TEXT_CONTENT = `
// #greeting
// Hello from Text, {name}!

// #farewell
// Goodbye from Text, {name}.
// `;

// // --- Test Setup Functions ---

// /**
//  * Creates all mock files needed for the tests.
//  */
// async function setupMockFiles() {
//     console.log('--- Setting up mock files... ---');
//     try {
//         await fs.writeFile(MOCK_YAML_FILE, MOCK_YAML_CONTENT);
//         console.log(`✅ Created ${MOCK_YAML_FILE}`);

//         await fs.writeFile(MOCK_TEXT_FILE, MOCK_TEXT_CONTENT);
//         console.log(`✅ Created ${MOCK_TEXT_FILE}`);

//         await setupMockDatabase();
//         console.log('--- Setup complete ---');
//     } catch (error) {
//         console.error('Error during setup:', error);
//         throw error; // Stop execution if setup fails
//     }
// }
// /**
//  * Creates and populates the mock SQLite database.
//  */
// function setupMockDatabase() {
//     return new Promise((resolve, reject) => {
//         // Use verbose mode for more details on error
//         const db = new sqlite3.Database(MOCK_DB_FILE, (err) => {
//             if (err) return reject(err);
//         });

//         db.serialize(() => {
//             db.run(
//                 'CREATE TABLE prompt_store (signature TEXT PRIMARY KEY, prompt TEXT, output TEXT)',
//                 (err) => {
//                     if (err) return reject(err);
//                 }
//             );

//             const stmt = db.prepare('INSERT INTO prompt_store (signature, prompt, output) VALUES (?, ?, ?)');
//             stmt.run('greeting', 'Hello from SQLite, {name}!', '...', (err) => {
//                 if (err) return reject(err);
//             });
//             stmt.run('farewell', 'Goodbye from SQLite, {name}.', '...', (err) => {
//                 if (err) return reject(err);
//             });

//             stmt.finalize((err) => {
//                 if (err) return reject(err);
//                 db.close((err) => {
//                     if (err) return reject(err);
//                     console.log(`✅ Created and populated ${MOCK_DB_FILE}`);
//                     resolve();
//                 });
//             });
//         });
//     });
// }

// /**
//  * Deletes all mock files created during setup.
//  */
// async function cleanupMockFiles() {
//     console.log('\n--- Cleaning up mock files... ---');
//     try {
//         await fs.unlink(MOCK_YAML_FILE);
//         console.log(`✅ Removed ${MOCK_YAML_FILE}`);

//         await fs.unlink(MOCK_TEXT_FILE);
//         console.log(`✅ Removed ${MOCK_TEXT_FILE}`);

//         await fs.unlink(MOCK_DB_FILE);
//         console.log(`✅ Removed ${MOCK_DB_FILE}`);

//         console.log('--- Cleanup complete ---');
//     } catch (error) {
//         console.error('Error during cleanup:', error);
//     }
// }

// --- Main Test Runner ---

async function runTests() {
    console.log('\n--- Running Prompt Loader Tests... ---');
    let allTestsPassed = true;

    // Test 1: Load from YAML (default parser)
    try {
        console.log('\n[Test 1: Loading from YAML]');
        const yamlLoader = await PromptLoader.create(new FilePath(MOCK_YAML_FILE));

        const greetPrompt = yamlLoader.getPrompt('greeting');
        const formattedGreet = greetPrompt.format({ name: 'YAML' });
        console.log(`  Formatted 'greeting': ${formattedGreet}`);

        const farewellPrompt = yamlLoader.getPrompt('farewell');
        const formattedFarewell = farewellPrompt.format({ name: 'YAML' });
        console.log(`  Formatted 'farewell': ${formattedFarewell}`);

        if (formattedGreet.includes('YAML') && formattedFarewell.includes('YAML')) {
            console.log('✅ Test 1 Passed');
        } else {
            throw new Error('YAML test output mismatch');
        }

    } catch (error) {
        console.error('❌ Test 1 Failed:', error.message);
        allTestsPassed = false;
    }

    // Test 2: Load from MD File (customText parser)
    try {
        console.log('\n[Test 2: Loading from MD File]');
        const mdLoader = await PromptLoader.create(
            new FilePath(MOCK_MD_FILE)
        );

        const greetPrompt = mdLoader.getPrompt('greeting');
        const formattedGreet = greetPrompt.format({ name: 'MD' });
        console.log(`  Formatted 'greeting': ${formattedGreet}`);

        const farewellPrompt = mdLoader.getPrompt('farewell');
        const formattedFarewell = farewellPrompt.format({ name: 'MD' });
        console.log(`  Formatted 'farewell': ${formattedFarewell}`);

        if (formattedGreet.includes('MD') && formattedFarewell.includes('MD')) {
            console.log('✅ Test 2 Passed');
        } else {
            throw new Error('MD test output mismatch');
        }

    } catch (error) {
        console.error('❌ Test 2 Failed:', error.message);
        allTestsPassed = false;
    }

    // Test 3: Load from SQLite
    try {
        console.log('\n[Test 3: Loading from SQLite]');
        const dbLoader = await PromptLoader.create(new SQLitePath(MOCK_DB_FILE));

        const greetPrompt = dbLoader.getPrompt('greeting');
        const formattedGreet = greetPrompt.format({ name: 'SQLite' });
        console.log(`  Formatted 'greeting': ${formattedGreet}`);

        const farewellPrompt = dbLoader.getPrompt('farewell');
        const formattedFarewell = farewellPrompt.format({ name: 'SQLite' });
        console.log(`  Formatted 'farewell': ${formattedFarewell}`);

        if (formattedGreet.includes('SQLite') && formattedFarewell.includes('SQLite')) {
            console.log('✅ Test 3 Passed');
        } else {
            throw new Error('SQLite test output mismatch');
        }

    } catch (error) {
        console.error('❌ Test 3 Failed:', error.message);
        allTestsPassed = false;
    }

    console.log('\n--- Test run finished ---');
    return allTestsPassed;
}

// --- Main execution ---

(async () => {
    // await setupMockFiles();
    const success = await runTests();
    // finally {
    //     await cleanupMockFiles();
    // }
})();