import { Agent } from '../../src/Agent.js';

export class TranslationSubAgent {
  constructor() {
    this.agent = new Agent({tools: this.getTranslationTools()});
  }

  getTranslationTools() {
    return [];
  }

  async translate(text, targetLanguage, sourceLanguage = null) {
    if (!sourceLanguage) {
      // Auto-detect source language if not provided
      sourceLanguage = await this.detectLanguage(text);
    }

    this.agent.addInput({"role": "user", "content": `Please translate the following text from ${sourceLanguage} to ${targetLanguage}: "${text} ONLY RESPOND WITH THE TRANSLATED TEXT"`});
    
    const result = await this.agent.run();
    return result.output_text;
  }

  async detectLanguage(text) {
    this.agent.addInput({"role": "user", "content": `What language is this text written in: "${text}"`});
    
    const result = await this.agent.run();
    return result.output_text;
  }


  async run() {
    return await this.agent.run();
  }
} 