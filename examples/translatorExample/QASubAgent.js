import { Agent } from '../../src/Agent.js';

export class QASubAgent {
  constructor() {
    this.agent = new Agent({tools: this.getQATools()});
  }

  getQATools() {
    return [];
  }

  async answerQuestion(question) {
    this.agent.addInput({role: "user", content: `Please answer this question: ${question}`});
    
    const result = await this.agent.run();
    return result.output_text;
  }


  async run() {
    return await this.agent.run();
  }

  addInput(input) {
    this.agent.addInput(input);
  }
} 