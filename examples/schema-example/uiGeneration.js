import { Agent } from '../../src/Agent.js';
import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

// Define UI component schema (recursive)
const UIAttribute = z.object({
  name: z.string().describe("Attribute name (e.g., 'className', 'onClick')"),
  value: z.string().describe("Attribute value")
});

// Recursive UI schema using z.lazy for self-reference
const UIComponent = z.object({
  type: z.enum(['div', 'button', 'header', 'section', 'field', 'form', 'input', 'label']).describe("HTML element type"),
  label: z.string().describe("Display text or label for the component"),
  children: z.array(z.lazy(() => UIComponent)).describe("Nested child components"),
  attributes: z.array(UIAttribute).describe("HTML attributes for the component")
});

// Input schema for UI generation requests
const UIGenerationInput = z.object({
  role: z.string(),
  content: z.string(),
});

async function runUIGenerationExample() {
  console.log('UI Generation with Structured Outputs Example\n');

  const agent = new Agent('openai', process.env.OPENAI_API_KEY, {
    model: 'gpt-4o-mini',
    outputSchema: UIComponent
  });

  const uiRequests = [
    {
      description: "Create a user profile form with name, email, and bio fields",
      style: "modern",
      components: ["form", "input", "button"]
    },
    {
      description: "Build a simple login page with username and password",
      style: "minimal"
    },
    {
      description: "Design a contact form with validation",
      style: "bootstrap",
      components: ["form", "input", "button", "label"]
    }
  ];

  for (const request of uiRequests) {
    console.log(`Request: ${request.description}`);
    console.log(`Style: ${request.style || 'default'}`);
    if (request.components) {
      console.log(`Components: ${request.components.join(', ')}`);
    }
    console.log();

    agent.addInput({
      role: 'system',
      content: 'You are a UI generator AI. Convert user descriptions into structured UI components using modern web development practices. Create semantic, accessible HTML structures.'
    });

    agent.addInput({
      role: 'user',
      content: `Generate UI for: ${request.description}. Style: ${request.style || 'default'}. ${request.components ? `Include these components: ${request.components.join(', ')}` : ''}`
    });

    try {
      const result = await agent.run();
      const { rawResponse, output } = result;
      
      console.log('Generation Results:');
      console.log('Status:', rawResponse.status);
      console.log('Model:', rawResponse.model);
      console.log('Tokens:', rawResponse.usage.total_tokens);
      console.log();

      const responseText = output;
      console.log('Generated UI Structure:');
      console.log(responseText);
      console.log();

      // Parse and render the UI structure
      try {
        const uiStructure = responseText;
        
        console.log('UI Component Analysis:');
        analyzeUIComponent(uiStructure, 0);
        
        console.log('\nHTML Preview:');
        const htmlPreview = renderUIToHTML(uiStructure);
        console.log(htmlPreview);
        
      } catch (parseError) {
        console.log('Could not parse UI structure:', parseError.message);
      }

    } catch (error) {
      console.error('UI Generation Error:', error.message);
    }

    console.log('\n' + '='.repeat(60) + '\n');
    agent.cleanup();
  }
}

// Helper function to analyze UI component structure
function analyzeUIComponent(component, depth = 0) {
  const indent = '  '.repeat(depth);
  console.log(`${indent}${component.type}: "${component.label}"`);
  
  if (component.attributes && component.attributes.length > 0) {
    console.log(`${indent}   Attributes: ${component.attributes.map(attr => `${attr.name}="${attr.value}"`).join(', ')}`);
  }
  
  if (component.children && component.children.length > 0) {
    console.log(`${indent}   Children: ${component.children.length}`);
    component.children.forEach(child => analyzeUIComponent(child, depth + 1));
  }
}

// Helper function to render UI structure to HTML
function renderUIToHTML(component, depth = 0) {
  const indent = '  '.repeat(depth);
  const attributes = component.attributes
    ? component.attributes.map(attr => `${attr.name}="${attr.value}"`).join(' ')
    : '';
  
  const openTag = `<${component.type}${attributes ? ' ' + attributes : ''}>`;
  const closeTag = `</${component.type}>`;
  
  let content = '';
  
  // Add label as text content for certain elements
  if (['button', 'label', 'header'].includes(component.type) && component.label) {
    content = component.label;
  } else if (component.type === 'input' && component.label) {
    // For inputs, the label might be a placeholder
    const hasPlaceholder = component.attributes?.some(attr => attr.name === 'placeholder');
    if (!hasPlaceholder) {
      content = `<!-- ${component.label} -->`;
    }
  }
  
  // Render children
  if (component.children && component.children.length > 0) {
    const childrenHTML = component.children
      .map(child => renderUIToHTML(child, depth + 1))
      .join('\n');
    content = content ? `${content}\n${childrenHTML}` : childrenHTML;
  }
  
  if (content) {
    return `${indent}${openTag}\n${content.split('\n').map(line => line ? '  ' + indent + line : '').join('\n')}\n${indent}${closeTag}`;
  } else {
    return `${indent}${openTag}${closeTag}`;
  }
}

async function demonstrateComplexUI() {
  console.log('Complex UI Generation Example\n');

  const agent = new Agent('openai', process.env.OPENAI_API_KEY, {
    model: 'gpt-4o-mini',
    outputSchema: UIComponent
  });

  const complexRequest = {
    description: "Create a comprehensive dashboard with navigation header, sidebar menu, main content area with data cards, and footer",
    style: "modern",
    components: ["header", "div", "section", "button"]
  };

  console.log(`Complex Request: ${complexRequest.description}`);
  console.log();

  agent.addInput({
    role: 'system',
    content: 'You are an expert UI/UX designer. Create comprehensive, well-structured UI layouts with proper semantic HTML and modern design patterns. Use appropriate container elements and organize content logically.'
  });

  agent.addInput({
    role: 'user',
    content: `Design a ${complexRequest.style} ${complexRequest.description}. Make it professional and user-friendly with proper navigation and content organization.`
  });

  try {
    const result = await agent.run();
    
    console.log('Complex UI Results:');
    console.log('Status:', result.status);
    console.log('Tokens used:', result.usage.total_tokens);
    console.log();

    const responseText = result.output_parsed;
    
    try {
      const uiStructure = responseText;
      
      console.log('Dashboard Structure Analysis:');
      analyzeUIComponent(uiStructure, 0);
      
      console.log('\nComponent Statistics:');
      const stats = getUIStats(uiStructure);
      console.log(`Total components: ${stats.totalComponents}`);
      console.log(`Component types: ${Object.entries(stats.componentTypes).map(([type, count]) => `${type}(${count})`).join(', ')}`);
      console.log(`Max nesting depth: ${stats.maxDepth}`);
      console.log(`Total attributes: ${stats.totalAttributes}`);
      
    } catch (parseError) {
      console.log('Could not parse complex UI structure:', parseError.message);
      console.log('Raw response:', responseText.substring(0, 200) + '...');
    }

  } catch (error) {
    console.error('Complex UI Generation Error:', error.message);
  }
}

// Helper function to get UI statistics
function getUIStats(component, depth = 0, stats = null) {
  if (!stats) {
    stats = {
      totalComponents: 0,
      componentTypes: {},
      maxDepth: 0,
      totalAttributes: 0
    };
  }
  
  stats.totalComponents++;
  stats.componentTypes[component.type] = (stats.componentTypes[component.type] || 0) + 1;
  stats.maxDepth = Math.max(stats.maxDepth, depth);
  stats.totalAttributes += component.attributes ? component.attributes.length : 0;
  
  if (component.children) {
    component.children.forEach(child => getUIStats(child, depth + 1, stats));
  }
  
  return stats;
}

async function main() {
  try {
    await runUIGenerationExample();
    await demonstrateComplexUI();
  } catch (error) {
    console.error('Fatal error:', error);
  }
}

main().catch(console.error);
