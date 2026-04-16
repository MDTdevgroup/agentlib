import { AgentRunner } from '../src/core/agent-runner.js';
import { Agent } from '../src/core/agent.js';
import { LLMService } from '../src/services/llm-service.js';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

const llmService = new LLMService({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });
const agent = new Agent(llmService, { logmode: 'none', name: 'agent' });

async function runTests() {
    let passed = 0;
    let failed = 0;

    function assert(condition, label) {
        if (condition) { passed++; console.log(`  ✅ ${label}`); }
        else { failed++; console.log(`  ❌ ${label}`); }
    }

    console.log('\n=== Test 1: Constructor ===');
    const runner = new AgentRunner(agent);
    assert(runner.agents['agent'] === agent, 'Stores agent by name');

    console.log('\n=== Test 2: Input norm ===');
    const n1 = runner._normalizeInput('hi');
    assert(n1.role === 'user' && n1.content === 'hi', 'String -> obj');

    console.log('\n=== Test 3: Single Agent Run ===');
    const history1 = await runner.run('Say exactly: Hello');
    assert(history1.length === 1, 'History has 1 turn');
    assert(history1[0].isSatisfied === true, 'Turn is satisfied');
    assert(typeof history1[0].response === 'string', 'Agent response extracted');
    assert(history1[0].response.includes('Hello'), 'Agent responded correctly');
    assert(typeof history1[0].resume === 'function', 'Resume continuation present');

    console.log('\n=== Test 4: Branching / Time-Travel ===');
    let branchedCalled = false;
    await history1[0].resume(async (newContinuation) => {
        branchedCalled = true;
        assert(newContinuation.turn === 1, 'Resumes at exactly the same turn layer');
    });
    assert(branchedCalled, 'Branch execution worked');

    console.log('\n=== Test 5: Multi-agent turnStrategy ===');
    const writerAgent = new Agent(llmService, { name: 'writer' });
    const editorAgent = new Agent(llmService, { name: 'editor' });

    const multiRunner = new AgentRunner({ writer: writerAgent, editor: editorAgent }, {
        turnStrategy: async (agents, turn, defaultInput) => {
            let res1 = await agents.writer.run([{ role: 'user', content: 'Say exactly: Draft' }]);
            let res2 = await agents.editor.run([{ role: 'user', content: 'Say exactly: Looks good' }]);
            return {
                isSatisfied: turn >= 2,
                writerRes: res1.output,
                editorRes: res2.output
            };
        }
    });

    const multiHistory = await multiRunner.run();
    assert(multiHistory.length === 2, 'Runs exactly 2 turns based on strategy');
    assert(multiHistory[0].writerRes.includes('Draft'), 'Writer runs properly');
    assert(multiHistory[1].isSatisfied === true, 'Exit condition works');

    console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
    if (failed === 0) console.log('🎉 ALL TESTS PASSED');
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => { console.error('FATAL:', e); process.exit(1); });
