import type {
  KnowledgeGraphEdge,
  KnowledgeGraphNeighborhoodResponse,
  KnowledgeGraphNode,
} from '../../../shared/contracts/brain.ts';

export const KNOWLEDGE_GRAPH_EXPAND_LIMIT = 30;
export const KNOWLEDGE_GRAPH_MAX_VISIBLE_NODES = 180;

export interface KnowledgeGraphData {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

export function knowledgeGraphNodeKey(node: Pick<KnowledgeGraphNode, 'id'>): string {
  return String(node.id);
}

export function mergeKnowledgeGraphData(
  current: KnowledgeGraphData,
  incoming: KnowledgeGraphNeighborhoodResponse,
  maxNodes = KNOWLEDGE_GRAPH_MAX_VISIBLE_NODES,
): KnowledgeGraphData {
  const nodeById = new Map(current.nodes.map(node => [node.id, node]));
  for (const node of incoming.nodes) {
    if (nodeById.has(node.id)) {
      nodeById.set(node.id, { ...nodeById.get(node.id)!, ...node });
      continue;
    }
    if (nodeById.size >= maxNodes) continue;
    nodeById.set(node.id, node);
  }

  const edgeById = new Map(current.edges.map(edge => [edge.id, edge]));
  for (const edge of incoming.edges) {
    if (!nodeById.has(edge.from_page_id) || !nodeById.has(edge.to_page_id)) continue;
    edgeById.set(edge.id, edge);
  }
  return { nodes: [...nodeById.values()], edges: [...edgeById.values()] };
}
