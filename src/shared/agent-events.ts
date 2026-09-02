/** Event forwarded from the opencode runtime (SSE /event) to the renderer. */
export interface AgentEvent {
  type: string
  properties: Record<string, unknown>
}
