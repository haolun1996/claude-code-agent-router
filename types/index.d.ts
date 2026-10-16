/** One agent definition as the roster shows it. */
export type RosterAgent = {
  name: string
  scope: 'project' | 'user'
  model: string
  description: string
  tools?: string
  running: number
  finished: number
}

export type RouteStatus = 'planned' | 'running' | 'done' | 'failed' | 'skipped'

/** One numbered item of the person's prompt and where it went. */
export type RouteItem = {
  n: number
  text: string
  /** The agent it is routed to, or `me` for the main conversation; unset until proposed. */
  agent?: string
  note?: string
  /** The agent Claude proposed, to tell a real change from a re-pick of the same one. */
  proposed?: string
  /** The person picked a different agent than Claude proposed. */
  edited?: boolean
  after: number[]
  status: RouteStatus
  agentId?: string
  startedAt?: number
  endedAt?: number
}

/**
 * proposing: Claude is writing the plan · proposed: waiting for the person's go
 * running: approved and under way · done: every item settled.
 */
export type Routing = {
  phase: 'proposing' | 'proposed' | 'running' | 'done'
  items: RouteItem[]
}

declare module 'claude-code' {
  interface PluginState {
    'agent-router': {
      /** What the last /roster found, drawn by its output row. */
      snapshot: { project: string; isHinting: boolean; agents: RosterAgent[] }
      /** The numbered prompt being routed, drawn in the band above the prompt. */
      routing: Routing | null
      /** Wall clock, ticked while a routed item runs. */
      now: number
      /** The routing panel is open and placed, so the band stays out of its way. */
      paneUp: boolean
      /** The row whose number holds the keyboard: its digit again steps into its picker. */
      focusRow: number | null
    }
  }
}
