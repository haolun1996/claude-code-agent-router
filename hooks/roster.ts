import type { RosterAgent } from '../types'

export type Definition = Omit<RosterAgent, 'running' | 'finished'>

/** The `key: value` fields of a Markdown file's frontmatter; block values joined into one line. */
export function frontmatter(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}
  const fields: Record<string, string> = {}
  let key: string | undefined
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break
    const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
    if (field !== null) {
      key = field[1]!
      fields[key] = unquote(field[2]!.trim().replace(/^[|>][-+]?$/, ''))
    } else if (key !== undefined && /^\s+\S/.test(line)) {
      const more = line.trim().replace(/^-\s+/, '')
      fields[key] = fields[key] ? `${fields[key]} ${more}` : more
    }
  }
  return fields
}

const unquote = (value: string) => value.replace(/^(["'])(.*)\1$/, '$2')

/** The agent a definition file declares, or undefined when it names none. */
export function definitionOf(text: string, scope: Definition['scope'], fileName: string): Definition | undefined {
  const fields = frontmatter(text)
  const name = fields.name || fileName.replace(/\.md$/, '')
  if (!name) return undefined
  return {
    name,
    scope,
    model: fields.model || 'inherit',
    description: (fields.description ?? '').replace(/\s+/g, ' ').trim(),
    tools: fields.tools || undefined,
  }
}

/** Project definitions win over user ones of the same name. */
export function merge(project: readonly Definition[], user: readonly Definition[]): Definition[] {
  const names = new Set(project.map(one => one.name))
  return [...project, ...user.filter(one => !names.has(one.name))].sort(
    (a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'project' ? -1 : 1),
  )
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…'
}

/** The purpose in a sentence: up to the first period or dash break, clipped. */
export function purposeOf(description: string, max = 200): string {
  const first = /^(.{20,}?)(?:\. |\s—\s|$)/.exec(description)?.[1] ?? description
  return clip(first.replace(/\.$/, ''), max)
}

/** The system-prompt section asking Claude to delegate matching work. */
export function delegationSection(agents: readonly Definition[]): string {
  const lines = agents.map(
    agent => `- \`${agent.name}\` (${agent.model}${agent.scope === 'user' ? ', user-wide' : ''}): ${purposeOf(agent.description, 240)}`,
  )
  return [
    '# Project subagents',
    'The person has set up these subagents for their work. When a task, or a separable part of one, matches an agent below, delegate it with the Agent tool (`subagent_type` set to its name) rather than doing it yourself, and say in one line which agent you chose and why. Run independent delegations in parallel. Do the work yourself only when no agent fits, the task is a quick one-step answer, or the person asks you to.',
    ...lines,
  ].join('\n')
}
