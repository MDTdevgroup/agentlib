#!/usr/bin/env node

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const examples = [
  {
    name: 'Math Tutor',
    file: 'mathTutor.js',
    description: 'Structured step-by-step problem solving with input/output validation'
  },
  {
    name: 'Data Extraction', 
    file: 'dataExtraction.js',
    description: 'Extract structured data from unstructured text with content moderation'
  },
  {
    name: 'UI Generation',
    file: 'uiGeneration.js', 
    description: 'Generate UI components with recursive schemas and HTML rendering'
  }
];

function runExample(exampleFile) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(__dirname, exampleFile)], {
      stdio: 'inherit',
      cwd: __dirname
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Example ${exampleFile} exited with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}

async function runAllExamples() {
  console.log('AgentLib Schema Examples\n');
  console.log('This demonstrates input and output schemas with structured LLM responses.\n');
  
  for (let i = 0; i < examples.length; i++) {
    const example = examples[i];
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Example ${i + 1}/${examples.length}: ${example.name}`);
    console.log(`${example.description}`);
    console.log(`File: ${example.file}`);
    console.log('='.repeat(60));
    
    try {
      await runExample(example.file);
      console.log(`\n${example.name} completed successfully!`);
    } catch (error) {
      console.error(`\n${example.name} failed:`, error.message);
    }
    
    if (i < examples.length - 1) {
      console.log('\nContinuing to next example in 2 seconds...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  console.log('\nAll schema examples completed!');
  console.log('\nLearn more:');
  console.log('- Read the README.md in this directory');
  console.log('- Check out the OpenAI Structured Outputs documentation');
  console.log('- Explore other AgentLib examples in the examples/ directory');
}

async function runSingleExample() {
  const exampleName = process.argv[2];
  
  if (!exampleName) {
    console.log('Available examples:');
    examples.forEach((example, index) => {
      console.log(`  ${index + 1}. ${example.name.toLowerCase().replace(' ', '-')} - ${example.description}`);
    });
    console.log('\nUsage:');
    console.log('  node index.js [example-name]');
    console.log('  node index.js math-tutor');
    console.log('  node index.js data-extraction');
    console.log('  node index.js ui-generation');
    console.log('\nOr run without arguments to run all examples.');
    return;
  }
  
  const example = examples.find(ex => 
    ex.name.toLowerCase().replace(' ', '-') === exampleName.toLowerCase() ||
    ex.file.replace('.js', '') === exampleName.toLowerCase()
  );
  
  if (!example) {
    console.error(`Example '${exampleName}' not found.`);
    console.log('\nAvailable examples:');
    examples.forEach(ex => {
      console.log(`  - ${ex.name.toLowerCase().replace(' ', '-')}`);
    });
    process.exit(1);
  }
  
  console.log(`Running ${example.name} Example\n`);
  console.log(`${example.description}\n`);
  
  try {
    await runExample(example.file);
    console.log(`\n${example.name} completed successfully!`);
  } catch (error) {
    console.error(`\n${example.name} failed:`, error.message);
    process.exit(1);
  }
}

// Main execution
async function main() {
  try {
    if (process.argv.length > 2) {
      await runSingleExample();
    } else {
      await runAllExamples();
    }
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main().catch(console.error);
