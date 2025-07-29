class Graph{
    constructor() {
        this.nodes = new Map();
    }
    
    addNode(node) {
        if (!this.nodes.has(node)) {
        this.nodes.set(node, []);
        }
    }
    
    addEdge(node1, node2) {
        if (this.nodes.has(node1) && this.nodes.has(node2)) {
        
        }
    }
    

}

class Node:
    constructor(value) {
        this.value = value;
        this.edges = [];
    }